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
 * 歌单选择（播放器顶部的「🎶 歌单」下拉）：
 *   1. 默认歌单：本站歌单（PRESETS.default）
 *   2. 网易云热歌榜：网易云官方榜单
 *   3. 抖音热门榜：网易云官方的「抖音排行榜」（抖音没有公开的音乐接口）
 *   4. 自定义：先选平台（网易云 / QQ 音乐 / 酷狗），再填歌单 ID 或分享链接
 *   选择会存在 localStorage，下次打开还是这个歌单；加载失败会退回之前的歌单。
 *
 * 各平台怎么取歌：
 *   - 网易云：聚合接口直接取歌单、直链、歌词（全曲）。
 *   - QQ 音乐 / 酷狗：聚合接口的公共实例只支持网易云，所以用 Meting 接口取歌单（歌名 / 歌手 / 封面），
 *     播放时按「歌名 + 歌手」到网易云搜同一首，用网易云的全曲音源；搜不到才退回 Meting 的地址（可能是试听片段）。
 *   - 酷我：目前公开的 Meting 实例都取不到酷我歌单，所以没有提供。
 *
 * 依赖：本地 assets/APlayer.min.js + assets/APlayer.min.css
 *       （本文件不引用任何 CDN）
 * 接口：https://music-api.gdstudio.xyz/api.php
 *       ?types=playlist|url|lyric|search&source=netease&id=xxx&br=320
 *       Meting：https://api.i-meto.com/meting/api?server=tencent|kugou&type=playlist&id=xxx（另有两个备用实例）
 * ------------------------------------------------------------------
 */
(function () {
  'use strict';

  /* ======================= 可调配置 ======================= */
  var API         = 'https://music-api.gdstudio.xyz/api.php';
  var SOURCE      = 'netease';      // 聚合接口的公共实例目前只有网易云能取歌单 / 直链
  var BR          = 320;            // 音质：320 / 192 / 128
  var CONCURRENCY = 2;              // 后台预热并发数（调高会被接口限流 503）
  var GAP         = 260;            // 相邻请求间隔(ms)
  var RETRY       = 3;              // 单个请求失败重试次数

  // 歌单下拉里的固定选项（id 都是网易云歌单 ID）
  var PRESETS = [
    { key: 'default', label: '默认歌单',     desc: '本站歌单',               platform: 'netease', id: '7851350804' },
    { key: 'hot',     label: '网易云热歌榜', desc: '网易云官方榜单',          platform: 'netease', id: '3778678' },
    { key: 'douyin',  label: '抖音热门榜',   desc: '网易云官方「抖音排行榜」', platform: 'netease', id: '2250011882' }
  ];
  var PLATFORMS = { netease: '网易云', tencent: 'QQ 音乐', kugou: '酷狗' };
  // Meting 公共实例：按顺序尝试，前一个挂了用下一个（字段名各家不同，统一在 fromMeting() 里处理）
  var METING = [
    'https://api.i-meto.com/meting/api',
    'https://api.qijieya.cn/meting/',
    'https://api.injahow.cn/meting/'
  ];
  var STORE_KEY = 'mistgarden.playlist';

  /* ======================= 基础设施 ======================= */
  var container = document.getElementById('musicPlayer');
  if (!container || !window.APlayer) return;

  var audios  = [];                 // 当前歌单的曲目（与 ap.list.audios 是同一批对象）
  var queue   = [];                 // 后台预热队列（存曲目对象）
  var running = 0;
  var ap      = null;
  var gen     = 0;                  // 歌单代次：切歌单后，上一个歌单还没回来的请求一律作废
  var current = null;               // 当前正在放的歌单 { key, platform, id }
  var info    = {};                 // 已加载歌单的名称 / 曲目数，key -> { name, count }

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

  /* ======================= 取歌单 ======================= */
  function fromNetease(id) {
    return request(endpoint('types=playlist&id=' + encodeURIComponent(id))).then(function (data) {
      var p = data && data.playlist;
      var tracks = p && p.tracks;
      if (!tracks || !tracks.length) throw new Error('歌单为空或不存在');
      return {
        name: p.name || '',
        tracks: tracks.map(function (t) {
          return {
            _id:    String(t.id),
            name:   t.name,
            artist: (t.ar || []).map(function (x) { return x.name; }).join(' / '),
            cover:  toHttps(t.al && t.al.picUrl),
            url:    '',
            lrc:    ''
          };
        })
      };
    });
  }

  // 依次尝试各个 Meting 实例，拿到非空数组为止
  function meting(query) {
    var i = 0;
    function next(lastErr) {
      if (i >= METING.length) return Promise.reject(lastErr || new Error('Meting 接口都不可用'));
      var base = METING[i++];
      return request(base + (base.indexOf('?') >= 0 ? '&' : '?') + query, 1).then(function (d) {
        if (!Array.isArray(d) || !d.length) throw new Error('歌单为空或不存在');
        return d;
      }).catch(next);
    }
    return next();
  }

  function fromMeting(server, id) {
    return meting('server=' + server + '&type=playlist&id=' + encodeURIComponent(id)).then(function (list) {
      var tracks = list.map(function (t) {
        var name = t.name || t.title || '';
        var artist = String(t.artist || t.author || '').split(/\s*\/\s*/).join(' / ');
        return {
          _id:    '',                          // 网易云 ID：播放时再按歌名 + 歌手去搜
          _q:     (name + ' ' + artist.split(' / ')[0]).trim(),
          _title: name,
          _artist: artist,
          _altUrl: t.url || '',               // 搜不到时的备用地址（Meting 自己的，可能只有试听片段）
          _altLrc: t.lrc || '',
          name:   name,
          artist: artist,
          cover:  toHttps(t.pic || t.cover),
          url:    '',
          lrc:    ''
        };
      }).filter(function (t) { return t.name; });
      if (!tracks.length) throw new Error('歌单为空或不存在');
      return { name: '', tracks: tracks };
    });
  }

  function loadPlaylist(sel) {
    return sel.platform === 'netease' ? fromNetease(sel.id) : fromMeting(sel.platform, sel.id);
  }

  /* ======================= 音源解析 ======================= */
  // 「red lips（被我蒙对）」和「red lips」算同一首：去掉括号里的内容、空白和大小写再比
  function norm(s) {
    return String(s || '').toLowerCase().replace(/[(（\[【][^)）\]】]*[)）\]】]/g, '').replace(/[\s·・\-_'"‘’“”]/g, '');
  }
  function pickMatch(a, list) {
    var title = norm(a._title);
    var artists = a._artist.split(' / ').map(norm).filter(Boolean);
    var best = null, bestScore = 0;
    (list || []).forEach(function (r) {
      var n = norm(r.name);
      var score = 0;
      if (n && title && (n === title || n.indexOf(title) >= 0 || title.indexOf(n) >= 0)) score += 2;
      var ra = (r.artist || []).map(norm);
      if (artists.some(function (x) { return ra.some(function (y) { return y && (x.indexOf(y) >= 0 || y.indexOf(x) >= 0); }); })) score += 1;
      if (score > bestScore) { best = r; bestScore = score; }
    });
    return bestScore >= 2 ? best : null;       // 至少歌名对得上，免得放错歌
  }

  // QQ / 酷狗的曲目：先到网易云搜同一首，拿到网易云 ID；搜不到就用 Meting 的备用地址
  function matchNetease(a) {
    if (a._id || !a._q) return Promise.resolve(a);
    return request(endpoint('types=search&count=8&name=' + encodeURIComponent(a._q))).catch(function () { return []; })
      .then(function (list) {
        var hit = pickMatch(a, list);
        if (hit) { a._id = String(hit.id); return a; }
        if (!a._altUrl) throw new Error('网易云上没找到这首歌');
        a.url = toHttps(a._altUrl);
        a.lrc = a._altLrc ? toHttps(a._altLrc) : makeLrcBlob('');
        a._alt = true;
        return a;
      });
  }

  function doResolve(a) {
    var chain = matchNetease(a);

    // 1) 音频地址
    chain = chain.then(function () {
      if (a.url) return a;
      return request(endpoint('types=url&id=' + a._id)).then(function (d) {
        if (!d || !d.url) throw new Error('接口未返回播放地址');
        a.url = toHttps(d.url);
        a.bitrate = d.br || BR;
        return a;
      });
    });

    // 2) 歌词
    chain = chain.then(function () {
      if (a.lrc) return a;
      return request(endpoint('types=lyric&id=' + a._id)).catch(function () { return null; }).then(function (l) {
        a.lrc = makeLrcBlob(l && (l.lyric || l.tlyric));
        return a;
      });
    });

    return chain;
  }

  function resolve(a) {
    if (!a) return Promise.reject(new Error('曲目不存在'));
    if (a._pending) return a._pending;
    var p = doResolve(a).then(function (x) { a._pending = null; return x; }, function (err) {
      a._pending = null;            // 失败后允许重试
      throw err;
    });
    a._pending = p;
    return p;
  }

  function isReady(a) { return !!(a && a.url && a.lrc); }

  /* ======================= 后台预热队列 ======================= */
  function enqueue(indices) {
    for (var k = 0; k < indices.length; k++) {
      var a = audios[indices[k]];
      if (!a || isReady(a) || a._pending || queue.indexOf(a) >= 0) continue;
      queue.push(a);
    }
    pump();
  }

  function pump() {
    while (running < CONCURRENCY && queue.length) {
      var a = queue.shift();
      if (audios.indexOf(a) < 0 || isReady(a) || a._pending) continue;   // 已经换了歌单 / 已就绪
      running += 1;
      resolve(a)
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

  function currentAudio() { return ap && ap.list.audios[ap.list.index]; }

  function bindEvents() {
    // 列表里点到还没解析完的曲目：先解析，再切换（拦在 APlayer 自己的点击处理之前）
    container.addEventListener('click', function (e) {
      if (!ap) return;
      var li = e.target && e.target.closest ? e.target.closest('.aplayer-list li') : null;
      if (!li || !li.parentNode) return;

      var idx = Array.prototype.indexOf.call(li.parentNode.children, li);
      var a = audios[idx];
      if (!a || isReady(a)) return;   // 已就绪 → 交给 APlayer

      e.preventDefault();
      e.stopPropagation();
      ap.notice('正在解析音源…', 1500, 0.95);
      resolve(a).then(function () {
        if (audios[idx] !== a) return;            // 期间换了歌单
        ap.list.switch(idx);
        safePlay();
      }).catch(function () {
        if (audios[idx] === a) ap.notice('《' + a.name + '》暂无可用音源', 2600);
      });
    }, true);

    // 上一首 / 下一首 / 自动切歌时兜底解析
    ap.on('listswitch', function (info) {
      var i = info.index;
      var a = audios[i];
      if (!a || isReady(a)) return;
      ap.notice('正在解析音源…', 1200, 0.95);
      resolve(a).then(function () {
        if (currentAudio() !== a) return;
        ap.list.switch(i);
        safePlay();
      }).catch(function () {
        if (currentAudio() !== a) return;
        ap.notice('该曲目暂无可用音源，已跳过', 2000);
        setTimeout(function () { if (currentAudio() === a) ap.skipForward(); }, 900);
      });
    });

    // 音频地址是带时间戳的临时直链，久放会过期：失败时重解析一次
    ap.on('error', function () {
      var a = currentAudio();
      if (!a || !a.url || a._alt) return;         // 还没解析 / 用的是备用地址：交给 listswitch 和 APlayer 自己处理
      if (a._retried) { a._retried = false; return; }
      a._retried = true;
      a.url = '';                    // 强制重新取直链
      resolve(a).then(function () {
        var i = ap.list.audios.indexOf(a);
        if (i < 0) return;
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
    window.__mistMusic = ap;         // 给看板娘用：鼠标停在她身上时可以切歌 / 暂停
    document.dispatchEvent(new Event('mistgarden:music-ready'));
  }

  /* ======================= 歌单选择框 ======================= */
  function readStore() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null') || {}; } catch (e) { return {}; }
  }
  function writeStore(patch) {
    var s = readStore();
    for (var k in patch) s[k] = patch[k];
    try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (e) {}
  }
  function preset(key) {
    for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i].key === key) return PRESETS[i];
    return null;
  }
  function selLabel(sel) {
    if (!sel) return '歌单';
    if (sel.key !== 'custom') return preset(sel.key).label;
    return (info.custom && info.custom.name) || (PLATFORMS[sel.platform] + '歌单');
  }

  // 从歌单 ID / 分享链接里取出 ID，顺便按域名认出平台
  function parseInput(text) {
    text = String(text || '').trim();
    var platform = /163\.com|163cn\.tv/i.test(text) ? 'netease'
                 : /qq\.com/i.test(text) ? 'tencent'
                 : /kugou\.com/i.test(text) ? 'kugou'
                 : /kuwo\.cn/i.test(text) ? 'kuwo' : '';
    var id = '';
    if (/^\d{3,}$/.test(text)) id = text;
    else {
      var m = text.match(/[?&#](?:id|disstid|specialid)=(\d+)/i) ||
              text.match(/\/(?:playlist|special\/single|single|songlist)\/(\d+)/i);
      if (m) id = m[1];
      else {
        var all = text.match(/\d{5,}/g);
        if (all) id = all.sort(function (a, b) { return b.length - a.length; })[0];
      }
    }
    return { platform: platform, id: id };
  }

  var ui = null;
  function buildPicker() {
    var panel = container.closest('.music-player') || container.parentNode;
    var saved = readStore();
    var wrap = document.createElement('div');
    wrap.className = 'pl-picker';
    wrap.innerHTML =
      '<button type="button" class="pl-current" aria-expanded="false" aria-controls="plMenu" title="切换歌单">' +
        '<span class="pl-icon" aria-hidden="true">🎶</span><span class="pl-name">歌单</span>' +
        '<span class="pl-count"></span><span class="pl-caret" aria-hidden="true">▾</span>' +
      '</button>' +
      '<div class="pl-menu" id="plMenu" role="radiogroup" aria-label="选择歌单" hidden>' +
        PRESETS.map(function (p) {
          return '<button type="button" class="pl-opt" role="radio" aria-checked="false" data-key="' + p.key + '">' +
            '<span class="pl-opt-label">' + p.label + '</span><span class="pl-opt-desc">' + p.desc + '</span></button>';
        }).join('') +
        '<button type="button" class="pl-opt" role="radio" aria-checked="false" data-key="custom">' +
          '<span class="pl-opt-label">自定义歌单</span><span class="pl-opt-desc">先选平台，再填歌单 ID 或分享链接</span></button>' +
        '<form class="pl-form" novalidate>' +
          '<select class="pl-platform" aria-label="歌单平台">' +
            Object.keys(PLATFORMS).map(function (k) { return '<option value="' + k + '">' + PLATFORMS[k] + '</option>'; }).join('') +
          '</select>' +
          '<input class="pl-input" type="text" inputmode="url" autocomplete="off" spellcheck="false" placeholder="歌单 ID 或链接" aria-label="歌单 ID 或分享链接">' +
          '<button type="submit" class="pl-go">加载</button>' +
        '</form>' +
        '<p class="pl-msg" role="status" aria-live="polite"></p>' +
      '</div>';
    panel.insertBefore(wrap, container);

    ui = {
      wrap: wrap,
      btn: wrap.querySelector('.pl-current'),
      name: wrap.querySelector('.pl-name'),
      count: wrap.querySelector('.pl-count'),
      menu: wrap.querySelector('.pl-menu'),
      opts: Array.prototype.slice.call(wrap.querySelectorAll('.pl-opt')),
      form: wrap.querySelector('.pl-form'),
      platform: wrap.querySelector('.pl-platform'),
      input: wrap.querySelector('.pl-input'),
      go: wrap.querySelector('.pl-go'),
      msg: wrap.querySelector('.pl-msg')
    };
    if (saved.customPlatform && PLATFORMS[saved.customPlatform]) ui.platform.value = saved.customPlatform;
    if (saved.customId) ui.input.value = saved.customId;

    ui.btn.addEventListener('click', function () { toggleMenu(ui.menu.hidden); });
    ui.opts.forEach(function (b) {
      b.addEventListener('click', function () {
        var key = b.dataset.key;
        if (key === 'custom') { ui.input.focus(); ui.input.select(); return; }   // 自定义：填好再点「加载」
        var p = preset(key);
        choose({ key: key, platform: p.platform, id: p.id });
      });
    });
    ui.input.addEventListener('input', function () {
      var r = parseInput(ui.input.value);
      if (r.platform && PLATFORMS[r.platform]) ui.platform.value = r.platform;   // 粘贴链接时自动切换平台
    });
    ui.form.addEventListener('submit', function (e) {
      e.preventDefault();
      var r = parseInput(ui.input.value);
      if (r.platform === 'kuwo') { say('暂不支持酷我歌单，可以换成网易云、QQ 音乐或酷狗的歌单', true); return; }
      if (!r.id) {
        say(ui.input.value.trim()
          ? '没认出歌单 ID。短链接请先在浏览器里打开，再复制地址栏里的完整链接'
          : '先填歌单 ID 或分享链接', true);
        ui.input.focus();
        return;
      }
      var platform = ui.platform.value;
      writeStore({ customPlatform: platform, customId: ui.input.value.trim() });
      choose({ key: 'custom', platform: platform, id: r.id });
    });
    // 点播放器外面 / 按 Esc 收起菜单
    document.addEventListener('pointerdown', function (e) {
      if (!ui.menu.hidden && !wrap.contains(e.target)) toggleMenu(false);
    }, true);
    wrap.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !ui.menu.hidden) { e.stopPropagation(); toggleMenu(false); ui.btn.focus(); }
    });
    refreshPicker();
  }

  function toggleMenu(open) {
    if (!ui) return;
    ui.menu.hidden = !open;
    ui.btn.setAttribute('aria-expanded', String(open));
    ui.wrap.classList.toggle('is-open', open);
    if (open) { say(''); var on = ui.menu.querySelector('.pl-opt[aria-checked="true"]'); if (on) on.focus(); }
  }

  function say(text, isError) {
    if (!ui) return;
    ui.msg.textContent = text || '';
    ui.msg.classList.toggle('is-error', !!isError);
  }

  var loadingKey = null;
  function refreshPicker() {
    if (!ui) return;
    var busy = !!loadingKey;
    ui.wrap.classList.toggle('is-loading', busy);
    ui.name.textContent = busy ? '正在加载歌单…' : selLabel(current);
    var n = current && info[current.key] && info[current.key].count;
    ui.count.textContent = !busy && n ? n + ' 首' : '';
    ui.opts.forEach(function (b) {
      var key = b.dataset.key;
      b.setAttribute('aria-checked', String(!!current && current.key === key));
      b.classList.toggle('is-loading', loadingKey === key);
      b.disabled = busy;
      var d = b.querySelector('.pl-opt-desc');
      var p = preset(key);
      if (p && info[key] && info[key].name && key === 'default') d.textContent = p.desc + ' · ' + info[key].name;
    });
    ui.go.disabled = busy;
    ui.go.textContent = loadingKey === 'custom' ? '加载中…' : '加载';
  }

  // 切换歌单：取歌单 → 先解析第一首 → 整体换掉 APlayer 的列表并开始播放；失败就留在原来的歌单
  function choose(sel) {
    if (loadingKey) return;
    if (current && sel.key === current.key && sel.platform === current.platform && sel.id === current.id) {
      toggleMenu(false);
      return;
    }
    var my = ++gen;
    loadingKey = sel.key;
    say(sel.platform === 'netease' ? '' : '正在读取' + PLATFORMS[sel.platform] + '歌单，播放时会自动匹配网易云的完整音源');
    refreshPicker();
    loadPlaylist(sel).then(function (res) {
      if (my !== gen) return null;
      return resolveFirst(res.tracks).then(function () { return res; });
    }).then(function (res) {
      if (!res || my !== gen) return;
      loadingKey = null;
      info[sel.key] = { name: res.name || (sel.key === 'custom' ? PLATFORMS[sel.platform] + '歌单 ' + sel.id : ''), count: res.tracks.length };
      current = sel;
      writeStore({ key: sel.key, platform: sel.platform, id: sel.id });
      audios = res.tracks;
      queue = [];
      if (!ap) {                     // 启动时播放器没能初始化（比如默认歌单当时加载失败）：现在补上
        initPlayer();
      } else {
        ap.list.clear();             // clear + add 同步完成：旧地址的加载直接作废，不会触发 APlayer 的「出错跳下一首」
        ap.list.add(audios);         // 列表原本是空的，add 会自动切到第一首
      }
      safePlay();
      say('');
      toggleMenu(false);
      refreshPicker();
      ap.notice('已切换到「' + selLabel(sel) + '」', 2000, 0.95);
    }).catch(function (err) {
      if (my !== gen) return;
      console.warn('[music] 歌单加载失败：', err);
      loadingKey = null;
      refreshPicker();
      say(sel.key === 'custom'
        ? '没能加载这个歌单：请确认平台选对了、歌单是公开的（' + (err && err.message || err) + '）'
        : '歌单加载失败，稍后再试试吧（' + (err && err.message || err) + '）', true);
    });
  }

  // 歌单开头几首可能都没有音源：往后找，直到有一首能播（最多试 5 首），都不行就算失败
  function resolveFirst(tracks) {
    var i = 0;
    function next() {
      if (i >= Math.min(5, tracks.length)) return Promise.reject(new Error('歌单开头的歌都没有可用音源'));
      var a = tracks[i++];
      return resolve(a).catch(function () {
        tracks.splice(tracks.indexOf(a), 1);   // 放不了的先拿掉，别让它排在第一首
        i--;
        return next();
      });
    }
    return next();
  }

  /* ======================= 启动 ======================= */
  function boot() {
    buildPicker();
    var saved = readStore();
    var def = preset('default');
    var sel = { key: 'default', platform: def.platform, id: def.id };
    if (saved.key === 'custom' && saved.platform && PLATFORMS[saved.platform] && saved.id) {
      sel = { key: 'custom', platform: saved.platform, id: String(saved.id) };
    } else if (saved.key && preset(saved.key)) {
      var p = preset(saved.key);
      sel = { key: p.key, platform: p.platform, id: p.id };
    }

    function start(s) {
      loadingKey = s.key;
      refreshPicker();
      return loadPlaylist(s).then(function (res) {
        return resolveFirst(res.tracks).then(function () { return res; });
      }).then(function (res) {
        loadingKey = null;
        current = s;
        audios = res.tracks;
        info[s.key] = { name: res.name || (s.key === 'custom' ? PLATFORMS[s.platform] + '歌单 ' + s.id : ''), count: res.tracks.length };
        refreshPicker();
      });
    }

    start(sel).catch(function (err) {
      if (sel.key === 'default') throw err;
      // 上次选的歌单打不开了（被删 / 变私密 / 接口挂了）：退回默认歌单
      console.warn('[music] 上次的歌单加载失败，改用默认歌单：', err);
      sel = { key: 'default', platform: def.platform, id: def.id };
      return start(sel).then(function () {
        say('上次选的歌单加载失败，已换回默认歌单', true);
      });
    }).then(initPlayer).catch(function (err) {
      console.warn('[music] 播放器初始化失败：', err);
      loadingKey = null;
      refreshPicker();
      say('歌单加载失败，可以换一个歌单试试', true);
      container.textContent = '🎵 音源加载失败';
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
