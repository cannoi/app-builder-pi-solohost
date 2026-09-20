(() => {
  const $ = (id) => document.getElementById(id);

  const els = {
    chrome: $('chrome'),
    greeting: $('greeting'),
    form: $('search-form'),
    input: $('search-input'),
    suggest: $('suggest'),
    constellation: $('constellation'),
    sky: $('sky'),
    statusLine: $('status-line'),
    statusText: $('status-text'),
    viewHome: $('view-home'),
    viewBrowser: $('view-browser'),
    iframe: $('browser-iframe'),
    browserError: $('browser-error'),
    browserErrorTitle: $('browser-error-title'),
    browserErrorDesc: $('browser-error-desc'),
    browserErrorRetry: $('browser-error-retry'),
    tabs: $('tabs'),
    back: $('btn-back'),
    forward: $('btn-forward'),
    reload: $('btn-reload'),
    neu: $('btn-new'),
    glow: $('pointer-glow'),
    toast: $('toast')
  };

  const ICONS = {
    calculator: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="3.5" width="14" height="17" rx="3"/><path d="M8 8h8M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01"/></svg>',
    music: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V6l10-2v12"/><circle cx="7" cy="18" r="2.4"/><circle cx="17" cy="16" r="2.4"/></svg>',
    ai: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="3.2"/><path d="M12 4v2.2M12 17.8V20M4 12h2.2M17.8 12H20M6.4 6.4l1.6 1.6M16 16l1.6 1.6M17.6 6.4 16 8M8 16l-1.6 1.6"/></svg>',
    node: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 3 20 7.5v9L12 21 4 16.5v-9L12 3z"/><path d="M12 12 20 7.5M12 12v9M12 12 4 7.5"/></svg>',
    favorites: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m12 4.5 2.2 4.6 5 .7-3.6 3.6.9 5.1L12 16.3 7.5 18.5l.9-5.1L4.8 9.8l5-.7L12 4.5z"/></svg>',
    apps: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 8h.01M12 8h.01M16 8h.01M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01"/></svg>',
    app: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="5" width="14" height="14" rx="4"/></svg>'
  };

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const lowPower = navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2;

  const state = {
    apps: [],
    bookmarks: [],
    history: [],
    tabs: [{ id: 'home', title: 'Home', url: '', kind: 'home' }],
    active: 'home',
    online: true,
    appsError: false,
    searchOpen: false,
    pendingUrl: null,
    loadTimer: null
  };

  function greeting() {
    const h = new Date().getHours();
    if (h < 5) return 'Good night';
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  }

  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => els.toast.classList.remove('show'), 1800);
  }

  function iconSvg(name) {
    const key = String(name || 'app').toLowerCase();
    return ICONS[key] || ICONS.app;
  }

  function measureSky() {
    const w = Math.max(
      els.sky.clientWidth,
      els.constellation.clientWidth,
      els.viewHome.clientWidth,
      window.innerWidth - 48
    );
    const h = Math.max(
      els.sky.clientHeight,
      els.constellation.clientHeight,
      Math.round(window.innerHeight * 0.38)
    );
    return { w, h };
  }

  function layoutFractions(n, narrow) {
    if (n <= 0) return [];
    const desktop = {
      1: [[0.50, 0.46]],
      2: [[0.38, 0.44], [0.62, 0.52]],
      3: [[0.34, 0.38], [0.66, 0.34], [0.52, 0.66]],
      4: [[0.33, 0.36], [0.64, 0.30], [0.44, 0.64], [0.70, 0.60]],
      5: [[0.30, 0.34], [0.52, 0.24], [0.74, 0.38], [0.38, 0.66], [0.66, 0.70]],
      6: [[0.28, 0.30], [0.50, 0.22], [0.74, 0.32], [0.34, 0.62], [0.56, 0.56], [0.76, 0.68]]
    };
    const mobile = {
      1: [[0.50, 0.42]],
      2: [[0.32, 0.38], [0.68, 0.50]],
      3: [[0.30, 0.30], [0.70, 0.38], [0.50, 0.68]],
      4: [[0.30, 0.28], [0.70, 0.34], [0.38, 0.64], [0.68, 0.72]],
      5: [[0.28, 0.24], [0.72, 0.30], [0.50, 0.48], [0.30, 0.72], [0.70, 0.76]],
      6: [[0.28, 0.22], [0.70, 0.26], [0.46, 0.44], [0.24, 0.66], [0.54, 0.70], [0.78, 0.62]]
    };
    const table = (narrow ? mobile : desktop)[n];
    if (table) return table.map(([x, y]) => ({ x, y }));
    const golden = Math.PI * (3 - Math.sqrt(5));
    return Array.from({ length: n }, (_, i) => {
      const t = i + 0.6;
      const r = 0.16 + Math.sqrt(t) * 0.055;
      const a = t * golden - 0.35;
      return {
        x: Math.min(0.86, Math.max(0.14, 0.5 + Math.cos(a) * r * 1.15)),
        y: Math.min(0.84, Math.max(0.16, 0.48 + Math.sin(a) * r * 0.72))
      };
    });
  }

  function layoutPositions(n, width, height) {
    const padX = 56;
    const padY = 44;
    const w = Math.max(320, width);
    const h = Math.max(220, height);
    if (n <= 0) return [];

    const narrow = w < 700;
    const desktop = {
      1: [[0.50, 0.46]],
      2: [[0.38, 0.44], [0.62, 0.52]],
      3: [[0.34, 0.38], [0.66, 0.34], [0.52, 0.66]],
      4: [[0.33, 0.36], [0.64, 0.30], [0.44, 0.64], [0.70, 0.60]],
      5: [[0.30, 0.34], [0.52, 0.24], [0.74, 0.38], [0.38, 0.66], [0.66, 0.70]],
      6: [[0.28, 0.30], [0.50, 0.22], [0.74, 0.32], [0.34, 0.62], [0.56, 0.56], [0.76, 0.68]]
    };
    const mobile = {
      1: [[0.50, 0.42]],
      2: [[0.32, 0.38], [0.68, 0.50]],
      3: [[0.30, 0.30], [0.70, 0.38], [0.50, 0.68]],
      4: [[0.30, 0.28], [0.70, 0.34], [0.38, 0.64], [0.68, 0.72]],
      5: [[0.28, 0.24], [0.72, 0.30], [0.50, 0.48], [0.30, 0.72], [0.70, 0.76]],
      6: [[0.28, 0.22], [0.70, 0.26], [0.46, 0.44], [0.24, 0.66], [0.54, 0.70], [0.78, 0.62]]
    };

    const presets = narrow ? mobile : desktop;
    if (presets[n]) {
      return presets[n].map(([x, y]) => ({
        x: Math.min(w - padX, Math.max(padX, x * w)),
        y: Math.min(h - padY, Math.max(padY, y * h))
      }));
    }

    const cx = w * 0.5;
    const cy = h * 0.48;
    const golden = Math.PI * (3 - Math.sqrt(5));
    const positions = [];
    for (let i = 0; i < n; i++) {
      const t = i + 0.6;
      const radius = 70 + Math.sqrt(t) * Math.min(w, h) * 0.10;
      const a = t * golden - 0.35;
      positions.push({
        x: Math.min(w - padX, Math.max(padX, cx + Math.cos(a) * radius * 1.15)),
        y: Math.min(h - padY, Math.max(padY, cy + Math.sin(a) * radius * 0.72))
      });
    }
    return separate(positions, 96, w, h, padX, padY);
  }

  function separate(positions, minDist, w, h, padX, padY) {
    const out = positions.map((p) => ({ ...p }));
    for (let pass = 0; pass < 8; pass++) {
      for (let i = 0; i < out.length; i++) {
        for (let j = i + 1; j < out.length; j++) {
          const dx = out[j].x - out[i].x;
          const dy = out[j].y - out[i].y;
          const d = Math.hypot(dx, dy) || 0.01;
          if (d < minDist) {
            const push = (minDist - d) / 2;
            const ux = dx / d;
            const uy = dy / d;
            out[i].x -= ux * push;
            out[i].y -= uy * push;
            out[j].x += ux * push;
            out[j].y += uy * push;
          }
        }
        out[i].x = Math.min(w - padX, Math.max(padX, out[i].x));
        out[i].y = Math.min(h - padY, Math.max(padY, out[i].y));
      }
    }
    return out;
  }

  function renderConstellation() {
    const host = els.constellation;
    const sky = measureSky();
    host.innerHTML = '';

    if (state.appsError) {
      host.innerHTML = `
        <div class="error-space">
          <div class="empty-mark">${iconSvg('apps')}</div>
          <h2>My Apps unavailable</h2>
          <p>The registry could not be reached. Browsing still works.</p>
          <button class="retry" type="button" id="retry-apps">Retry</button>
        </div>`;
      const retry = document.getElementById('retry-apps');
      if (retry) retry.addEventListener('click', () => loadApps());
      return;
    }

    if (!state.apps.length) {
      host.innerHTML = `
        <div class="empty-space">
          <div class="empty-mark">${iconSvg('apps')}</div>
          <h2>No apps yet</h2>
          <p>Apps installed on SoloHost will appear here.</p>
        </div>`;
      return;
    }

    const spots = layoutFractions(state.apps.length, window.matchMedia('(max-width: 720px)').matches);
    state.apps.forEach((app, i) => {
      const pos = spots[i] || { x: 0.5, y: 0.5 };
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'app-node';
      btn.style.left = `${pos.x * 100}%`;
      btn.style.top = `${pos.y * 100}%`;
      btn.dataset.route = app.route;
      btn.dataset.id = app.id;
      btn.setAttribute('aria-label', `${app.name}, ${app.status || 'unknown'}`);
      btn.innerHTML = `
        <span class="app-dot ${app.status || 'offline'}" aria-hidden="true"></span>
        <span class="app-glyph">${iconSvg(app.icon || app.id)}</span>
        <span class="app-label">${escapeHtml(app.name)}</span>`;
      btn.addEventListener('click', (e) => openApp(app, e.currentTarget));
      host.appendChild(btn);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function renderTabs() {
    els.tabs.innerHTML = '';
    state.tabs.forEach((tab) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tab' + (tab.id === state.active ? ' active' : '');
      b.textContent = tab.title;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', tab.id === state.active ? 'true' : 'false');
      b.addEventListener('click', () => activateTab(tab.id));
      els.tabs.appendChild(b);
    });
  }

  function activateTab(id) {
    const tab = state.tabs.find((t) => t.id === id);
    if (!tab) return;
    state.active = id;
    renderTabs();
    if (tab.kind === 'home') {
      showHome();
    } else {
      showBrowser(tab.url, false);
    }
  }

  function showHome() {
    document.body.classList.remove('browsing');
    els.chrome.classList.remove('browsing');
    els.viewBrowser.hidden = true;
    els.viewHome.hidden = false;
    els.input.value = '';
    els.input.placeholder = 'Search the Web';
    state.active = 'home';
    state.pendingUrl = null;
    clearLoadTimer();
    hideNetError();
    if (!state.tabs.some((t) => t.id === 'home')) {
      state.tabs.unshift({ id: 'home', title: 'Home', url: '', kind: 'home' });
    }
    renderTabs();
    requestAnimationFrame(renderConstellation);
  }

  const PAGE_LOAD_TIMEOUT = 12000;

  function hideNetError() {
    els.browserError.hidden = true;
  }

  function showNetError(kind) {
    if (kind === 'offline') {
      els.browserErrorTitle.textContent = 'Không có kết nối Internet';
      els.browserErrorDesc.textContent = 'Thiết bị hiện không có Internet. Kiểm tra kết nối mạng rồi thử lại.';
    } else {
      els.browserErrorTitle.textContent = 'Không thể tải trang';
      els.browserErrorDesc.textContent = 'Trang mất quá lâu để phản hồi hoặc không thể truy cập. Kiểm tra kết nối Internet rồi thử lại.';
    }
    els.browserError.hidden = false;
  }

  function clearLoadTimer() {
    if (state.loadTimer) {
      clearTimeout(state.loadTimer);
      state.loadTimer = null;
    }
  }

  function showBrowser(url, record) {
    document.body.classList.add('browsing');
    els.chrome.classList.add('browsing');
    els.viewHome.hidden = true;
    els.viewBrowser.hidden = false;
    els.input.value = url;
    els.input.placeholder = 'Search or enter website';
    state.pendingUrl = url;
    clearLoadTimer();

    if (!navigator.onLine) {
      els.iframe.src = 'about:blank';
      showNetError('offline');
    } else {
      hideNetError();
      els.iframe.src = url;
      state.loadTimer = setTimeout(() => {
        if (state.pendingUrl === url) showNetError('timeout');
      }, PAGE_LOAD_TIMEOUT);
    }
    if (record) remember(url);
  }

  const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?(\/\S*)?$/i;
  const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}(:\d{1,5})?(\/\S*)?$/;
  const LOCALHOST_RE = /^localhost(:\d{1,5})?(\/\S*)?$/i;

  function looksLikeWebAddress(str) {
    if (!str || /\s/.test(str)) return false;
    return LOCALHOST_RE.test(str) || IPV4_RE.test(str) || DOMAIN_RE.test(str);
  }

  function openUrl(raw, title) {
    let url = String(raw || '').trim();
    if (!url) return;
    if (url.startsWith('/')) {
      // internal app route, use as-is
    } else if (/^https?:\/\//i.test(url)) {
      // already a full URL, use as-is
    } else if (looksLikeWebAddress(url)) {
      url = 'https://' + url;
    } else {
      url = 'https://www.google.com/search?q=' + encodeURIComponent(url);
    }
    const name = title || prettyTitle(url);
    let tab = state.tabs.find((t) => t.url === url && t.kind === 'web');
    if (!tab) {
      tab = { id: 't' + Date.now(), title: name, url, kind: 'web' };
      state.tabs.push(tab);
    }
    state.active = tab.id;
    renderTabs();
    showBrowser(url, true);
  }

  function prettyTitle(url) {
    try {
      if (url.startsWith('/apps/')) {
        const id = url.split('/').pop();
        const app = state.apps.find((a) => a.id === id || a.route === url);
        return app ? app.name : id;
      }
      const u = new URL(url, location.origin);
      return u.hostname.replace(/^www\./, '');
    } catch {
      return url.slice(0, 18);
    }
  }

  function openApp(app, node) {
    const go = () => openUrl(app.route, app.name);
    if (reduceMotion || !node) return go();

    const rect = node.querySelector('.app-glyph').getBoundingClientRect();
    const ghost = document.createElement('div');
    ghost.className = 'opening-ghost';
    ghost.style.left = rect.left + 'px';
    ghost.style.top = rect.top + 'px';
    ghost.innerHTML = iconSvg(app.icon || app.id);
    document.body.appendChild(ghost);
    const destX = window.innerWidth / 2 - 28;
    const destY = window.innerHeight / 2 - 28;
    ghost.animate(
      [
        { transform: 'translate(0,0) scale(1)', opacity: 1 },
        { transform: `translate(${destX - rect.left}px, ${destY - rect.top}px) scale(1.08)`, opacity: 0 }
      ],
      { duration: 220, easing: 'cubic-bezier(.22,.7,.28,1)' }
    ).finished.then(() => {
      ghost.remove();
      go();
    }).catch(go);
  }

  function remember(url) {
    fetch('/api/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: prettyTitle(url), url })
    }).then(loadHistory).catch(() => {});
  }

  async function loadApps() {
    try {
      const res = await fetch('/api/apps');
      if (!res.ok) throw new Error('unavailable');
      const data = await res.json();
      state.apps = data.apps || [];
      state.appsError = false;
      setStatus(true);
    } catch {
      state.appsError = true;
      setStatus(false);
    }
    renderConstellation();
    if (state.searchOpen) renderSuggest();
  }

  async function loadBookmarks() {
    try {
      const res = await fetch('/api/bookmarks');
      const data = await res.json();
      state.bookmarks = data.bookmarks || [];
    } catch {
      state.bookmarks = [];
    }
  }

  async function loadHistory() {
    try {
      const res = await fetch('/api/history');
      const data = await res.json();
      state.history = data.history || [];
    } catch {
      state.history = [];
    }
  }

  async function loadStatus() {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      setStatus(data.solohost !== 'offline');
    } catch {
      setStatus(false);
    }
  }

  function setStatus(online) {
    state.online = online;
    els.statusLine.classList.toggle('online', online);
    els.statusLine.classList.toggle('offline', !online);
    els.statusText.textContent = online ? 'Online' : 'Offline';
  }

  function renderSuggest() {
    const q = els.input.value.trim().toLowerCase();
    const groups = [];

    const apps = state.apps.filter((a) => !q || a.name.toLowerCase().includes(q)).slice(0, 6);
    const favs = state.bookmarks.filter((b) => !q || (b.title + b.url).toLowerCase().includes(q)).slice(0, 4);
    const recents = state.history.filter((h) => !q || (h.title + h.url).toLowerCase().includes(q)).slice(0, 4);

    if (apps.length) groups.push({ label: 'My Apps', items: apps.map((a) => ({ label: a.name, url: a.route, kind: 'app', app: a })) });
    if (favs.length) groups.push({ label: 'Favorites', items: favs.map((b) => ({ label: b.title, url: b.url })) });
    if (recents.length) groups.push({ label: 'Recent', items: recents.map((h) => ({ label: h.title, url: h.url })) });

    if (!groups.length) {
      els.suggest.hidden = true;
      els.suggest.innerHTML = '';
      return;
    }

    els.suggest.hidden = false;
    els.suggest.innerHTML = '';
    groups.forEach((g) => {
      const lab = document.createElement('div');
      lab.className = 'suggest-label';
      lab.textContent = g.label;
      els.suggest.appendChild(lab);
      g.items.forEach((item) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip';
        b.textContent = item.label;
        b.addEventListener('click', () => {
          if (item.kind === 'app') openApp(item.app);
          else openUrl(item.url, item.label);
          closeSearch();
        });
        els.suggest.appendChild(b);
      });
    });
  }

  function openSearch() {
    state.searchOpen = true;
    els.form.classList.add('is-focus');
    els.input.placeholder = 'Search or enter website';
    renderSuggest();
  }

  function closeSearch() {
    state.searchOpen = false;
    els.form.classList.remove('is-focus');
    if (!document.body.classList.contains('browsing')) {
      els.input.placeholder = 'Search the Web';
    }
    els.suggest.hidden = true;
  }

  function submitSearch(ev) {
    ev.preventDefault();
    const val = els.input.value.trim();
    if (!val) {
      els.input.focus();
      return;
    }
    openUrl(val);
    closeSearch();
  }

  function bindPointer() {
    if (reduceMotion || coarse || lowPower) return;
    const glow = els.glow;
    let x = 0, y = 0, tx = 0, ty = 0, raf = 0;
    const loop = () => {
      x += (tx - x) * 0.16;
      y += (ty - y) * 0.16;
      glow.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      raf = requestAnimationFrame(loop);
    };
    window.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      tx = e.clientX;
      ty = e.clientY;
      glow.classList.add('on');
      if (!raf) raf = requestAnimationFrame(loop);
    }, { passive: true });
    window.addEventListener('pointerleave', () => glow.classList.remove('on'));
  }

  function bindParallax() {
    if (reduceMotion || coarse) return;
    const radial = document.querySelector('.atmosphere .radial');
    window.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      const dx = (e.clientX / window.innerWidth - 0.5) * 4;
      const dy = (e.clientY / window.innerHeight - 0.5) * 3;
      radial.style.transform = `translate(${dx}px, ${dy}px)`;
    }, { passive: true });
  }

  els.form.addEventListener('submit', submitSearch);
  els.input.addEventListener('focus', openSearch);
  els.input.addEventListener('input', renderSuggest);
  document.addEventListener('click', (e) => {
    if (!els.form.contains(e.target) && !els.suggest.contains(e.target)) closeSearch();
  });

  els.back.addEventListener('click', () => {
    const idx = state.tabs.findIndex((t) => t.id === state.active);
    if (idx > 0) activateTab(state.tabs[idx - 1].id);
    else showHome();
  });
  els.forward.addEventListener('click', () => {
    const idx = state.tabs.findIndex((t) => t.id === state.active);
    if (idx >= 0 && idx < state.tabs.length - 1) activateTab(state.tabs[idx + 1].id);
  });
  els.reload.addEventListener('click', () => {
    if (document.body.classList.contains('browsing') && els.iframe.src) {
      if (state.pendingUrl) {
        showBrowser(state.pendingUrl, false);
      } else {
        try { els.iframe.contentWindow.location.reload(); } catch { els.iframe.src = els.iframe.src; }
      }
    } else {
      loadApps();
      loadStatus();
    }
  });
  els.neu.addEventListener('click', showHome);

  els.iframe.addEventListener('load', () => {
    clearLoadTimer();
    if (els.iframe.src && els.iframe.src !== 'about:blank') hideNetError();
  });
  els.iframe.addEventListener('error', () => {
    clearLoadTimer();
    showNetError('timeout');
  });

  els.browserErrorRetry.addEventListener('click', () => {
    if (state.pendingUrl) showBrowser(state.pendingUrl, false);
  });

  window.addEventListener('online', () => {
    if (document.body.classList.contains('browsing') && state.pendingUrl) {
      showBrowser(state.pendingUrl, false);
    }
  });
  window.addEventListener('offline', () => {
    if (document.body.classList.contains('browsing')) {
      clearLoadTimer();
      els.iframe.src = 'about:blank';
      showNetError('offline');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'l' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      els.input.focus();
    }
    if (e.key === 'Escape') {
      if (state.searchOpen) closeSearch();
      else showHome();
    }
  });

  let resizeT;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(renderConstellation, 80);
  });

  els.greeting.textContent = greeting();
  bindPointer();
  bindParallax();
  renderTabs();
  loadApps();
  loadBookmarks();
  loadHistory();
  loadStatus();
  setInterval(() => {
    loadApps();
    loadStatus();
  }, 20000);
})();
