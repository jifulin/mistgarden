/*!
 * 雾光庭院 · Live2D 看板娘（右下角）
 * ------------------------------------------------------------------
 * 运行时（Cubism Core + PIXI + pixi-live2d-display）和模型都在本地仓库里，
 * 并且按需加载：只有真的要显示模型时才去拉脚本和贴图，平时访问导航页
 * 不会因为看板娘而变慢（模型贴图有十几 MB，首屏绝不能等它）。
 *
 * 加新模型：把模型文件夹放进 models/，再到 models/models.json 的 models
 * 数组里加一条，右下角就会自动多出切换按钮。
 *
 * 依赖顺序不能换：Cubism Core → PIXI → cubism4 渲染器（后者要挂到 PIXI 上）。
 * ------------------------------------------------------------------
 */
(function () {
  'use strict';

  var MODELS_JSON = 'models/models.json';
  var MODELS_DIR  = 'models/';
  var RUNTIME_DIR = 'assets/live2d/';
  var STATE_KEY   = 'mistgarden-live2d';   // sessionStorage：'on' / 'off'
  var FIT_W       = 0.94;                  // 模型宽度占容器宽度的比例（留出 EDGE_PAD 的余量）
  var FIT_H       = 0.96;                  // 模型高度占容器高度的比例
  var EDGE_PAD    = 6;                     // 距容器右/下的留白，别贴着屏幕边

  var wrap      = document.getElementById('live2dWrap');
  var canvas    = document.getElementById('live2dCanvas');
  var btn       = document.getElementById('live2dBtn');
  var switchBtn = document.getElementById('live2dSwitch');
  if (!wrap || !canvas || !btn) return;

  // 手机上不自动加载看板娘：省流量，也不跟占满底部的播放器挤（按钮在 CSS 里也藏了）。
  // 只挡「自动加载」——按钮依然可用，所以平板这类宽屏触摸设备想看得自己点一下。
  var narrow = window.matchMedia && window.matchMedia('(max-width: 640px)').matches;
  var touch  = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  var AUTO_OK = !narrow && !touch;

  var app = null;
  var model = null;
  var baseH = 0;                 // scale=1 时模型的高度，用来算自适应缩放
  var baseW = 0;                 // scale=1 时模型的宽度
  var models = [];
  var index = 0;
  var runtimePromise = null;
  var busy = false;
  var on = false;

  /* ======================= 小工具 ======================= */
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('脚本加载失败：' + src)); };
      document.head.appendChild(s);
    });
  }

  function tip(text) {
    var el = document.getElementById('live2dTip');
    if (!el) return;
    el.textContent = text || '';
    el.hidden = !text;
  }

  function save(v) { try { sessionStorage.setItem(STATE_KEY, v); } catch (e) {} }
  function saved() { try { return sessionStorage.getItem(STATE_KEY); } catch (e) { return null; } }

  /* ======================= 运行时 / 清单 ======================= */
  function ensureRuntime() {
    if (!runtimePromise) {
      runtimePromise = loadScript(RUNTIME_DIR + 'live2dcubismcore.min.js')
        .then(function () { return loadScript(RUNTIME_DIR + 'pixi.min.js'); })
        .then(function () { return loadScript(RUNTIME_DIR + 'cubism4.min.js'); })
        .then(function () {
          if (!window.PIXI || !PIXI.live2d || !PIXI.live2d.Live2DModel) {
            throw new Error('Live2D 运行时没有就绪');
          }
          PIXI.live2d.Live2DModel.registerTicker(PIXI.Ticker);
        });
      runtimePromise.catch(function () { runtimePromise = null; });   // 失败允许重试
    }
    return runtimePromise;
  }

  function ensureModels() {
    if (models.length) return Promise.resolve(models);
    return fetch(MODELS_JSON, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('models.json HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        models = (data && data.models) || [];
        if (!models.length) throw new Error('models.json 里还没有模型');
        return models;
      });
  }

  function ensureApp() {
    if (app) return app;
    app = new PIXI.Application({
      view: canvas,
      width: wrap.clientWidth || 320,
      height: wrap.clientHeight || 480,
      backgroundAlpha: 0,                     // 透明底，只画模型
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2)
    });
    return app;
  }

  /* ======================= 模型 ======================= */
  // 视口或容器尺寸变化时重新算画布大小和模型缩放（右下角对齐）
  // 宽高都要卡：只按高度缩放的话，这个模型的画布比容器宽，左边会被画布裁掉
  function fit() {
    if (!app || !model) return;
    var w = wrap.clientWidth;
    var h = wrap.clientHeight;
    if (!w || !h) return;
    app.renderer.resize(w, h);
    var entry = models[index] || {};
    var scale = Math.min(w * FIT_W / baseW, h * FIT_H / baseH) * (entry.scale || 1);
    model.scale.set(scale);
    model.anchor.set(1, 1);
    model.position.set(w - EDGE_PAD - (entry.offsetX || 0), h - (entry.offsetY || 0));
  }

  function loadModel(i) {
    var entry = models[i];
    if (!entry) return Promise.reject(new Error('没有这个模型'));
    if (model) { app.stage.removeChild(model); model.destroy(); model = null; }
    return PIXI.live2d.Live2DModel.from(MODELS_DIR + entry.model, { autoInteract: false })
      .then(function (m) {
        model = m;
        baseW = m.internalModel.width || m.width || 1;
        baseH = m.internalModel.height || m.height || 1;
        app.stage.addChild(m);
        m.scale.set(1);
        fit();
        return m;
      });
  }

  /* ======================= 显隐 / 切换 ======================= */
  function syncUI() {
    btn.textContent = '🎀';
    btn.title = on ? '隐藏看板娘' : '显示看板娘';
    btn.classList.toggle('is-off', !on);
    if (switchBtn) {
      switchBtn.hidden = !(on && models.length > 1);
      var next = models.length > 1 ? models[(index + 1) % models.length].name : '';
      switchBtn.title = models.length > 1 ? '切换模型（下一个：' + next + '）' : '切换模型';
    }
  }

  function show() {
    if (busy) return Promise.resolve();
    busy = true;
    tip('看板娘加载中…');
    wrap.hidden = false;                      // 先显示，否则容器尺寸是 0
    return ensureRuntime()
      .then(ensureModels)
      .then(ensureApp)
      .then(function () { return loadModel(index); })
      .then(function () {
        if (app) app.start();
        fit();
        on = true;
        save('on');
        tip('');
        syncUI();
      })
      .catch(function (err) {
        console.warn('[live2d] 加载失败：', err);
        tip('看板娘加载失败');
        setTimeout(function () { if (!on) wrap.hidden = true; }, 2500);
        on = false;
        syncUI();
      })
      .then(function () { busy = false; });
  }

  function hide() {
    on = false;
    wrap.hidden = true;
    if (app) app.stop();                      // 藏起来就别再渲染了，省电
    save('off');
    syncUI();
  }

  btn.addEventListener('click', function () { on ? hide() : show(); });

  if (switchBtn) {
    switchBtn.addEventListener('click', function () {
      if (models.length < 2) return;
      index = (index + 1) % models.length;
      if (!on) { show(); return; }
      tip('正在切换到 ' + models[index].name + '…');
      busy = true;
      loadModel(index)
        .then(function () { tip(''); syncUI(); })
        .catch(function (err) { console.warn('[live2d] 切换失败：', err); tip('切换失败'); })
        .then(function () { busy = false; });
    });
  }

  window.addEventListener('resize', fit);
  syncUI();

  // 调试/自检入口：控制台里可以直接看 window.__live2d（也方便以后调模型缩放）
  window.__live2d = {
    show: show,
    hide: hide,
    fit: fit,
    get app() { return app; },
    get model() { return model; },
    get on() { return on; },
    get index() { return index; },
    get models() { return models; }
  };

  // 默认就显示，但等页面空闲下来再加载，别跟导航页首屏抢带宽
  // 手机/触摸设备不自动加载（AUTO_OK），要看得手动点 🎀
  if (AUTO_OK && saved() !== 'off') {
    var kick = function () { if (saved() !== 'off' && !on) show(); };
    if (window.requestIdleCallback) requestIdleCallback(kick, { timeout: 2500 });
    else setTimeout(kick, 1200);
  }
})();
