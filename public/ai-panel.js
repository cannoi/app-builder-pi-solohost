
/** Remote access card (QR) — local QR only, no external network */
async function renderRemoteAccessCard() {
  const chat = document.getElementById('aiChat');
  if (!chat) return;
  let card = document.getElementById('remoteAccessCard');
  if (!card) {
    card = document.createElement('div');
    card.id = 'remoteAccessCard';
    card.className = 'remote-access-card';
    card.innerHTML = '<div class="remote-head"><strong>📱 Remote access</strong> <button type="button" id="remoteToggle" class="small">Hide</button></div>'
      + '<div id="remoteBody"></div>';
    chat.prepend(card);
    card.querySelector('#remoteToggle')?.addEventListener('click', () => {
      const b = card.querySelector('#remoteBody');
      if (!b) return;
      const hide = b.style.display === 'none';
      b.style.display = hide ? '' : 'none';
      card.querySelector('#remoteToggle').textContent = hide ? 'Hide' : 'Show';
    });
  }
  const body = card.querySelector('#remoteBody');
  try {
    const info = await fetch('/api/remote/info').then((r) => r.json());
    if (!info.publicUrl) {
      body.innerHTML = '<p class="small">Public URL = http://PUBLIC_IP:HOST_PORT (SoloHost port) so phones can open Builder.</p>'
        + '<input id="remoteUrlInput" type="url" placeholder="https://example.com:8080" style="width:100%">'
        + '<button type="button" id="remoteUrlSave" class="primary">Save URL</button>';
      body.querySelector('#remoteUrlSave')?.addEventListener('click', async () => {
        const url = body.querySelector('#remoteUrlInput')?.value?.trim();
        if (!url) return;
        await fetch('/api/remote/url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ publicUrl: url }) });
        renderRemoteAccessCard();
      });
      return;
    }
    const warn = info.passwordEnabled
      ? '<p class="small">🔒 Same login password protects remote QR access.</p>'
      : '<p class="small warn">⚠ No login password (BUILDER_ACCESS_PASSWORD)</p><button type="button" id="remoteGenPass">Tạo mật khẩu / Create password</button>';
    body.innerHTML = warn
      + '<canvas id="remoteQrCanvas" width="160" height="160" aria-label="QR"></canvas>'
      + '<div class="small"><code id="remoteUrlText"></code></div>'
      + '<button type="button" id="remoteCopy">Copy URL</button>';
    const urlEl = body.querySelector('#remoteUrlText');
    if (urlEl) urlEl.textContent = info.publicUrl;
    const canvas = body.querySelector('#remoteQrCanvas');
    if (canvas && window.PafQR) window.PafQR.renderToCanvas(info.publicUrl, canvas, 160);
    body.querySelector('#remoteGenPass')?.addEventListener('click', async () => {
      try {
        const r = await fetch('/api/access/generate', { method: 'POST' });
        const data = await r.json();
        if (data.password) alert('Password (shown once): ' + data.password);
        renderRemoteAccessCard();
      } catch (e) { alert(e.message || e); }
    });
    body.querySelector('#remoteCopy')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(info.publicUrl); } catch {}
    });
  } catch (e) {
    body.textContent = 'Remote info unavailable: ' + (e.message || e);
  }
}

'use strict';
/**
 * Reference AI panel controller (from Snake Arcade).
 * Host app may copy to public/ai-panel.js and adapt gameContext() / executeActions().
 * Depends on: UniversalAI, UniversalFeedback, markup in example/ui/ai-panel.html, styles in ai-panel.css.
 */
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function flatten(src, prefix, out) {
  if (src == null) return;
  if (typeof src === 'string' || typeof src === 'number') {
    if (String(src).trim()) out.push([prefix || 'info', String(src)]);
    return;
  }
  if (Array.isArray(src)) { src.forEach((v, i) => flatten(v, prefix + ' ' + (i + 1), out)); return; }
  if (typeof src === 'object') Object.keys(src).forEach(k => flatten(src[k], prefix ? prefix + ' · ' + k : k, out));
}
function renderDonate(donate) {
  const box = document.getElementById('fbDonate');
  if (!box) return;
  const rows = [];
  flatten(donate, '', rows);
  if (!rows.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = '<strong>Ủng hộ tác giả</strong>' + rows.slice(0, 12).map(([k, v]) =>
    '<div class="fb-acc"><div class="fb-k">' + escapeHtml(k) + '</div><code class="fb-val">' + escapeHtml(v) + '</code></div>').join('');
}
function setUnread(n) {
  const badge = document.getElementById('aiBadge');
  const tabBadge = document.getElementById('fbTabBadge');
  const count = Number(n) || 0;
  if (badge) {
    if (count > 0) {
      badge.hidden = false;
      badge.style.display = '';
      badge.textContent = count > 9 ? '9+' : String(count);
    } else {
      badge.hidden = true;
      badge.style.display = 'none';
      badge.textContent = '';
    }
  }
  if (tabBadge) {
    if (count > 0) {
      tabBadge.hidden = false;
      tabBadge.style.display = '';
      tabBadge.textContent = count > 9 ? '9+' : String(count);
    } else {
      tabBadge.hidden = true;
      tabBadge.style.display = 'none';
      tabBadge.textContent = '';
    }
  }
}
function setFabVisible(visible) {
  const fab = document.getElementById('aiFab');
  if (!fab) return;
  fab.hidden = !visible;
  fab.style.display = visible ? '' : 'none';
}
function gameContext() {
  const projectSelect = document.getElementById('projectSelect');
  const projectId = projectSelect?.value || '';
  const projectLabel = projectSelect?.selectedOptions?.[0]?.textContent || '';
  return {
    app: 'App Builder — Pi SoloHost',
    projectId: projectId || null,
    projectName: projectLabel || null,
    surface: 'universal-panel',
  };
}
function executeActions(actions) {
  (actions || []).forEach(a => {
    if (!a || a.ok === false) return;
    const name = a.action || a.name;
    const value = a.value || (a.args && a.args.value) || '';
    if (name === 'open_tab') document.querySelector('.tab[data-tab="' + (value || 'chat') + '"]')?.click();
    if (name === 'show_lan') document.getElementById('s-conn')?.click();
    if (name === 'pause_hint') document.getElementById('s-pause')?.click();
  });
}

const aiChat = document.getElementById('aiChat');
const aiInput = document.getElementById('aiInput');
function appendMsg(role, html) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  div.innerHTML = html;
  if (aiChat) { aiChat.appendChild(div); aiChat.scrollTop = aiChat.scrollHeight; }
  return div;
}

const ai = window.UniversalAI.create({
  button: document.getElementById('aiFab'),
  onOpen() {
    const ov = document.getElementById('aiOverlay');
    if (ov) ov.hidden = false;
    setFabVisible(false); try { renderRemoteAccessCard(); } catch (e) { console.warn(e); };
    refreshStatus();
  },
  onActions: executeActions
});

function closeAIPanel() {
  const ov = document.getElementById('aiOverlay');
  if (ov) ov.hidden = true;
  setFabVisible(true);
}
document.getElementById('aiClose')?.addEventListener('click', closeAIPanel);
document.getElementById('aiOverlay')?.addEventListener('click', e => {
  if (e.target.id === 'aiOverlay') closeAIPanel();
});
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  document.getElementById('tab-' + t.dataset.tab)?.classList.add('active');
  if (t.dataset.tab === 'logs') loadLogs();
  if (t.dataset.tab === 'feedback') setUnread(0);
}));

async function refreshStatus() {
  const bar = document.getElementById('aiStatusBar');
  const dot = document.getElementById('aiStatusDot');
  try {
    const j = await ai.status();
    const configured = !!(j.configured || j.settings?.hasKey || j.settings?.builderLinked);
    const provider = j.provider || j.settings?.provider || '';
    const label = provider && provider !== 'none' ? provider : 'Builder AI';
    if (bar) {
      bar.textContent = configured
        ? ('AI ready · ' + label)
        : 'AI unavailable · configure provider in ⚙ Settings';
    }
    if (dot) { dot.classList.toggle('on', configured); dot.classList.toggle('off', !configured); }
  } catch (e) {
    console.error('[ai-panel] status', e);
    if (bar) bar.textContent = 'AI unavailable';
  }
}

async function sendAI() {
  const text = (aiInput.value || '').trim();
  if (!text) return;
  aiInput.value = '';
  appendMsg('user', escapeHtml(text));
  const loading = appendMsg('ai', '…');
  try {
    const out = await ai.chat(text, gameContext());
    loading.remove();
    executeActions(out.actions);
    const local = out.source === 'local' || out.configured === false;
    appendMsg('ai', escapeHtml(out.reply || 'Không có phản hồi').replace(/\n/g, '<br>') +
      (local ? '<div style="opacity:.55;font-size:.75rem">Local guide</div>' : ''));
  } catch (e) {
    loading.remove();
    console.error('[ai-panel] sendAI failed', e);
    const tip = /ACCESS_PASSWORD|401/.test(String(e.message||''))
      ? '<div style="opacity:.7;font-size:.75rem;margin-top:4px">Open /login.html if Builder access password is enabled.</div>'
      : '<div style="opacity:.7;font-size:.75rem;margin-top:4px">Check top ⚙ Builder Settings for AI configuration. See browser console for details.</div>';
    appendMsg('ai', escapeHtml(e.message || 'AI connection failed') + tip);
  }
}
document.getElementById('aiSend')?.addEventListener('click', sendAI);
aiInput?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); sendAI(); } });

async function loadLogs() {
  const view = document.getElementById('logsView') || document.getElementById('logOut');
  if (!view) return;
  view.textContent = 'Loading unified Builder log…';
  try {
    const qs = window.__pafProjectId ? `?projectId=${encodeURIComponent(window.__pafProjectId)}&limit=120` : '?limit=120';
    const [uni, global] = await Promise.all([
      fetch('/api/activity/unified' + qs).then((r) => r.json()).catch(() => ({ entries: [] })),
      fetch('/api/activity/global' + qs).then((r) => r.json()).catch(() => ({ jobs: [], activity: [] })),
    ]);
    const rows = [];
    for (const e of (uni.entries || [])) {
      rows.push({ ts: e.ts || '', level: e.level || 'task', msg: e.msg || '' });
    }
    for (const j of (global.jobs || [])) {
      rows.push({
        ts: j.created_at || j.updated_at || '',
        level: j.error ? 'error' : 'task',
        msg: `${j.type || 'job'} · ${j.status || ''} · ${j.stage || ''}${j.error ? ' · ' + String(j.error).slice(0, 400) : ''}`,
      });
    }
    for (const a of (global.activity || [])) {
      rows.push({ ts: a.t || a.ts || '', level: a.status === 'error' ? 'error' : 'info', msg: `${a.action || ''} · ${a.detail || ''}`.trim() });
    }
    rows.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    view.textContent = rows.slice(-300).map((row) => `${row.ts} [${String(row.level).toUpperCase()}] ${row.msg}`).join('\n') || '(no Builder activity yet)';
  } catch (err) {
    view.textContent = 'Could not load logs: ' + (err.message || err);
  }
}
document.getElementById('logsRefresh')?.addEventListener('click', loadLogs);

const fb = window.UniversalFeedback.create({
  onUnread: setUnread,
  onSync(sync) {
    renderDonate(sync.donate);
    renderNotices(sync.notices);
  }
});
function renderNotices(notices) {
  const el = document.getElementById('fbNotices');
  if (!el) return;
  el.innerHTML = (notices || []).map(n =>
    '<div class="fb-notice"><strong>' + escapeHtml(n.title || 'Notice') + '</strong>' +
    (n.body ? '<div>' + escapeHtml(n.body) + '</div>' : '') +
    (n.id ? '<button type="button" data-mark="' + escapeHtml(n.id) + '">Đã đọc</button>' : '') +
    '</div>'
  ).join('');
  el.querySelectorAll('[data-mark]').forEach(btn => btn.addEventListener('click', async () => {
    await fb.markRead(btn.dataset.mark);
    btn.closest('.fb-notice')?.remove();
  }));
}
let fbRating = 0;
document.querySelectorAll('#fbStars button').forEach(b => b.addEventListener('click', () => {
  fbRating = Number(b.dataset.r);
  document.querySelectorAll('#fbStars button').forEach(x => x.classList.toggle('on', Number(x.dataset.r) <= fbRating));
}));
document.getElementById('fbSubmit')?.addEventListener('click', async () => {
  const status = document.getElementById('fbStatus');
  const msg = (document.getElementById('fbMessage')?.value || '').trim();
  if (!msg) { if (status) status.textContent = 'Vui lòng nhập nội dung.'; return; }
  if (status) status.textContent = 'Sending…';
  try {
    await fb.send({ type: document.getElementById('fbType')?.value, message: msg, rating: fbRating });
    if (status) status.textContent = 'Cảm ơn bạn!';
    const ta = document.getElementById('fbMessage');
    if (ta) ta.value = '';
  } catch (e) {
    if (status) status.textContent = e.message;
  }
});

refreshStatus();
fb.sync().catch(e => {
  const st = document.getElementById('fbStatus');
  if (st) st.textContent = 'Hub: ' + e.message;
});
setUnread(0);
setFabVisible(true);
