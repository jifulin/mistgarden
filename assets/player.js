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

  // 用户同意后自动尝试播放第一首；个别浏览器可能要求再次点击播放键。
  var VOLUME = 0.1;
  function safePlay(initial) {
    if (!ap || !ap.audio) return;
    var attempt;
    try { attempt = ap.audio.play(); }
    catch (err) { ap.notice('播放失败，请点击播放按钮重试', 4000, 0.95); return; }
    if (attempt && typeof attempt.catch === 'function') {
      attempt.catch(function (err) {
        if (err && err.name === 'AbortError' && !initial) return;
        ap.notice(initial && err && err.name === 'NotAllowedError'
          ? '浏览器限制自动播放，请点击播放按钮'
          : '播放失败，请点击播放按钮重试', 4000, 0.95);
      });
    }
  }

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
      // 声音由下方的用户同意分支触发，避免构造时无手势自动播放。
      autoplay: false,
      mutex: true,
      lrcType: 3,
      preload: 'none',
      listFolded: true,
      listMaxHeight: '260px',
      storageName: 'mistgarden-player'
    });

    bindEvents();

    // 点击询问框「播放」后，在第一首音源解析完成时立即尝试起播。
    ap.audio.setAttribute('playsinline', '');
    ap.audio.muted = false;
    ap.audio.addEventListener('play', function () { enqueue([ap.list.index + 1]); });
    var panel = container.closest('.music-player');
    if (panel && panel.dataset.playOnReady === 'true') {
      delete panel.dataset.playOnReady;
      try { ap.volume(VOLUME); } catch (e) {}
      safePlay(true);
    }
    document.dispatchEvent(new Event('mistgarden:music-ready'));
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

      return resolve(0);             // 用户同意播放后才解析当前曲目
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
