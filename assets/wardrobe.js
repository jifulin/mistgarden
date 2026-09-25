/*!
 * 雾光庭院 · 看板娘衣柜
 * ------------------------------------------------------------------
 * 展示 assets/live2d-models.json 里的全部角色和服装：
 *   - 左边大预览（可动的 Live2D），右边按角色分页的服装网格（缩略图懒加载）
 *   - 「给看板娘穿上」通过 BroadcastChannel 通知主页，主页的看板娘立刻换装；
 *     主页换装后会广播回来，这里同步高亮「正在穿」。
 *   - 主页没开着时，选择写进 localStorage（和主页同一个键），下次打开主页就穿这件。
 * 运行时和主页相同：Cubism 2 core + PIXI v6 + pixi-live2d-display(cubism2)。
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
  var STORE_KEY = 'mistgarden.live2d';     // 和主页 live2d.js 共用
  var CHANNEL   = 'mistgarden-live2d';
  var THUMB_W = 180, THUMB_H = 240;         // 缩略图逻辑尺寸（按 2 倍渲染）

  var $ = function (id) { return document.getElementById(id); };
  var statusEl = $('wdStatus'), tabsEl = $('wdTabs'), gridEl = $('wdGrid'), msgEl = $('wdCharMsg');
  var canvas = $('wdCanvas'), stageTip = $('wdStageTip'), nameEl = $('wdPreviewName');
  var wearBtn = $('wdWear'), prevBtn = $('wdPrev'), nextBtn = $('wdNext');
  var filterEl = $('wdFilter'), jumpForm = $('wdJump'), jumpNum = $('wdJumpNum');

  var base = '', chars = [];
  var tab = 0;                              // 当前显示的角色页签
  var sel = { c: 0, o: 0 };                 // 预览中的服装
  var wearing = null;                       // 主页看板娘正在穿的 { c, o }
  var mainAlive = false;                    // 主页是否开着（收到过它的广播）
  var app = null, preview = null, previewSeq = 0;
  var thumbs = {};                          // "c-o" -> dataURL

  function readState() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function writeState(c, o) {
    var s = readState();
    s.c = c; s.o = o; s.hidden = false;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (e) {}
  }
  function outfit(c, o) { return chars[c] && chars[c].outfits[o]; }
  function label(c, o) {
    var ch = chars[c], of = outfit(c, o);
    return ch && of ? ch.name + ' · ' + of.name + '（' + (o + 1) + '/' + ch.outfits.length + '）' : '';
  }
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

  /* ======================= 状态栏 ======================= */
  function setStatus(html) { statusEl.innerHTML = html; }
  function esc(t) { return String(t).replace(/[&<>"]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]; }); }
  function refreshStatus() {
    if (!chars.length) return;
    if (mainAlive && wearing) {
      setStatus('已连接主页 · 看板娘正在穿 <b>' + esc(label(wearing.c, wearing.o)) + '</b>');
    } else if (wearing) {
      setStatus('主页没有打开 · 下次打开主页时会穿 <b>' + esc(label(wearing.c, wearing.o)) + '</b>');
    } else {
      setStatus('主页没有打开 · 在这里选好，下次打开主页就会穿上');
    }
  }

  /* ======================= 页面互通 ======================= */
  var channel = null;
  try { channel = 'BroadcastChannel' in window ? new BroadcastChannel(CHANNEL) : null; } catch (e) { channel = null; }
  var pendingWear = null, pendingTimer = 0;
  if (channel) {
    channel.onmessage = function (e) {
      var d = e.data || {};
      if (d.type !== 'current') return;
      mainAlive = true;
      wearing = { c: d.c, o: d.o };
      if (pendingWear && pendingWear.c === d.c && pendingWear.o === d.o) {
        clearTimeout(pendingTimer);
        pendingWear = null;
        wearBtn.disabled = false;
      }
      markWearing();
      refreshStatus();
    };
  }

  function wear(c, o) {
    if (!outfit(c, o)) return;
    if (channel && mainAlive) {
      pendingWear = { c: c, o: o };
      wearBtn.disabled = true;
      setStatus('正在给看板娘换上 <b>' + esc(label(c, o)) + '</b>…');
      channel.postMessage({ type: 'wear', c: c, o: o });
      clearTimeout(pendingTimer);
      pendingTimer = setTimeout(function () {       // 主页可能已经关了：改成存起来
        pendingWear = null;
        wearBtn.disabled = false;
        mainAlive = false;
        writeState(c, o);
        wearing = { c: c, o: o };
        markWearing();
        refreshStatus();
      }, 12000);
    } else {
      writeState(c, o);
      wearing = { c: c, o: o };
      markWearing();
      setStatus('已记住 <b>' + esc(label(c, o)) + '</b> · 主页没有打开，<a href="index.html">现在去主页</a>就能看到');
    }
  }

  /* ======================= 列表 ======================= */
  function buildTabs() {
    tabsEl.textContent = '';
    chars.forEach(function (ch, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'wd-tab';
      b.setAttribute('role', 'tab');
      b.dataset.c = i;
      b.innerHTML = esc(ch.name) + '<small>' + ch.outfits.length + '</small>';
      b.addEventListener('click', function () { showTab(i); });
      tabsEl.appendChild(b);
    });
  }

  var observer = null;
  function showTab(i) {
    tab = i;
    tabsEl.querySelectorAll('.wd-tab').forEach(function (b) {
      b.setAttribute('aria-selected', String(+b.dataset.c === i));
    });
    var ch = chars[i];
    msgEl.textContent = (ch.msg || '') + (ch.outfits.length > 1 ? ' · 共 ' + ch.outfits.length + ' 套，单击预览，双击直接穿上' : '');
    jumpNum.max = String(ch.outfits.length);
    jumpNum.placeholder = '1-' + ch.outfits.length;
    if (observer) observer.disconnect();
    queue.length = 0;
    gridEl.textContent = '';
    ch.outfits.forEach(function (of, o) {
      var card = document.createElement('button');
      card.type = 'button';
      card.className = 'wd-card';
      card.setAttribute('role', 'listitem');
      card.dataset.o = o;
      card.dataset.name = of.name.toLowerCase();
      card.title = label(i, o);
      var key = i + '-' + o;
      card.innerHTML = '<div class="wd-thumb">' + (thumbs[key] ? '<img alt="" src="' + thumbs[key] + '">' : '<span class="wd-spin"></span>') + '</div>' +
        '<span class="wd-card-no">' + (o + 1) + '</span><span class="wd-card-badge">正在穿</span>' +
        '<span class="wd-card-name">' + esc(of.name) + '</span>';
      card.addEventListener('click', function () { select(i, o); });
      card.addEventListener('dblclick', function () { select(i, o); wear(i, o); });
      gridEl.appendChild(card);
    });
    applyFilter();
    markWearing();
    markSelected();
    observer = 'IntersectionObserver' in window ? new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        observer.unobserve(en.target);
        enqueueThumb(i, +en.target.dataset.o, en.target);
      });
    }, { rootMargin: '200px' }) : null;
    gridEl.querySelectorAll('.wd-card').forEach(function (card) {
      if (thumbs[i + '-' + card.dataset.o]) return;
      if (observer) observer.observe(card); else enqueueThumb(i, +card.dataset.o, card);
    });
  }

  function markWearing() {
    tabsEl.querySelectorAll('.wd-tab').forEach(function (b) {
      b.classList.toggle('is-wearing', !!wearing && +b.dataset.c === wearing.c);
    });
    gridEl.querySelectorAll('.wd-card').forEach(function (card) {
      card.classList.toggle('is-wearing', !!wearing && wearing.c === tab && wearing.o === +card.dataset.o);
    });
    updateWearBtn();
  }
  function markSelected() {
    gridEl.querySelectorAll('.wd-card').forEach(function (card) {
      var on = sel.c === tab && sel.o === +card.dataset.o;
      card.classList.toggle('is-selected', on);
      card.setAttribute('aria-current', on ? 'true' : 'false');
    });
  }
  function updateWearBtn() {
    var same = wearing && wearing.c === sel.c && wearing.o === sel.o;
    wearBtn.textContent = same ? '看板娘正在穿这件' : (mainAlive ? '给看板娘穿上' : '下次打开主页穿这件');
    wearBtn.disabled = !!same || !!pendingWear;
    var n = chars[sel.c] ? chars[sel.c].outfits.length : 0;
    prevBtn.disabled = nextBtn.disabled = n < 2;
  }

  function applyFilter() {
    var q = filterEl.value.trim().toLowerCase();
    gridEl.querySelectorAll('.wd-card').forEach(function (card) {
      card.hidden = !!q && card.dataset.name.indexOf(q) < 0;
    });
  }
  filterEl.addEventListener('input', applyFilter);
  jumpForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var n = parseInt(jumpNum.value, 10), max = chars[tab].outfits.length;
    if (!(n >= 1 && n <= max)) { jumpNum.value = ''; jumpNum.placeholder = '只有 1-' + max; return; }
    filterEl.value = '';
    applyFilter();
    select(tab, n - 1, true);
  });
  wearBtn.addEventListener('click', function () { wear(sel.c, sel.o); });
  prevBtn.addEventListener('click', function () { step(-1); });
  nextBtn.addEventListener('click', function () { step(1); });
  function step(d) {
    var n = chars[sel.c].outfits.length;
    select(sel.c, (sel.o + d + n) % n, true);
  }

  function select(c, o, scroll) {
    if (!outfit(c, o)) return;
    sel = { c: c, o: o };
    if (tab !== c) showTab(c);
    markSelected();
    updateWearBtn();
    nameEl.textContent = label(c, o);
    try { history.replaceState(null, '', '#c=' + c + '&o=' + o); } catch (e) {}
    if (scroll) {
      var card = gridEl.querySelector('.wd-card[data-o="' + o + '"]');
      if (card) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    loadPreview(c, o);
  }

  /* ======================= Live2D：加载 / 取景 ======================= */
  // still=true：缩略图用，去掉动作 / 表情（否则模型销毁后异步加载完的动作还会去启动，控制台报错）
  function loadModelFor(c, o, opts, still) {
    var of = outfit(c, o);
    var url = base + of.model + '/index.json';
    return fetch(url)
      .then(function (r) { if (!r.ok) throw new Error('index.json HTTP ' + r.status); return r.json(); })
      .then(function (json) {
        json.url = url;
        if (of.textures) json.textures = of.textures.slice();
        if (still) { delete json.motions; delete json.expressions; }
        return PIXI.live2d.Live2DModel.from(json, opts);
      });
  }

  // 量出人物真实外框（模型自身坐标，缩放 1、位置 0）：各模型 index.json 的 layout 很不统一，
  // 人物常画在声明的包围盒外面，所以四周扩一倍渲染到离屏纹理里扫描不透明像素。
  function measure(m) {
    var r = app.renderer;
    m.scale.set(1); m.position.set(0, 0); m.anchor.set(0, 0);
    var b0 = m.getBounds();
    if (!b0.width || !b0.height) return null;
    var bb = { x: b0.x - b0.width, y: b0.y - b0.height, w: b0.width * 3, h: b0.height * 3 };
    var q = Math.min(1, 720 / Math.max(bb.w, bb.h));
    var tw = Math.ceil(bb.w * q), th = Math.ceil(bb.h * q);
    var rt = PIXI.RenderTexture.create({ width: tw, height: th, resolution: 1 });
    try {
      r.render(m, { renderTexture: rt, clear: true, transform: new PIXI.Matrix(q, 0, 0, q, -bb.x * q, -bb.y * q) });
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
      return { x: bb.x + left / q, y: bb.y + top / q, w: (right - left + 1) / q, h: (bottom - top + 1) / q };
    } finally {
      rt.destroy(true);
    }
  }

  // 按外框把人物放进 w×h：水平居中、底边对齐（半身像自然截断在底部）
  function place(m, box, w, h, padTop) {
    var s = Math.min(w * 0.92 / box.w, (h - padTop) / box.h);
    m.scale.set(s);
    m.position.set((w - box.w * s) / 2 - box.x * s, h - (box.y + box.h) * s);
  }

  function ensureApp() {
    if (app) return;
    app = new PIXI.Application({
      view: canvas,
      width: canvas.clientWidth || 300,
      height: canvas.clientHeight || 400,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2)
    });
    window.addEventListener('resize', fitPreview);
  }

  function fitPreview() {
    if (!app || !preview || !preview.__box) return;
    var w = canvas.clientWidth, h = canvas.clientHeight;
    app.renderer.resize(w, h);
    place(preview, preview.__box, w, h, 12);
  }

  function loadPreview(c, o) {
    var seq = ++previewSeq;
    stageTip.hidden = false;
    stageTip.textContent = '加载中…';
    return loadModelFor(c, o, { autoInteract: false })
      .then(function (m) {
        if (seq !== previewSeq) { m.destroy(); return; }
        if (preview) { app.stage.removeChild(preview); preview.destroy(); }
        preview = m;
        m.alpha = 0;
        app.stage.addChild(m);
        // 等一两帧让动作 / 物理跑起来再取景
        setTimeout(function () {
          if (m !== preview) return;
          var alpha = m.alpha; m.alpha = 1;
          var box = measure(m);
          m.alpha = alpha;
          m.__box = box || { x: 0, y: 0, w: m.internalModel.width, h: m.internalModel.height };
          fitPreview();
          m.alpha = 1;
          stageTip.hidden = true;
        }, 200);
      })
      .catch(function (err) {
        console.warn('[wardrobe] 预览加载失败：', err);
        if (seq === previewSeq) stageTip.textContent = '加载失败，点一下别的再试试';
      });
  }

  /* ======================= 缩略图（懒加载，一张一张来） ======================= */
  var queue = [], working = false;
  function enqueueThumb(c, o, card) {
    queue.push({ c: c, o: o, card: card });
    pump();
  }
  function pump() {
    if (working || !queue.length || !app) return;
    // 优先画当前屏幕里看得见的卡片
    var vh = window.innerHeight, idx = 0;
    for (var i = 0; i < queue.length; i++) {
      var r = queue[i].card.getBoundingClientRect();
      if (r.bottom > 0 && r.top < vh) { idx = i; break; }
    }
    var job = queue.splice(idx, 1)[0];
    var key = job.c + '-' + job.o;
    if (thumbs[key] || job.c !== tab) { pump(); return; }
    working = true;
    loadModelFor(job.c, job.o, { autoInteract: false, autoUpdate: false }, true)
      .then(function (m) {
        m.update(500);                                   // 走一小段时间，让呼吸 / 眨眼等参数就位
        var box = measure(m);
        if (!box) throw new Error('空模型');
        var res = 2, tw = THUMB_W * res, th = THUMB_H * res;
        var rt = PIXI.RenderTexture.create({ width: tw, height: th, resolution: 1 });
        place(m, box, tw, th, 8 * res);
        app.renderer.render(m, { renderTexture: rt, clear: true });
        var url = app.renderer.extract.canvas(rt).toDataURL('image/png');
        rt.destroy(true);
        // 释放贴图（预览正在用的不动）
        var keep = preview && preview.textures ? preview.textures.map(function (t) { return t.baseTexture; }) : [];
        (m.textures || []).forEach(function (t) { if (keep.indexOf(t.baseTexture) < 0) t.destroy(true); });
        m.destroy();
        thumbs[key] = url;
        var img = job.card.querySelector('.wd-thumb');
        if (img && document.body.contains(job.card)) img.innerHTML = '<img alt="" src="' + url + '">';
      })
      .catch(function (err) {
        console.warn('[wardrobe] 缩略图失败：', key, err);
        var img = job.card.querySelector('.wd-thumb');
        if (img) img.innerHTML = '';
      })
      .then(function () { working = false; setTimeout(pump, 30); });
  }

  /* ======================= 启动 ======================= */
  function fromHash() {
    var m = /c=(\d+)&o=(\d+)/.exec(location.hash);
    return m ? { c: +m[1], o: +m[2] } : null;
  }
  window.addEventListener('hashchange', function () {
    var h = fromHash();
    if (h && (h.c !== sel.c || h.o !== sel.o)) select(h.c, h.o, true);
  });

  Promise.all([
    fetch(MANIFEST).then(function (r) { if (!r.ok) throw new Error('清单 HTTP ' + r.status); return r.json(); }),
    RUNTIME.reduce(function (p, src) { return p.then(function () { return loadScript(src); }); }, Promise.resolve())
  ]).then(function (res) {
    var data = res[0];
    base = data.base;
    chars = (data.characters || []).filter(function (c) { return c.outfits && c.outfits.length; });
    PIXI.live2d.Live2DModel.registerTicker(PIXI.Ticker);
    ensureApp();

    // 先按本地记录猜主页穿的是哪件，再问问主页本人
    var st = readState(), def = data['default'] || { c: 0, o: 0 };
    wearing = outfit(st.c, st.o) ? { c: st.c, o: st.o } : (outfit(def.c, def.o) ? { c: def.c, o: def.o } : null);
    buildTabs();
    var start = fromHash() || wearing || { c: 0, o: 0 };
    if (!outfit(start.c, start.o)) start = { c: 0, o: 0 };
    showTab(start.c);
    select(start.c, start.o, true);
    refreshStatus();
    if (channel) {
      channel.postMessage({ type: 'hello' });
      setTimeout(refreshStatus, 800);
    }
  }).catch(function (err) {
    console.error('[wardrobe] 初始化失败：', err);
    setStatus('衣柜加载失败了，请检查网络后刷新页面');
    stageTip.textContent = '加载失败';
  });
})();
