(function () {
  // ------------------------------ helpers ------------------------------
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, m => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  }[m]));

  // Elements
  const v = $('v');
  const a = $('a');
  const listEl = $('list');
  const nowTitle = $('nowTitle');
  const counter = $('counter');
  const spinner = $('spinner');
  const stage = $('stage');

  const MEDIA_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? ''
    : 'https://media.rootfox.cc/coub/';

  function mediaUrl(path) {
    if (!path) return path;
    if (/^https?:\/\//i.test(path)) return path;
    if (!MEDIA_BASE) return path;
    return MEDIA_BASE + path.replace(/^videos\//, '');
  }

  // State
  let items = []; // {video, audio?, title?, permalink?}
  let idx = 0;
  let syncRaf = 0;
  let watchdogTimer = 0;

  // ------------------------------ i18n ------------------------------
  const STR = {
    en: {
      prev: '↑ Prev',
      next: 'Next ↓',
      playPause: '▶︎ / ❚❚',
      fullscreen: '⤢ Fullscreen',
      hotkeys: '↑/↓ — navigation · Space — play/pause · M — mute · F — fullscreen · H — home',
      untitled: '(untitled)'
    },
    ru: {
      prev: '↑ Пред.',
      next: 'След. ↓',
      playPause: '▶︎ / ❚❚',
      fullscreen: '⤢ Во весь экран',
      hotkeys: '↑/↓ — навигация · Space — play/pause · M — mute · F — fullscreen · H — в начало',
      untitled: '(без названия)'
    }
  };
  const SUP_LANGS = ['en', 'ru'];

  function pickLang() {
    const saved = localStorage.getItem('lang');
    if (saved && SUP_LANGS.includes(saved)) return saved;
    const nav = (navigator.language || navigator.userLanguage || 'en').slice(0, 2).toLowerCase();
    return SUP_LANGS.includes(nav) ? nav : 'en';
  }

  let LANG = pickLang();
  document.documentElement.lang = LANG;

  function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const val = STR[LANG]?.[key];
      if (val) el.textContent = val;
    });
    const chips = Array.from(document.querySelectorAll('#lang .chip'));
    chips.forEach(c => c.classList.toggle('active', c.dataset.lang === LANG));
  }

  applyI18n();
  document.getElementById('lang').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    const next = btn.dataset.lang;
    if (SUP_LANGS.includes(next)) {
      LANG = next;
      localStorage.setItem('lang', LANG);
      document.documentElement.lang = LANG;
      applyI18n();
      buildList();
    }
  });

  // ------------------------------ playlists (tabs) ------------------------------
  const tabs = document.getElementById('plTabs');
  const tabBtns = tabs ? Array.from(tabs.querySelectorAll('.tab')) : [];

  function setActiveTab(btn) {
    tabBtns.forEach(b => b.classList.toggle('active', b === btn));
  }

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const url = btn.dataset.manifest;
      if (!url) return;
      loadManifestUrl(url).catch(() => {
      });
      setActiveTab(btn);
    });
  });

  (function initPlaylist() {
    const m = 'normal.json';
    if (m) {
      loadManifestUrl(m).catch(() => {
      });
      const match = tabBtns.find(b => b.dataset.manifest === m);
      if (match) setActiveTab(match);
      return;
    }
    const def = tabBtns.find(b => b.dataset.name === 'Normal') || tabBtns[0];
    if (def) def.click();
  })();

  async function loadManifestUrl(url) {
    showSpinner(true);
    const res = await fetch(url, {cache: 'no-store'});
    if (!res.ok) {
      showSpinner(false);
      throw new Error('manifest load error');
    }
    applyManifest(await res.json());
    showSpinner(false);
  }

  function normEntry(x) {
    const video = x.videoOut || x.loopedPath || x.video || x.paths?.video || null;
    const audio = x.audioOut || x.audio || x.paths?.audio || null;
    const title = x.title || x._raw?.title || x.name || '';
    const permalink = x.eff_permalink || x.permalink || x._raw?.permalink || '';
    if (!video) return null;
    return {video, audio, title, permalink};
  }

  function applyManifest(json) {
    const arr = Array.isArray(json) ? json : (json.items || []);
    items = arr.map(normEntry).filter(Boolean);
    buildList();
    if (items.length) load(0);
  }

  function buildList() {
    listEl.innerHTML = '';
    items.forEach((m, i) => {
      const el = document.createElement('div');
      el.className = 'item';
      const title = `${m.title || ''}`.trim() || STR[LANG].untitled;
      el.innerHTML = `<div><strong>${escapeHtml(title)}</strong><div class="small">${escapeHtml(m.permalink || '')}</div></div><div class="small">${i + 1}/${items.length}${m.audio ? ' · 🎧' : ''}</div>`;
      el.onclick = () => load(i);
      listEl.appendChild(el);
    });
    updateActive();
  }

  function updateActive() {
    [...listEl.children].forEach((c, i) => c.classList.toggle('active', i === idx));
    counter.textContent = `${idx + 1} / ${items.length}`;
  }

  // ------------------------------ sync & anti-stutter ------------------------------
  function stopSync() {
    if (syncRaf) {
      cancelAnimationFrame(syncRaf);
      syncRaf = 0;
    }
  }

  function startSync() {
    stopSync();
    const loop = () => {
      const haveAudio = !!a.getAttribute('src') && isFinite(a.duration) && a.duration > 0;
      const vd = isFinite(v.duration) && v.duration > 0 ? v.duration : null;
      if (haveAudio && !a.paused && !a.ended && vd) {
        const target = a.currentTime % vd;
        const drift = v.currentTime - target;
        if (Math.abs(drift) > 0.06) {
          try {
            v.currentTime = target;
          } catch {
          }
        }
      }
      if (haveAudio && a.ended) {
        v.pause();
      }
      syncRaf = requestAnimationFrame(loop);
    };
    syncRaf = requestAnimationFrame(loop);
  }

  function showSpinner(on) {
    $('spinner').classList.toggle('show', !!on);
  }

  function startWatchdog() {
    stopWatchdog();
    let lastT = -1, lastWall = performance.now();
    watchdogTimer = setInterval(() => {
      if (v.paused || v.readyState === 0) return;
      const t = v.currentTime;
      const now = performance.now();
      const progressed = Math.abs(t - lastT) > 0.016;
      const lowReady = v.readyState <= 2;
      if (!progressed && lowReady && (now - lastWall) > 350) {
        onVideoStutter();
      } else if (progressed && v.readyState >= 3) {
        onVideoResumed();
        lastWall = now;
      }
      lastT = t;
    }, 250);
  }

  function stopWatchdog() {
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = 0;
    }
  }

  function onVideoStutter() {
    if (!a.paused) {
      a.pause();
    }
    showSpinner(true);
  }

  function onVideoResumed() {
    showSpinner(false);
    if (a.src && a.paused && !a.ended) {
      a.play().catch(() => {
      });
    }
  }

  // ------------------------------ load & controls ------------------------------
  async function load(i) {
    if (i < 0 || i >= items.length) return;
    idx = i;
    updateActive();
    const it = items[i];

    pauseBoth();
    stopSync();
    stopWatchdog();
    v.removeAttribute('src');
    a.removeAttribute('src');
    v.load();
    a.load();
    showSpinner(true);

    v.src = mediaUrl(it.video);
    v.muted = true;
    v.loop = true;

    if (it.audio) a.src = mediaUrl(it.audio);

    const title = `${it.title || ''}`.trim() || (STR[LANG]?.untitled || '(untitled)');
    nowTitle.textContent = title;

    const handleWaiting = () => onVideoStutter();
    const handlePlaying = () => onVideoResumed();
    v.addEventListener('waiting', handleWaiting, {once: false});
    v.addEventListener('stalled', handleWaiting, {once: false});
    v.addEventListener('suspend', handleWaiting, {once: false});
    v.addEventListener('canplay', handlePlaying, {once: false});
    v.addEventListener('playing', handlePlaying, {once: false});
    v.addEventListener('canplaythrough', handlePlaying, {once: false});

    const need = it.audio ? 2 : 1;
    let ready = 0;
    const done = () => {
      if (++ready >= need) start();
    };
    v.onloadedmetadata = done;
    if (it.audio) a.onloadedmetadata = done;
    setTimeout(done, 1200);

    async function start() {
      try {
        await v.play();
      } catch {
      }
      if (it.audio) {
        try {
          await a.play();
        } catch {
        }
      }
      startSync();
      startWatchdog();
      showSpinner(false);
    }
  }

  function pauseBoth() {
    v.pause();
    a.pause();
  }

  function playBoth() {
    v.play().catch(() => {
    });
    a.play().catch(() => {
    });
    startSync();
  }

  $('prev').onclick = () => load(idx - 1);
  $('next').onclick = () => load(idx + 1);
  $('fullscreen').onclick = () => stage.requestFullscreen?.();
  $('playPause').onclick = () => (a.paused ? playBoth() : pauseBoth());

  window.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
    const k = e.key.toLowerCase();
    if (k === 'arrowdown') {
      e.preventDefault();
      load(idx + 1);
    } else if (k === 'arrowup') {
      e.preventDefault();
      load(idx - 1);
    } else if (k === ' ') {
      e.preventDefault();
      (a.paused ? playBoth() : pauseBoth());
    } else if (k === 'm') {
      a.muted = !a.muted;
    } else if (k === 'f') {
      stage.requestFullscreen?.();
    } else if (k === 'h') {
      if (isFinite(a.duration)) a.currentTime = 0;
      if (isFinite(v.duration)) v.currentTime = 0;
    }
  });

})();
