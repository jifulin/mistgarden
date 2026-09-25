/*!
 * 逐字歌词 · mistgarden
 *
 * 音乐播放时，用当前歌词接管首页「一言」的位置；暂停 / 停止后自动还原成一言。
 *
 * 关于「逐字」：音源接口（music-api.gdstudio.xyz）只返回行级 LRC，
 * 拿不到网易云那种带字级时间轴的 yrc，所以填充进度是按本行时长线性插值模拟的：
 *     进度 = (当前播放时间 - 本行起点) / (下一行起点 - 本行起点)
 * 再用 background-clip:text 的硬边渐变把这一行从左往右填过去，观感与卡拉 OK 一致。
 * 以后若接口能给 yrc，只要把 parseLrc 换成解析字级时间轴、并在 tick 里按字算进度即可，
 * 渲染层不用动。
 *
 * 依赖：index.html 里的 #hitokoto / #hitokotoText，以及 assets/player.js 暴露的
 *       window.__mistMusic 与 mistgarden:music-ready 事件。播放器没加载时本文件完全静默。
 */
(function () {
  'use strict';

  var host = document.getElementById('hitokoto');
  var textEl = document.getElementById('hitokotoText');
  if (!host || !textEl) return;

  // 歌词层：和一言同处一个按钮内，靠 .is-lyric 切换谁可见
  var lineEl = document.createElement('span');
  lineEl.className = 'hk-lyric';
  host.appendChild(lineEl);

  var ap = null;
  var audio = null;
  var lyrics = [];          // [{ t: 秒, text: '...' }]
  var loadedFor = null;     // 已经取过歌词的那个曲目对象
  var lrcToken = 0;         // 异步竞态保护：只认最后一次请求
  var curIndex = -1;
  var rafId = 0;
  var offTimer = 0;
  var active = false;

  /* ======================= LRC 解析 ======================= */

  var TIME_RE = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;
  // 制作名单不是歌词，过滤掉，否则开头十几秒全是「作词 : xxx」「联合出品：xxx」。
  // 判定方式：行首 14 字以内出现冒号，且冒号前缀里含制作类关键词。
  // 只看前缀能避免误伤正文（「他说：…」这种不含关键词，会被保留）。
  var CREDIT_HEAD_RE = /^([^:：]{1,14})[:：]/;
  var CREDIT_WORD_RE = /(作词|作曲|编曲|作编曲|制作|监制|出品|发行|企划|策划|统筹|录音|混音|母带|和声|人声|吉他|贝斯|鼓手|键盘|弦乐|合成器|营销|宣传|文案|设计|封面|海报|经纪|厂牌|版权|词|曲|Lyric|Compos|Arrang|Produc|Mix|Master|Record|Vocal|Guitar|Bass|Drum)/i;
  var RIGHTS_RE = /(版权|未经\S*许可|保留.*权利|All\s+Rights\s+Reserved)/i;

  function isCredit(s) {
    var m = CREDIT_HEAD_RE.exec(s);
    return !!(m && CREDIT_WORD_RE.test(m[1])) || RIGHTS_RE.test(s);
  }

  function parseLrc(text) {
    var out = [];
    String(text || '').split(/\r?\n/).forEach(function (raw) {
      TIME_RE.lastIndex = 0;
      var times = [];
      var m;
      while ((m = TIME_RE.exec(raw))) {
        times.push(parseInt(m[1], 10) * 60 + parseFloat(String(m[2]).replace(':', '.')));
      }
      if (!times.length) return;
      var body = raw.replace(TIME_RE, '').trim();
      if (!body || isCredit(body)) return;
      for (var i = 0; i < times.length; i++) out.push({ t: times[i], text: body });
    });
    out.sort(function (a, b) { return a.t - b.t; });
    // 万一整首歌被判成名单（纯伴奏 / 全是制作信息），宁可不过滤也别空着
    return out;
  }

  // APlayer 自己已经解析过一份，能用就省一次请求
  function fromAPlayer() {
    try {
      var arr = ap.lrc && ap.lrc.lyrics && ap.lrc.lyrics[ap.list.index];
      if (!arr || arr.length < 2) return null;
      var out = [];
      for (var i = 0; i < arr.length; i++) {
        var t = Number(arr[i][0]);
        var s = String(arr[i][1] || '').trim();
        if (!isFinite(t) || !s || isCredit(s)) continue;
        out.push({ t: t, text: s });
      }
      return out.length ? out : null;
    } catch (e) {
      return null;
    }
  }

  function currentTrack() {
    try { return ap.list.audios[ap.list.index]; } catch (e) { return null; }
  }

  function loadLyrics(force) {
    var a = currentTrack();
    if (!a) return;
    if (!force && a === loadedFor) return;
    loadedFor = a;
    curIndex = -1;
    lyrics = [];
    var token = ++lrcToken;

    var quick = fromAPlayer();
    if (quick) { lyrics = quick; return; }
    if (!a.lrc) return;                       // 音源还没解析完，等 listswitch / loadedmetadata 再来

    fetch(a.lrc).then(function (r) {
      return r.ok ? r.text() : '';
    }).then(function (txt) {
      if (token !== lrcToken) return;         // 期间已经切歌了
      lyrics = parseLrc(txt);
    }).catch(function () {});
  }

  /* ======================= 渲染 ======================= */

  function songLabel() {
    var a = currentTrack();
    if (!a) return '♪ 正在播放';
    return '♪ ' + (a.name || '未知曲目') + (a.artist ? ' — ' + a.artist : '');
  }

  function setLine(text) {
    if (lineEl.textContent !== text) lineEl.textContent = text;
  }

  function setProgress(p) {
    lineEl.style.setProperty('--lrc-p', (Math.max(0, Math.min(1, p)) * 100).toFixed(2) + '%');
  }

  // 找出当前时间落在第几行（二分）
  function indexAt(t) {
    var lo = 0, hi = lyrics.length - 1, res = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (lyrics[mid].t <= t) { res = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return res;
  }

  function tick() {
    rafId = 0;
    if (!active || !audio) return;

    if (!lyrics.length) {
      if (curIndex !== -2) { curIndex = -2; setLine(songLabel()); }
      setProgress(1);
      return schedule();
    }

    var t = audio.currentTime || 0;
    var i = indexAt(t);

    if (i < 0) {
      // 前奏：先亮着歌名，进度条走前奏占比
      if (curIndex !== -1) { curIndex = -1; setLine(songLabel()); }
      setProgress(lyrics[0].t > 0 ? t / lyrics[0].t : 1);
      return schedule();
    }

    var line = lyrics[i];
    var next = lyrics[i + 1];
    var end = next ? next.t : (audio.duration || line.t + 6);
    // 间奏可能长达几十秒，填充时长封顶，免得一行字慢吞吞填半分钟
    var span = Math.max(0.3, Math.min(end - line.t, 8));

    if (i !== curIndex) { curIndex = i; setLine(line.text); }
    setProgress((t - line.t) / span);
    schedule();
  }

  function schedule() {
    if (!rafId && active) rafId = requestAnimationFrame(tick);
  }

  /* ======================= 接管 / 还原 ======================= */

  function activate() {
    clearTimeout(offTimer);
    if (active) return;
    active = true;
    curIndex = -3;                                  // 强制下一帧重画
    host.classList.add('is-lyric');
    host.title = '正在播放 · 显示歌词（点击可刷新底下的一言）';
    schedule();
  }

  function deactivate() {
    if (!active) return;
    active = false;
    host.classList.remove('is-lyric');
    host.title = '点击刷新';
    lineEl.textContent = '';
    curIndex = -1;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  }

  // 切歌瞬间会触发 ended/pause，直接还原会闪一下一言，延迟确认
  function deferOff() {
    clearTimeout(offTimer);
    offTimer = setTimeout(function () {
      if (!audio || audio.paused || audio.ended) deactivate();
    }, 600);
  }

  function bind(player) {
    if (ap || !player || !player.audio) return;
    ap = player;
    audio = ap.audio;

    ['play', 'playing'].forEach(function (ev) {
      audio.addEventListener(ev, function () { loadLyrics(); activate(); });
    });
    ['pause', 'ended', 'emptied'].forEach(function (ev) {
      audio.addEventListener(ev, deferOff);
    });
    audio.addEventListener('loadedmetadata', function () { loadLyrics(true); });
    audio.addEventListener('seeked', function () { curIndex = -3; schedule(); });

    try {
      ap.on('listswitch', function () { setTimeout(function () { loadLyrics(true); }, 0); });
    } catch (e) {}

    // 页面切到后台时停掉 rAF，回来再续上
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      } else {
        schedule();
      }
    });

    if (!audio.paused) { loadLyrics(); activate(); }
  }

  if (window.__mistMusic) bind(window.__mistMusic);
  else document.addEventListener('mistgarden:music-ready', function () { bind(window.__mistMusic); });
})();
