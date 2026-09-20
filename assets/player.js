/*!
 * 雾光庭院 · 本地音乐播放器
 * ------------------------------------------------------------------
 * 为什么自己写播放逻辑：
 *   MetingJS 走的那个 Meting 接口对 VIP / 版权曲目只返回试听片段，
 *   所以歌单里的歌只能播 45 秒。这里改用一个公开的聚合音源接口
 *   （洛雪音乐那类自定义音源背后调用的就是这种接口），直接拿到
 *   完整音频地址，全曲可播。
 *
 * 说明：
 *   洛雪音乐的「自定义音源」是 .js 脚本，依赖洛雪客户端自己的
 *   lx.* 运行时（lx.request / lx.utils / 加密模块），无法直接在浏览器
 *   里跑。所以在网页里等价的做法是：调用同一类聚合音源 HTTP 接口。
 *
 * 依赖：本地 assets/APlayer.min.js + assets/APlayer.min.css
 *       （本文件不引用任何 CDN）
 * 接口：https://music-api.gdstudio.xyz/api.php
 *       ?types=playlist|url|lyric&source=netease&id=xxx&br=320
 * ------------------------------------------------------------------
 */
(function () {
  'use strict';

  /* ======================= 可调配置 ======================= */
  var API         = 'https://music-api.gdstudio.xyz/api.php';
  var SOURCE      = 'netease';      // netease / tencent / kugou / kuwo / migu / joox
  var PLAYLIST_ID = '7851350804';   // 歌单 ID
  var BR          = 320;            // 音质：320 / 192 / 128
  var CONCURRENCY = 2;              // 后台预热并发数（调高会被接口限流 503）
  var GAP         = 260;            // 相邻请求间隔(ms)
  var RETRY       = 3;              // 单个请求失败重试次数
  var WARMUP      = 20;             // 进入页面时后台预热的曲目数（其余点到时即时解析）

  /* ======================= 基础设施 ======================= */
  var container = document.getElementById('musicPlayer');
  if (!container || !window.APlayer) return;

  var audios  = [];                 // 曲目数组（与 ap.list.audios 是同一批对象）
  var pending = Object.create(null);
  var queue   = [];
  var running = 0;
  var retried = Object.create(null);
  var ap      = null;

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function endpoint(query) {
    return API + '?' + query + '&source=' + encodeURIComponent(SOURCE) + '&br=' + BR;
  }

  function request(url, retry) {
    if (retry === undefined) retry = RETRY;
    return fetch(url, { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).catch(function (err) {
      if (retry <= 1) throw err;
      return sleep(600 * (RETRY - retry + 1)).then(function () { return request(url, retry - 1); });
    });
  }

  // 聚合接口返回的封面是 http://，HTTPS 站点会被浏览器拦掉混合内容
  function toHttps(u) { return u ? String(u).replace(/^http:/, 'https:') : ''; }

  // 歌词以 Blob 形式喂给 APlayer（lrcType=3 时它用 XHR 直接取这个地址）
  function makeLrcBlob(text) {
    try {
      return URL.createObjectURL(new Blob([text || ' '], { type: 'text/plain;charset=utf-8' }));
    } catch (e) {
      return '';
    }
  }

  /* ======================= 音源解析 ======================= */
  function doResolve(i) {
    var a = audios[i];
    if (!a) return Promise.reject(new Error('曲目不存在'));

    var chain = Promise.resolve(a);

    // 1) 音频地址
    if (!a.url) {
      chain = chain.then(function () {
        return request(endpoint('types=url&id=' + a._id));
      }).then(function (d) {
        if (!d || !d.url) throw new Error('接口未返回播放地址');
        a.url = toHttps(d.url);
        a.bitrate = d.br || BR;
        return a;
      });
    }

    // 2) 歌词
    if (!a.lrc) {
      chain = chain.then(function () {
        return request(endpoint('types=lyric&id=' + a._id)).catch(function () { return null; });
      }).then(function (l) {
        a.lrc = makeLrcBlob(l && (l.lyric || l.tlyric));
        return a;
      });
    }

    return chain;
  }

  function resolve(i) {
    if (pending[i]) return pending[i];
    var p = doResolve(i).catch(function (err) {
      pending[i] = null;            // 失败后允许重试
      throw err;
    });
    pending[i] = p;
    return p;
  }

  function isReady(i) {
    var a = audios[i];
    return !!(a && a.url && a.lrc);
  }

  /* ======================= 后台预热队列 ======================= */
  function enqueue(indices) {
    for (var k = 0; k < indices.length; k++) {
      var i = indices[k];
      if (i < 0 || i >= audios.length) continue;
      if (isReady(i) || pending[i] || queue.indexOf(i) >= 0) continue;
      queue.push(i);
    }
    pump();
  }

  function pump() {
    while (running < CONCURRENCY && queue.length) {
      var i = queue.shift();
      if (!audios[i] || isReady(i) || pending[i]) continue;
      running += 1;
      resolve(i)
        .catch(function () { /* 失败就跳过，等用户点到时再重试 */ })
        .then(function () {
          running -= 1;
          setTimeout(pump, GAP);
        });
    }
  }

  /* ======================= 自动播放 =======================
   * 浏览器策略：带声音的自动播放必须有用户手势，静音自动播放虽然允许，
   * 但用户要的是「有声音」，所以不再静音偷播，改成进页面弹一个询问框：
   *   点「播放」→ 按钮点击本身就是手势，可以正常带声音起播
   *   点「关闭」→ 不自动播（播放器仍在左下角，随时可手动点播放）
   * 选择记在 sessionStorage：同一次浏览不再反复问，新开会话再问一次。
   *
   * 两个坑（都踩过）：
   *   1. APlayer 没有 muted 选项，options 里写 muted:true 是无效的；
   *      它的 autoplay 又是在构造函数里同步 play()，那一刻还没机会做别的处理，
   *      所以关掉 options.autoplay，起播时机全部自己控制。
   *   2. APlayer 的 play() 不返回 Promise（内部把 NotAllowedError 吞了，只把界面切回暂停），
   *      所以这里直接操作 audio 元素，自己拿 Promise 才能知道有没有被策略拦下。
   *      界面不用管：APlayer 监听媒体事件（play/pause/ended）自己会同步。
   * ====================================================== */
  var VOLUME   = 0.05;                  // 播放音量 0~1
  var ASK_KEY  = 'mistgarden-music';    // sessionStorage：'play' 已同意 / 'off' 已拒绝
  var wantPlay = false;                 // 用户同意播放（此时播放器可能还没就绪）
  var asked    = false;                 // 本次会话已经弹过询问框，不再重复弹

  function showAsk() {
    var el = document.getElementById('playAsk');
    if (!el || asked || !el.hidden) return;
    asked = true;
    el.hidden = false;
    requestAnimationFrame(function () { el.classList.add('show'); });
  }

  function hideAsk() {
    var el = document.getElementById('playAsk');
    asked = true;
    if (!el) return;
    el.classList.remove('show');
    setTimeout(function () { el.hidden = true; }, 260);
  }

  // 带声音起播。必须在用户手势中（或手势之后）调用，否则会被浏览器拦下。
  function startPlay() {
    wantPlay = true;
    if (!ap || !ap.audio) return;        // 播放器还没建好 → initPlayer 里补播
    ap.audio.muted = false;
    try { ap.volume(VOLUME); } catch (e) { /* 忽略 */ }
    safePlay();
  }

  function safePlay() {
    if (!ap || !ap.audio) return;
    var a = ap.audio;
    var p = a.play();
    if (p && typeof p.catch === 'function') {
      p.catch(function (err) {
        if (err && err.name === 'AbortError') return;
        if (err && err.name === 'NotAllowedError') showAsk();   // 没有手势 → 让用户自己点
        else ap.notice('点击播放按钮开始播放', 2600, 0.95);
      });
    }
  }

  // 询问框的两个按钮
  (function bindAsk() {
    var yes = document.getElementById('playAskYes');
    var no  = document.getElementById('playAskNo');
    if (yes) yes.addEventListener('click', function () {
      try { sessionStorage.setItem(ASK_KEY, 'play'); } catch (e) {}
      hideAsk();
      startPlay();
    });
    if (no) no.addEventListener('click', function () {
      try { sessionStorage.setItem(ASK_KEY, 'off'); } catch (e) {}
      wantPlay = false;
      hideAsk();
    });
  })();

  // 本次会话的选择：同意过 → 就绪后直接尝试带声音播（被拦会自己再弹询问框）
  var savedAsk = null;
  try { savedAsk = sessionStorage.getItem(ASK_KEY); } catch (e) {}
  if (savedAsk === 'play') wantPlay = true;

  function bindEvents() {
    // 列表里点到还没解析完的曲目：先解析，再切换（拦在 APlayer 自己的点击处理之前）
    container.addEventListener('click', function (e) {
      if (!ap) return;
      var li = e.target && e.target.closest ? e.target.closest('.aplayer-list li') : null;
      if (!li || !li.parentNode) return;

      var idx = Array.prototype.indexOf.call(li.parentNode.children, li);
      if (idx < 0 || idx >= audios.length || isReady(idx)) return;   // 已就绪 → 交给 APlayer

      e.preventDefault();
      e.stopPropagation();
      ap.notice('正在解析音源…', 1500, 0.95);
      resolve(idx).then(function () {
        ap.list.switch(idx);
        safePlay();
      }).catch(function () {
        ap.notice('《' + audios[idx].name + '》暂无可用音源', 2600);
      });
    }, true);

    // 上一首 / 下一首 / 自动切歌时兜底解析
    ap.on('listswitch', function (info) {
      var i = info.index;
      enqueue([i + 1, i + 2, i + 3]);      // 顺手预热后面几首
      if (isReady(i)) return;
      ap.notice('正在解析音源…', 1200, 0.95);
      resolve(i).then(function () {
        if (ap.list.index !== i) return;
        ap.list.switch(i);
        safePlay();
      }).catch(function () {
        ap.notice('该曲目暂无可用音源，已跳过', 2000);
        setTimeout(function () { ap.skipForward(); }, 900);
      });
    });

    // 音频地址是带时间戳的临时直链，久放会过期：失败时重解析一次
    ap.on('error', function () {
      var i = ap.list.index;
      var a = audios[i];
      if (!a || retried[i]) { retried[i] = 0; return; }
      retried[i] = 1;
      a.url = '';                    // 强制重新取直链
      pending[i] = null;
      resolve(i).then(function () {
        ap.list.switch(i);
        safePlay();
      }).catch(function () {});
    });
  }

  function initPlayer() {
    ap = new APlayer({
      container: container,
      audio: audios,
      theme: '#ff8fab',
      volume: VOLUME,
      // autoplay 交给下面的询问框逻辑（原因见「自动播放」注释）
      autoplay: false,
      mutex: true,
      lrcType: 3,
      preload: 'none',
      listFolded: true,
      listMaxHeight: '260px',
      storageName: 'mistgarden-player'
    });

    bindEvents();

    // === 起播：同意过才播，没问过就弹询问框 ===
    ap.audio.setAttribute('playsinline', '');   // iOS 上避免被系统接管成全屏播放
    ap.audio.muted = false;                     // 保持能出声，用户手动点播放时不会被静音
    if (wantPlay) startPlay();                  // 已同意（含「播放器就绪前就点了播放」）
    else if (savedAsk !== 'off') showAsk();     // 没问过 → 弹一次

    // 后台预热前 WARMUP 首，其余曲目点到时即时解析，避免对接口造成无谓压力
    // 用户选了「关闭」就不预热，省掉这 20 组请求
    if (wantPlay || savedAsk !== 'off') {
      var warm = [];
      for (var i = 0; i < audios.length && i < WARMUP; i++) warm.push(i);
      setTimeout(function () { enqueue(warm); }, 800);
    }
  }

  /* ======================= 启动 ======================= */
  function boot() {
    request(endpoint('types=playlist&id=' + PLAYLIST_ID)).then(function (data) {
      var tracks = data && data.playlist && data.playlist.tracks;
      if (!tracks || !tracks.length) throw new Error('歌单为空');

      audios = tracks.map(function (t) {
        return {
          _id:    t.id,
          name:   t.name,
          artist: (t.ar || []).map(function (x) { return x.name; }).join(' / '),
          cover:  toHttps(t.al && t.al.picUrl),
          url:    '',
          lrc:    ''
        };
      });

      return resolve(0);             // 先把第一首备好，保证进来就能播
    }).then(initPlayer).catch(function (err) {
      console.warn('[music] 播放器初始化失败：', err);
      container.textContent = '🎵 音源加载失败';
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
