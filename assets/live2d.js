/*!
 * 雾光庭院 · Live2D 看板娘（右下角）
 * ------------------------------------------------------------------
 * 界面仿照原版 live2d-widget（stevenjoezhang/live2d-widget）：
 *   模型上方是文字气泡（waifu-tips），旁边是竖排工具栏（waifu-tool），
 *   退出后屏幕右侧会留一个「看板娘」小标签，点一下就回来。
 *
 * 模型和运行时都走网上的开源资源，仓库里不放模型文件：
 *   - 模型：fghrsh/live2d_api（jsDelivr CDN，锁定到某个 commit）
 *   - 运行时：Cubism 2 core（live2d.min.js）+ PIXI v6 + pixi-live2d-display 的 cubism2 渲染器
 * 电脑端打开页面后会在空闲时自动加载；手机端（≤640px）不加载。
 *
 * 角色 / 服装清单在 assets/live2d-models.json：
 *   default = { c, o }：首次访问的默认角色 / 服装下标
 *   characters[i].outfits[j] = { name, model, textures? }
 * 工具栏还接管了页面原来底部的「主题」「随机背景」两个开关：看板娘显示时底部控件条隐藏，
 * 退出看板娘（或手机端）时底部控件条恢复显示。
 * 首访「要不要播放音乐」也交给看板娘：页面通过 window.__live2dWidget.askMusic() 让她在气泡里
 * 常驻提问，用户选了才收起；看板娘不在时页面退回原来的弹窗。
 * 鼠标停在 👕 上，气泡里会出现「上一件 / 随机 / 下一件 / 输入序号」。
 * 鼠标停在 ⓘ 上可以打开衣柜页 wardrobe.html：两个页面用 BroadcastChannel 互通，
 * 在衣柜里点哪件，主页的看板娘就换上哪件；主页换装后衣柜也会同步高亮。
 * 鼠标停在看板娘身上：气泡里出现音乐控制（没放歌时可以直接开始放，放着时可以上一首 / 暂停 / 下一首）。
 * 用户切换后的角色、服装以及「是否退出」都存在 localStorage，二次访问会还原。
 *
 * 依赖顺序不能换：live2d.min.js → PIXI → cubism2 渲染器（后者要挂到 PIXI 上）。
 * ------------------------------------------------------------------
 */
(function () {
  'use strict';

  var MANIFEST = 'assets/live2d-models.json?v=20260925g';
  var RUNTIME = [
    'https://fastly.jsdelivr.net/gh/stevenjoezhang/live2d-widget@0.9.0/live2d.min.js',
    'https://fastly.jsdelivr.net/npm/pixi.js@6.5.10/dist/browser/pixi.min.js',
    'https://fastly.jsdelivr.net/npm/pixi-live2d-display@0.4.0/dist/cubism2.min.js'
  ];
  var HITOKOTO  = 'https://v1.hitokoto.cn/?c=a&c=b&c=d&encode=json';
  var ABOUT_URL = 'https://github.com/fghrsh/live2d_api';
  var STORE_KEY = 'mistgarden.live2d';
  var MOBILE_W  = 640;
  var FIT_W = 0.94, FIT_H = 0.96;
  var TOOL_W = 56;                         // 右侧留给工具栏的宽度（人物和菜单之间留点空）
  var TIP_OVERLAP = -8;                    // 气泡底边相对头顶的位置：负数 = 留出空隙，不挡头
  var WARDROBE_URL = 'wardrobe.html';      // 衣柜页（展示全部角色 / 服装，可以直接给主页的看板娘换上）
  var CHANNEL = 'mistgarden-live2d';       // 主页 ↔ 衣柜页 的 BroadcastChannel 名

  var wrap    = document.getElementById('live2dWrap');
  var canvas  = document.getElementById('live2dCanvas');
  var tipsEl  = document.getElementById('waifuTips');
  var toolEl  = document.getElementById('waifuTool');
  var toggle  = document.getElementById('waifuToggle');
  if (!wrap || !canvas || !tipsEl || !toolEl || !toggle) return;

  var app = null, model = null, baseW = 0, baseH = 0;
  var base = '', chars = [], ci = -1, oi = -1;
  var runtimePromise = null, loadSeq = 0, busy = false, on = false;
  var state = {};
  try { state = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (e) { state = {}; }
  if (typeof state.c === 'number') { ci = state.c; oi = state.o | 0; }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
  }
  function pick(a) { return Array.isArray(a) ? a[Math.floor(Math.random() * a.length)] : a; }
  function cur() { return chars[ci] || { name: '', outfits: [] }; }
  function isMobile() { return window.innerWidth <= MOBILE_W; }

  /* ======================= 文字气泡 ======================= */
  // 气泡里可以带选项按钮（choices = [{ label, primary?, onSelect }]）。
  // pinned 是「常驻」消息（比如首访问要不要放音乐）：没选之前一直显示，
  // 期间只有操作反馈（priority ≥ 10）能临时盖住它，结束后又回到常驻消息。
  var tipTimer = 0, tipPriority = -1, pinned = null, hoverKeep = false, tipExpired = false;
  var tipsText = document.createElement('div');
  var tipsChoices = document.createElement('div');
  tipsText.className = 'waifu-tips-text';
  tipsChoices.className = 'waifu-choices';
  tipsEl.textContent = '';
  tipsEl.appendChild(tipsText);
  tipsEl.appendChild(tipsChoices);

  function renderTip(text, choices) {
    tipsText.textContent = text;
    tipsChoices.textContent = '';
    (choices || []).forEach(function (c) {
      if (c.type === 'number') { tipsChoices.appendChild(numberChoice(c)); return; }
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'waifu-choice' + (c.primary ? ' is-primary' : '');
      b.textContent = c.label;
      if (c.title) b.title = c.title;
      b.addEventListener('click', function (e) { e.stopPropagation(); c.onSelect(); });
      tipsChoices.appendChild(b);
    });
    tipsEl.classList.toggle('has-choices', !!(choices && choices.length));
    tipsEl.classList.add('waifu-tips-active');
  }

  // 「输入序号直接换」：数字框 + 确定按钮，回车也能提交
  function numberChoice(c) {
    var form = document.createElement('form');
    form.className = 'waifu-number';
    form.noValidate = true;                         // 超范围由看板娘自己提示，不用浏览器自带的气泡
    var input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.max = String(c.max);
    input.placeholder = '1-' + c.max;
    input.setAttribute('aria-label', '输入服装序号（1-' + c.max + '）');
    input.inputMode = 'numeric';
    var ok = document.createElement('button');
    ok.type = 'submit';
    ok.className = 'waifu-choice';
    ok.textContent = c.label || '穿这件';
    form.appendChild(input);
    form.appendChild(ok);
    form.addEventListener('click', function (e) { e.stopPropagation(); });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var n = parseInt(input.value, 10);
      if (!(n >= 1 && n <= c.max)) {
        input.value = '';
        showMessage('只有 1 到 ' + c.max + ' 号哦，再输一次吧～', 4000, 13, c.retry && c.retry());
        return;
      }
      c.onSelect(n);
    });
    // 在输入框里时气泡不要自己收起
    input.addEventListener('focus', function () { hoverKeep = true; });
    input.addEventListener('blur', function () {
      hoverKeep = false;
      if (!input.isConnected) return;               // 气泡换内容把输入框移除了：不影响新消息
      if (tipExpired) { tipExpired = false; clearTimeout(tipTimer); tipTimer = setTimeout(endMessage, 2500); }
    });
    return form;
  }

  function endMessage() {
    clearTimeout(tipTimer);
    clearTimeout(menuTimer);
    menuOpen = false;
    musicMenuOpen = false;
    lastHover = null;
    tipPriority = -1;
    if (pinned && on) renderTip(pinned.text, pinned.choices);
    else tipsEl.classList.remove('waifu-tips-active', 'has-choices');
  }

  // priority 越大越重要；正在显示高优先级消息时，低优先级的会被忽略（和原版一致）
  function showMessage(text, timeout, priority, choices) {
    priority = priority || 0;
    text = pick(text);
    if (!text || !on || priority < tipPriority) return;
    if (pinned && priority < 10) return;            // 常驻问题期间不闲聊
    clearTimeout(tipTimer);
    clearTimeout(menuTimer);
    menuOpen = !!(choices && choices.length);       // 带选项的菜单：鼠标离开就尽快收起
    musicMenuOpen = false;                          // showMusicMenu() 调完会再置回 true
    tipPriority = priority;
    renderTip(text, choices);
    tipExpired = false;
    tipTimer = setTimeout(function () {
      if (hoverKeep) { tipExpired = true; return; }  // 鼠标还停在气泡上，先别收，等移开再说
      endMessage();
    }, timeout || 4000);
  }

  function pin(text, choices) {
    pinned = { text: text, choices: choices };
    if (on) { clearTimeout(tipTimer); tipPriority = -1; renderTip(text, choices); }
  }
  function unpin() { pinned = null; endMessage(); }

  // 鼠标停在带选项的气泡上时不自动收起，移开后稍等再收
  // 带选项的菜单（换装 / 关于）：鼠标离开按钮和气泡后很快收起，不挡后面其它图标的提示；
  // 从按钮移到气泡上点选项的路上不会收（有一小段宽限）
  var menuOpen = false, menuTimer = 0, MENU_GRACE = 600;
  function menuLeave() {
    if (!menuOpen) return;
    clearTimeout(menuTimer);
    menuTimer = setTimeout(function () {
      if (menuOpen && !hoverKeep) endMessage();
    }, MENU_GRACE);
  }
  function menuStay() { clearTimeout(menuTimer); }
  tipsEl.addEventListener('mouseenter', function () { hoverKeep = true; menuStay(); });
  // 只有消息本该结束了才在移开后收起；气泡内容变化导致的「移出」不会提前关掉新消息
  tipsEl.addEventListener('mouseleave', function () {
    hoverKeep = false;
    var focused = document.activeElement;
    if (menuOpen && !(focused && tipsEl.contains(focused) && focused.tagName === 'INPUT')) menuLeave();
    if (tipExpired && tipPriority >= 0) { tipExpired = false; clearTimeout(tipTimer); tipTimer = setTimeout(endMessage, 1500); }
  });

  function welcomeMessage() {
    var h = new Date().getHours();
    if (h > 5 && h <= 7)   return '早上好！一日之计在于晨，美好的一天就要开始了。';
    if (h > 7 && h <= 11)  return '上午好！工作顺利嘛，不要久坐，多起来走动走动哦！';
    if (h > 11 && h <= 13) return '中午了，工作了一个上午，现在是午餐时间！';
    if (h > 13 && h <= 17) return '午后很容易犯困呢，今天的运动目标完成了吗？';
    if (h > 17 && h <= 19) return '傍晚了！窗外夕阳的景色很美丽呢，最美不过夕阳红～';
    if (h > 19 && h <= 21) return '晚上好，今天过得怎么样？';
    if (h > 21 && h <= 23) return ['已经这么晚了呀，早点休息吧，晚安～', '深夜时要爱护眼睛呀！'];
    return '你是夜猫子呀？这么晚还不睡觉，明天起的来嘛？';
  }

  function hitokoto() {
    fetch(HITOKOTO)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        showMessage(d.hitokoto, 6000, 9);
        if (d.from) setTimeout(function () {
          showMessage('这句一言出自「' + d.from + '」' + (d.from_who ? '，作者是 ' + d.from_who : '') + '。', 4000, 9);
        }, 6000);
      })
      .catch(function () { showMessage('一言加载失败了，待会儿再试试吧～', 4000, 9); });
  }

  // 鼠标经过 / 点击页面元素时的台词（选择器按先后匹配，第一条命中即用）
  var HOVER = [
    ['#waifuTool [data-act="hitokoto"]', ['猜猜我要说些什么？', '我从青蛙王子那里听到了不少人生经验。']],
    ['#waifuTool [data-act="character"]', ['你是不是不爱人家了呀，呜呜呜～', '要见见我的姐姐嘛？', '想要看我妹妹嘛？', '要切换看板娘吗？']],
    ['#waifuTool [data-act="photo"]', ['你要给我拍照呀？一二三～茄子～', '要不，我们来合影吧！', '保持微笑就好了～']],
    ['#waifuTool [data-act="theme"]', ['要换个主题吗？', '深色浅色，你更喜欢哪个呢？', '天黑了就开深色模式吧～']],
    ['#waifuTool [data-act="background"]', ['不喜欢现在的背景吗？', '背景可以随机切换哦～', '要不要换换风景？']],
    ['#waifuTool [data-act="quit"]', ['到了要说再见的时候了吗？', '呜呜 QAQ 后会有期……', '不要抛弃我呀……', '我们，还能再见面吗……', '哼，你会后悔的！']],
    ['.link-card', function (el) {
      var n = el.querySelector('.card-name');
      return ['要去看看 <' + (n ? n.textContent.trim() : '这里') + '> 吗？', '这个站点我也常去呢～'];
    }],
    ['.contact-card', ['要来群里一起玩吗？', '加入我们吧，这里有很多有趣的人哦！']],
    ['#hitokoto', ['点一下就能换一句一言哦～', '这句话你喜欢吗？']],
    ['#themeBtn', ['要换个主题吗？', '深色浅色，你更喜欢哪个呢？']],
    ['.toggle-wrap', ['不喜欢现在的背景吗？', '背景可以随机切换哦～']],
    ['#musicToggle', ['要听点音乐吗？', '来首歌放松一下吧～']],
    ['.tab-btn', ['导航和社群都可以看看哦～']],
    ['.avatar', ['这是我家主人的头像哦(*´∇｀*)', '好看吗？']]
  ];
  var CLICK = [
    ['#hitokoto', ['又换了一句呢～']],
    ['#themeBtn', ['换好啦，看起来怎么样？']],
    ['.link-card', ['路上小心，记得回来哦～', '要早点回来呀！']]
  ];
  function matchText(list, target) {
    for (var i = 0; i < list.length; i++) {
      var el = target.closest && target.closest(list[i][0]);
      if (el) return typeof list[i][1] === 'function' ? list[i][1](el) : list[i][1];
    }
    return null;
  }
  var lastHover = null;
  document.addEventListener('mouseover', function (e) {
    // 菜单开着时移到别的工具图标上：直接换成那个图标的提示
    var tool = e.target.closest && e.target.closest('#waifuTool button[data-act]');
    if (tool && menuOpen && tool.dataset.act !== 'outfit' && tool.dataset.act !== 'info') endMessage();
    var t = matchText(HOVER, e.target);
    if (!t) { lastHover = null; return; }
    if (lastHover === t) return;
    lastHover = t;
    // 工具图标的提示、换装 / 关于菜单、摸看板娘出来的音乐菜单同为最高优先级 13：
    // 后来的总能顶掉先来的，互相不会挡（以前菜单是 12，路过别的图标出现的 13 提示会把菜单挡掉）
    if (tool) showMessage(t, 3000, 13);
    else showMessage(t, 4000, 8);
  });
  document.addEventListener('click', function (e) {
    var t = matchText(CLICK, e.target);
    if (t) showMessage(t, 4000, 8);
  });
  document.addEventListener('copy', function () {
    showMessage('你都复制了些什么呀，转载要记得加上出处哦！', 6000, 9);
  });
  document.addEventListener('visibilitychange', function () {
    if (app && on) { if (document.hidden) app.stop(); else app.start(); }
    if (!document.hidden) showMessage('哇，你终于回来了～', 6000, 9);
  });

  // 闲置一段时间自己找话说
  var idleTimer = 0, idleLoop = 0;
  function resetIdle() {
    clearTimeout(idleTimer); clearInterval(idleLoop);
    idleTimer = setTimeout(function () {
      idleLoop = setInterval(function () {
        if (Math.random() < 0.5) hitokoto();
        else showMessage(['好久没动静了，你还在吗？', '嗨～快来逗我玩吧！', '拿小拳拳锤你胸口！',
          '记得把小家加入收藏夹哦！', '要不要休息一下，喝杯水？'], 6000, 7);
      }, 25000);
    }, 20000);
  }
  ['mousemove', 'keydown', 'scroll', 'touchstart'].forEach(function (ev) {
    window.addEventListener(ev, resetIdle, { passive: true });
  });

  /* ======================= 运行时 / 清单 ======================= */
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.crossOrigin = 'anonymous';
      s.onload = resolve;
      s.onerror = function () { reject(new Error('脚本加载失败：' + src)); };
      document.head.appendChild(s);
    });
  }

  function ensureRuntime() {
    if (!runtimePromise) {
      runtimePromise = RUNTIME.reduce(function (p, src) {
        return p.then(function () { return loadScript(src); });
      }, Promise.resolve()).then(function () {
        if (!window.PIXI || !PIXI.live2d || !PIXI.live2d.Live2DModel) throw new Error('Live2D 运行时没有就绪');
        PIXI.live2d.Live2DModel.registerTicker(PIXI.Ticker);
      });
      runtimePromise.catch(function () { runtimePromise = null; });
    }
    return runtimePromise;
  }

  function ensureManifest() {
    if (chars.length) return Promise.resolve();
    return fetch(MANIFEST)
      .then(function (r) {
        if (!r.ok) throw new Error('live2d-models.json HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        base = data.base;
        chars = (data.characters || []).filter(function (c) { return c.outfits && c.outfits.length; });
        if (!chars.length) throw new Error('清单里没有模型');
        var def = data['default'] || { c: 0, o: 0 };
        if (ci < 0 || ci >= chars.length) { ci = def.c; oi = def.o; }  // 首次访问用默认模型
        if (!chars[ci]) ci = 0;
        if (oi < 0 || oi >= cur().outfits.length) oi = 0;
      });
  }

  function ensureApp() {
    if (app) return app;
    app = new PIXI.Application({
      view: canvas,
      width: wrap.clientWidth || 300,
      height: wrap.clientHeight || 400,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2)
    });
    return app;
  }

  /* ======================= 模型 ======================= */
  // index.json 里的 layout 各模型差别很大（比如海王星系列 width=3，按它缩放人物会又小又偏），
  // 所以先按模型声明的尺寸粗略放置，再由 layoutOverlay() 扫描实际画出来的像素做校正：
  //   第 1 轮：按人物真实外框重新算缩放；第 2 轮：把人物贴到右下角；之后只负责摆气泡。
  function fit() {
    if (!app || !model) return;
    var w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    app.renderer.resize(w, h);
    var k = model.__k || 1;
    model.scale.set(Math.min(w * FIT_W / baseW, h * FIT_H / baseH) * k);
    model.anchor.set(1, 1);
    model.position.set(w - TOOL_W + (model.__dx || 0), h + (model.__dy || 0));
    scheduleLayout();
  }

  var layoutTimer = 0;
  function scheduleLayout(delay) {
    clearTimeout(layoutTimer);
    layoutTimer = setTimeout(layoutOverlay, delay == null ? 250 : delay);  // 等一两帧，让动作 / 物理先稳定
  }

  // 把模型单独渲染到一张离屏纹理上（范围比模型包围盒更大，不受画布裁切），
  // 扫描不透明像素，返回人物真实外框（画布 CSS 像素坐标，可能超出画布）
  function measure(w, h) {
    var r = app.renderer;
    var b0 = model.getBounds();
    if (!b0.width || !b0.height) return null;
    // 有的模型（如海王星系列）画出来的身体会超出自己声明的包围盒，所以四周各扩一倍再量
    var bb = { x: b0.x - b0.width, y: b0.y - b0.height, width: b0.width * 3, height: b0.height * 3 };
    var q = Math.min(1, 720 / Math.max(bb.width, bb.height));   // 离屏纹理最长边限制在 720px，够用且快
    var tw = Math.max(1, Math.ceil(bb.width * q)), th = Math.max(1, Math.ceil(bb.height * q));
    var rt = PIXI.RenderTexture.create({ width: tw, height: th, resolution: 1 });
    var alpha = model.alpha;
    model.alpha = 1;                                  // 校正期间模型是隐藏的，量的时候临时显示
    try {
      r.render(model, { renderTexture: rt, clear: true, transform: new PIXI.Matrix(q, 0, 0, q, -bb.x * q, -bb.y * q) });
      var px = r.extract.pixels(rt);
      var top = -1, bottom = -1, left = tw, right = -1;
      for (var y = 0; y < th; y++) {
        for (var x = 0; x < tw; x++) {
          if (px[(y * tw + x) * 4 + 3] > 40) {
            if (top < 0) top = y;
            bottom = y;
            if (x < left) left = x;
            if (x > right) right = x;
          }
        }
      }
      if (top < 0) return null;
      return { top: bb.y + top / q, bottom: bb.y + (bottom + 1) / q, left: bb.x + left / q, right: bb.x + (right + 1) / q };
    } catch (e) {
      console.warn('[live2d] 测量模型失败：', e);
      return null;
    } finally {
      model.alpha = alpha;
      rt.destroy(true);
    }
  }

  function layoutOverlay() {
    if (!app || !model || !on) return;
    var w = canvas.clientWidth, h = canvas.clientHeight;
    var box = measure(w, h);
    var availW = w - TOOL_W;
    var pass = model.__pass || 0;
    if (box && pass < 2) {
      model.__pass = pass + 1;
      if (pass === 0) {
        // 按真实外框缩放：宽不超过可用宽度，高不超过容器高度
        // 宽度只占 86%：翅膀、头发会随动作摆动，比校正那一刻量到的更宽，两边要留余量
        var f = Math.min(availW * 0.86 / Math.max(1, box.right - box.left),
                         h * 0.97 / Math.max(1, box.bottom - box.top));
        model.__k = Math.max(0.3, Math.min(4, f));
      } else {
        // 水平居中（左右都给摆动留空间），脚底（或截断处）对齐容器底边
        model.__dx = (model.__dx || 0) + (availW / 2 - (box.left + box.right) / 2);   // 在可用宽度里居中
        model.__dy = (model.__dy || 0) + (h - box.bottom);
      }
      fit();
      scheduleLayout(60);
      return;
    }
    model.alpha = 1;                                  // 校正完成再显示，避免看到人物跳动
    if (!box) return;
    modelBox = box;                                   // 记下人物外框，鼠标悬停检测用
    // 气泡：底边压在头顶上，水平居中对齐头部，不超出容器
    tipsEl.style.top = 'auto';
    tipsEl.style.bottom = Math.max(0, h - box.top - TIP_OVERLAP) + 'px';
    var tw = tipsEl.offsetWidth || 250;
    var cx = (box.left + box.right) / 2;
    tipsEl.style.right = 'auto';
    tipsEl.style.left = Math.max(0, Math.min(w - tw, cx - tw / 2)) + 'px';
  }

  // 读 index.json，按服装替换贴图，再交给 pixi-live2d-display
  function loadModel() {
    var outfit = cur().outfits[oi];
    if (!outfit) return Promise.reject(new Error('没有这个模型'));
    var seq = ++loadSeq;
    var url = base + outfit.model + '/index.json';
    return fetch(url)
      .then(function (r) {
        if (!r.ok) throw new Error('index.json HTTP ' + r.status);
        return r.json();
      })
      .then(function (json) {
        json.url = url;                                   // 相对路径以它为基准
        if (outfit.textures) json.textures = outfit.textures.slice();
        return PIXI.live2d.Live2DModel.from(json, { autoInteract: false });
      })
      .then(function (m) {
        if (seq !== loadSeq) { m.destroy(); return; }
        if (model) { app.stage.removeChild(model); model.destroy(); }
        model = m;
        m.scale.set(1);
        baseW = m.internalModel.width || m.width || 1;
        baseH = m.internalModel.height || m.height || 1;
        m.alpha = 0;                                      // 校正缩放 / 位置前先不显示
        app.stage.addChild(m);
        fit();
        state.c = ci; state.o = oi;                       // 记住用户的选择
        save();
        broadcast();
      });
  }

  /* ======================= 显隐 / 工具栏 ======================= */
  // 主题 / 随机背景：沿用页面原有的 #themeBtn、#bgToggle 逻辑，工具栏只是代点
  var themeBtn = document.getElementById('themeBtn');
  var bgToggle = document.getElementById('bgToggle');
  function syncPageControls() {
    var bt = toolEl.querySelector('[data-act="theme"]');
    var bb = toolEl.querySelector('[data-act="background"]');
    if (bt) {
      var light = document.documentElement.getAttribute('data-theme') === 'light';
      bt.hidden = !themeBtn;
      bt.title = light ? '切换为深色主题' : '切换为浅色主题';
      bt.setAttribute('aria-pressed', String(light));
    }
    if (bb) {
      bb.hidden = !bgToggle;
      var auto = !!(bgToggle && bgToggle.checked);
      bb.title = auto ? '随机背景：开（点击关闭）' : '随机背景：关（点击开启）';
      bb.setAttribute('aria-pressed', String(auto));
    }
  }

  function syncUI() {
    syncPageControls();
    document.body.classList.toggle('waifu-on', on);
    var n = cur().outfits.length;
    var bc = toolEl.querySelector('[data-act="character"]');
    var bo = toolEl.querySelector('[data-act="outfit"]');
    if (bc) bc.title = chars.length > 1 ? '切换角色（下一个：' + chars[(ci + 1) % chars.length].name + '）' : '切换角色';
    if (bo) {
      bo.hidden = n < 2;
      bo.title = '换装（' + (oi + 1) + '/' + n + '）';
    }
    toolEl.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-label', b.title); });
    toggle.classList.toggle('waifu-toggle-active', !on && !isMobile());
  }

  function run(action, doneMsg, doneChoices) {
    busy = true;
    return action()
      .then(function () {
        syncUI();
        if (doneMsg) showMessage(doneMsg(), doneChoices ? 3000 : 4000, doneChoices ? 12 : 10, doneChoices && doneChoices());
      })
      .catch(function (err) {
        console.warn('[live2d] 加载失败：', err);
        showMessage('呜…模型加载失败了，待会儿再试试吧', 4000, 10);
        syncUI();
      })
      .then(function () { busy = false; });
  }

  function show(fromUser) {
    if (busy || isMobile()) return;
    on = true;
    wrap.hidden = false;                          // 先显示，否则容器尺寸是 0
    if (fromUser) { state.hidden = false; save(); }
    syncUI();
    if (model && app) { app.start(); fit(); showMessage(welcomeMessage(), 5000, 11); return; }
    run(function () {
      return ensureRuntime().then(ensureManifest).then(ensureApp).then(function () {
        app.start();
        return loadModel();
      });
    }, welcomeMessage).then(function () { markReady(!!model && on); });
  }

  function hide(fromUser) {
    on = false;
    wrap.hidden = true;
    clearTimeout(tipTimer);
    tipsEl.classList.remove('waifu-tips-active', 'has-choices');
    tipPriority = -1;
    // 音乐还没选看板娘就走了：交还给页面原来的弹窗
    if (musicAsk) { var h = musicAsk; musicAsk = null; pinned = null; h.fallback(); }
    if (app) app.stop();                          // 藏起来就别再渲染了，省电
    if (fromUser) { state.hidden = true; save(); }
    syncUI();
    broadcast();
  }

  /* ---- 换装菜单：鼠标停在 👕 上时，气泡里给出「上一件 / 随机 / 下一件」 ---- */
  function outfitChoices() {
    return [
      { label: '‹ 上一件', onSelect: function () { changeOutfit(-1); } },
      { label: '随机', primary: true, onSelect: function () { changeOutfit(0); } },
      { label: '下一件 ›', onSelect: function () { changeOutfit(1); } },
      { type: 'number', max: cur().outfits.length, label: '穿这件', retry: outfitChoices,
        onSelect: function (n) { changeOutfit(null, n - 1); } }
    ];
  }
  function outfitLabel() {
    var n = cur().outfits.length;
    return '「' + cur().outfits[oi].name + '」' + (oi + 1) + '/' + n;
  }
  function showOutfitMenu() {
    if (busy || cur().outfits.length < 2) return;
    showMessage([
      '喜欢换装 PLAY 吗？现在穿的是' + outfitLabel(),
      '这次要扮演什么呢？现在是' + outfitLabel(),
      '变装！要换哪一件？当前' + outfitLabel()
    ], 2500, 13, outfitChoices());
  }
  // step: 1 下一件，-1 上一件，0 随机（不会随到当前这件）；step 为 null 时直接换到 target 号
  function changeOutfit(step, target) {
    var n = cur().outfits.length;
    if (busy || n < 2) return;
    if (step === null) {
      if (target === oi) { showMessage('现在穿的就是' + outfitLabel() + '呀～', 4000, 12, outfitChoices()); return; }
      oi = target;
    } else if (step === 0) oi = (oi + 1 + Math.floor(Math.random() * (n - 1))) % n;
    else oi = (oi + step + n) % n;
    showMessage('换装中…', 8000, 12);
    run(loadModel, function () {
      return ['我的新衣服好看嘛？' + outfitLabel(), '这套' + outfitLabel() + '怎么样？'];
    }, outfitChoices);
  }
  /* ---- 鼠标停在看板娘身上：和音乐播放器互动 ---- */
  // 模型区域是 pointer-events:none（不挡后面的页面），所以用 mousemove 对照人物外框做命中检测
  var modelBox = null, overModel = false, dwellTimer = 0, moveRaf = 0, lastXY = null;
  function musicApi() { return window.__mistMusic || null; }
  function musicCtl() { return window.__mistMusicCtl || null; }
  function trackInfo(ap) {
    var a = ap && ap.list && ap.list.audios[ap.list.index];
    return a ? '《' + a.name + '》' + (a.artist ? ' - ' + a.artist : '') : '';
  }
  function showMusicMenu() {
    if (!on || pinned) return;                      // 音乐询问还没回答时，就让那个问题留着
    var ap = musicApi(), ctl = musicCtl();
    if (!ctl) return;
    if (!ctl.consented) {
      showMessage(['要听点音乐吗？我可以帮你放哦～', '安安静静的也不错，不过要不要来首歌？'], 3000, 13, [
        { label: '▶ 播放音乐', primary: true, onSelect: function () {
          ctl.start();
          showMessage('好耶～音乐马上就来！', 3000, 13);
        } },
        { label: '不用了', onSelect: function () { showMessage('好的，想听的时候再摸摸我～', 2500, 13); } }
      ]);
      return;
    }
    if (!ap) { showMessage('音乐还在加载中，稍等一下下～', 2500, 13); return; }
    var paused = ap.audio.paused;
    showMessage((paused ? '音乐暂停中：' : '正在播放：') + trackInfo(ap), 3000, 13, [
      { label: '⏮ 上一首', onSelect: function () { ap.skipBack(); ap.play(); refreshMusicMenu(); } },
      { label: paused ? '▶ 继续' : '⏸ 暂停', primary: true, onSelect: function () { ap.toggle(); refreshMusicMenu(); } },
      { label: '下一首 ⏭', onSelect: function () { ap.skipForward(); ap.play(); refreshMusicMenu(); } },
      { label: '🎵 打开播放器', onSelect: function () { ctl.openPanel(); endMessage(); } }
    ]);
  }
  var musicMenuOpen = false;
  function refreshMusicMenu() {
    setTimeout(function () { if (menuOpen && musicMenuOpen) { showMusicMenu(); musicMenuOpen = menuOpen; } }, 150);
  }

  function modelHit(x, y) {
    if (!modelBox || !on || !model) return false;
    var r = canvas.getBoundingClientRect();
    var bw = modelBox.right - modelBox.left;
    // 左右各收 15%：翅膀、飘带这类边缘部分不算「摸到她」
    return x >= r.left + modelBox.left + bw * 0.15 && x <= r.left + modelBox.right - bw * 0.15 &&
           y >= r.top + modelBox.top && y <= r.top + Math.min(modelBox.bottom, r.height);
  }
  function onModelMove() {
    moveRaf = 0;
    if (!lastXY) return;
    // 鼠标在工具栏 / 气泡上时不算
    var el = document.elementFromPoint(lastXY[0], lastXY[1]);
    var onUi = el && (toolEl.contains(el) || tipsEl.contains(el));
    var hit = !onUi && modelHit(lastXY[0], lastXY[1]);
    if (hit === overModel) return;
    overModel = hit;
    clearTimeout(dwellTimer);
    if (hit) {
      menuStay();
      dwellTimer = setTimeout(function () {       // 停留一小会儿才弹，路过不打扰
        if (!overModel) return;
        showMusicMenu();
        musicMenuOpen = menuOpen;
      }, 350);
    } else if (musicMenuOpen) {
      menuLeave();
    }
  }
  document.addEventListener('mousemove', function (e) {
    lastXY = [e.clientX, e.clientY];
    if (!moveRaf) moveRaf = requestAnimationFrame(onModelMove);
  }, { passive: true });
  // 切歌时如果看板娘在、又没别的事，报一下歌名
  document.addEventListener('mistgarden:music-ready', function () {
    var ap = musicApi();
    if (!ap || ap.__waifuBound) return;
    ap.__waifuBound = true;
    ap.on('listswitch', function () {
      setTimeout(function () {
        if (menuOpen && musicMenuOpen) { showMusicMenu(); musicMenuOpen = menuOpen; }
        else showMessage('下一首是' + trackInfo(ap) + '～', 3500, 9);
      }, 100);
    });
    ap.on('play', refreshMusicMenu);
    ap.on('pause', refreshMusicMenu);
  });

  var outfitBtn = toolEl.querySelector('[data-act="outfit"]');
  if (outfitBtn) {
    outfitBtn.addEventListener('mouseenter', showOutfitMenu);
    outfitBtn.addEventListener('mouseleave', menuLeave);
    outfitBtn.addEventListener('focus', showOutfitMenu);
  }

  /* ---- 首访音乐询问：由页面脚本调用，看板娘在场就常驻在气泡里 ---- */
  var musicAsk = null;
  function askMusic(handlers) {
    if (!on || !model) return false;
    musicAsk = handlers;
    pin('要播放背景音乐吗？点「播放」会加载播放器并开始放歌；不需要的话就不会加载任何音乐哦。', [
      { label: '▶ 播放', primary: true, onSelect: function () {
        musicAsk = null; unpin(); handlers.accept();
        showMessage('好耶～音乐开始啦，左下角可以随时收起播放器。', 5000, 11);
      } },
      { label: '不用了', onSelect: function () {
        musicAsk = null; unpin(); handlers.decline();
        showMessage('好的，那就安安静静的～想听的时候点左下角的 🎵 就行。', 5000, 11);
      } }
    ]);
    return true;
  }

  /* ---- 关于：气泡里给出「衣柜」和「模型来源」两个去处 ---- */
  function openWardrobe() {
    // 同名窗口：已打开就复用；带上当前角色 / 服装，衣柜会直接定位到这件
    var w = window.open(WARDROBE_URL + '#c=' + ci + '&o=' + oi, 'mistgarden-wardrobe');
    if (w) w.focus();
    showMessage('衣柜打开啦～在那边点哪件，我这边就马上换上哦！', 5000, 11);
  }
  function showAboutMenu() {
    var total = chars.reduce(function (t, c) { return t + c.outfits.length; }, 0);
    showMessage([
      '想要知道更多关于我的事么？我们一共有 ' + chars.length + ' 位、' + total + ' 套衣服哦～',
      '衣柜里有我们所有的衣服，要去看看吗？',
      '这里记录着我搬家的历史呢。'
    ], 3000, 13, [
      { label: '👗 打开衣柜', primary: true, onSelect: openWardrobe },
      { label: '模型来源', title: ABOUT_URL, onSelect: function () { window.open(ABOUT_URL, '_blank', 'noopener'); } }
    ]);
  }
  var infoBtn = toolEl.querySelector('[data-act="info"]');
  if (infoBtn) {
    infoBtn.addEventListener('mouseenter', showAboutMenu);
    infoBtn.addEventListener('mouseleave', menuLeave);
    infoBtn.addEventListener('focus', showAboutMenu);
  }

  /* ---- 和衣柜页互通：衣柜点「穿上」→ 主页换装；主页换装 → 衣柜高亮当前这件 ---- */
  var channel = null;
  try { channel = 'BroadcastChannel' in window ? new BroadcastChannel(CHANNEL) : null; } catch (e) { channel = null; }
  function broadcast() {
    if (channel && chars.length) channel.postMessage({ type: 'current', c: ci, o: oi, on: on });
  }
  if (channel) {
    channel.onmessage = function (e) {
      var d = e.data || {};
      if (d.type === 'hello') { broadcast(); return; }
      if (d.type !== 'wear' || !chars[d.c] || !chars[d.c].outfits[d.o]) return;
      var apply = function () {
        if (d.c === ci && d.o === oi) { showMessage('现在穿的就是这件呀～', 4000, 12); broadcast(); return; }
        var changedChar = d.c !== ci;
        ci = d.c; oi = d.o;
        showMessage(changedChar ? '正在请 ' + cur().name + ' 过来…' : '换装中…', 8000, 12);
        run(loadModel, function () {
          return changedChar ? (cur().msg || cur().name) + '（衣柜选的' + outfitLabel() + '）'
                             : '这是你在衣柜里挑的' + outfitLabel() + '吗？好看嘛？';
        }, cur().outfits.length > 1 ? outfitChoices : null);
      };
      if (busy) { setTimeout(function () { channel.onmessage(e); }, 400); return; }
      if (!on) {                                    // 看板娘退出了：先请回来再换
        if (isMobile()) { state.c = d.c; state.o = d.o; save(); ci = d.c; oi = d.o; broadcast(); return; }
        if (model) { show(true); apply(); return; }   // 模型还在内存里：请回来后照常换
        ci = d.c; oi = d.o;
        show(true);
        return;
      }
      apply();
    };
  }

  var ACTIONS = {
    hitokoto: hitokoto,
    character: function () {
      if (busy || chars.length < 2) return;
      ci = (ci + 1) % chars.length;
      oi = 0;
      showMessage('正在请 ' + cur().name + ' 过来…', 8000, 10);
      run(loadModel, function () { return cur().msg || cur().name; });
    },
    outfit: function () { changeOutfit(1); },
    photo: function () {
      if (!app || !model) return;
      showMessage('照好了嘛，是不是很可爱呢？', 6000, 9);
      app.renderer.render(app.stage);
      var shot = app.renderer.extract.canvas(app.stage);
      var a = document.createElement('a');
      a.download = 'live2d-' + cur().name + '.png';
      a.href = shot.toDataURL('image/png');
      a.click();
    },
    theme: function () {
      if (!themeBtn) return;
      themeBtn.click();
      syncUI();
      var light = document.documentElement.getAttribute('data-theme') === 'light';
      showMessage(light ? '浅色主题，看起来清爽多了～' : '深色主题，晚上看着更舒服哦～', 4000, 10);
    },
    background: function () {
      if (!bgToggle) return;
      bgToggle.checked = !bgToggle.checked;
      bgToggle.dispatchEvent(new Event('change', { bubbles: true }));
      syncUI();
      showMessage(bgToggle.checked ? '随机背景已开启，隔一会儿就换一张～' : '随机背景已关闭，换回固定背景啦。', 4000, 10);
    },
    info: showAboutMenu,
    quit: function () {
      showMessage('愿你有一天能与重要的人重逢。', 2000, 11);
      setTimeout(function () { hide(true); }, 1200);
    }
  };

  toolEl.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-act]');
    if (b && ACTIONS[b.dataset.act]) ACTIONS[b.dataset.act]();
  });
  toggle.addEventListener('click', function () { show(true); });

  var resizeTimer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (isMobile()) { if (on) hide(false); }
      else if (!on && !state.hidden) show(false);
      else fit();
      syncUI();
    }, 150);
  });

  // 调试入口：控制台里可以直接看 window.__live2d
  window.__live2d = {
    show: show, hide: hide, fit: fit, say: showMessage,
    get app() { return app; },
    get model() { return model; },
    get on() { return on; },
    get character() { return cur(); },
    get outfit() { return cur().outfits[oi]; },
    get characters() { return chars; }
  };

  /* ======================= 对页面开放的接口 ======================= */
  // whenReady()：看板娘第一次加载有结果后 resolve(true/false)；不会出现（手机 / 已退出 / 失败）时是 false
  var readyResolve, readyDone = false;
  var readyPromise = new Promise(function (r) { readyResolve = r; });
  function markReady(ok) { if (!readyDone) { readyDone = true; readyResolve(ok); } }
  setTimeout(function () { markReady(on && !!model); }, 20000);   // 网络太慢就别让音乐询问一直等
  window.__live2dWidget = {
    whenReady: function () { return readyPromise; },
    askMusic: askMusic,
    openWardrobe: openWardrobe,
    say: showMessage
  };

  /* ======================= 启动 ======================= */
  syncUI();
  resetIdle();
  // 页面其它资源加载完、浏览器空闲时再拉看板娘，不跟首屏抢带宽
  function boot() {
    if (state.hidden || isMobile()) { syncUI(); markReady(false); return; }
    show(false);
  }
  function whenIdle() {
    if ('requestIdleCallback' in window) requestIdleCallback(boot, { timeout: 2000 });
    else setTimeout(boot, 300);
  }
  if (document.readyState === 'complete') whenIdle();
  else window.addEventListener('load', whenIdle);
})();
