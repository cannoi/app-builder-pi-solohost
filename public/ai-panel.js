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
    setFabVisible(false);
    refreshStatus();
    loadSettings();
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
  if (t.dataset.tab === 'settings') loadSettings();
  if (t.dataset.tab === 'logs') loadLogs();
  if (t.dataset.tab === 'feedback') setUnread(0);
}));

async function refreshStatus() {
  const bar = document.getElementById('aiStatusBar');
  const dot = document.getElementById('aiStatusDot');
  try {
    const j = await ai.status();
    const configured = !!(j.configured || (j.settings && j.settings.hasKey));
    const provider = (j.settings && j.settings.provider) || j.provider || '';
    if (bar) bar.textContent = configured ? ('AI ready · ' + provider) : 'Local guide ON · add key in Settings';
    if (dot) { dot.classList.toggle('on', configured); dot.classList.toggle('off', !configured); }
  } catch (e) {
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
      : '<div style="opacity:.7;font-size:.75rem;margin-top:4px">Check panel Settings or top ⚙ coding AI. See browser console for details.</div>';
    appendMsg('ai', escapeHtml(e.message || 'AI connection failed') + tip);
  }
}
document.getElementById('aiSend')?.addEventListener('click', sendAI);
aiInput?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); sendAI(); } });

function fillModelSelect(models, current) {
  const sel = document.getElementById('setModel');
  if (!sel) return;
  if (!Array.isArray(models) || !models.length) {
    if (sel.tagName === 'SELECT') {
      sel.outerHTML = '<input type="text" id="setModel" placeholder="auto" value="' + escapeHtml(current || 'auto') + '">';
    } else {
      sel.value = current || 'auto';
    }
    return;
  }
  const opts = ['<option value="auto">auto</option>'].concat(
    models.slice(0, 40).map(m => {
      const id = typeof m === 'string' ? m : (m.id || m.name || '');
      return '<option value="' + escapeHtml(id) + '">' + escapeHtml(id) + '</option>';
    })
  );
  if (sel.tagName !== 'SELECT') {
    sel.outerHTML = '<select id="setModel">' + opts.join('') + '</select>';
  } else {
    sel.innerHTML = opts.join('');
  }
  const el = document.getElementById('setModel');
  if (el) el.value = current || 'auto';
}

async function loadSettings() {
  const sel = document.getElementById('setProvider');
  const status = document.getElementById('setStatus');
  try {
    const [st, cat] = await Promise.all([ai.settings(), ai.catalog()]);
    const providers = (cat && cat.providers) || (Array.isArray(cat) ? cat : []);
    if (sel && providers.length) {
      sel.innerHTML = '<option value="none">— None —</option>' +
        providers.map(p => '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.name || p.id) + '</option>').join('');
      sel.value = st.provider || 'none';
    }
    const keyHint = document.getElementById('setKeyHint');
    if (keyHint) keyHint.textContent = st.hasKey ? ('Key hiện tại: ' + (st.maskedKey || '****')) : 'Key hiện tại: (chưa có)';
    const apiKey = document.getElementById('setApiKey');
    if (apiKey) apiKey.value = '';
    const base = document.getElementById('setBaseUrl');
    if (base) base.value = st.baseUrl || '';
    fillModelSelect([], st.model || 'auto');
    const mode = document.getElementById('setMode');
    if (mode) mode.value = st.mode || 'cloud_enabled';
    if (status) status.textContent = '';
  } catch (e) {
    if (status) status.textContent = 'Không tải được settings: ' + e.message;
  }
}

document.getElementById('setSave')?.addEventListener('click', async () => {
  const status = document.getElementById('setStatus');
  if (status) status.textContent = 'Saving…';
  try {
    const body = {
      provider: document.getElementById('setProvider')?.value,
      baseUrl: document.getElementById('setBaseUrl')?.value.trim(),
      model: document.getElementById('setModel')?.value.trim() || 'auto',
      mode: document.getElementById('setMode')?.value
    };
    const key = document.getElementById('setApiKey')?.value.trim();
    if (key) body.apiKey = key;
    const j = await ai.saveSettings(body);
    if (status) status.textContent = j.ok === false ? (j.error || 'Failed') : 'Saved ✓';
    await loadSettings();
    refreshStatus();
  } catch (e) {
    if (status) status.textContent = e.message;
  }
});

document.getElementById('setTest')?.addEventListener('click', async () => {
  const status = document.getElementById('setStatus');
  if (status) status.textContent = 'Checking token…';
  try {
    // save current form first so server tests the right provider/key
    const body = {
      provider: document.getElementById('setProvider')?.value,
      baseUrl: document.getElementById('setBaseUrl')?.value.trim(),
      model: document.getElementById('setModel')?.value.trim() || 'auto',
      mode: document.getElementById('setMode')?.value
    };
    const key = document.getElementById('setApiKey')?.value.trim();
    if (key) body.apiKey = key;
    await ai.saveSettings(body);
    const r = await ai.testConnection();
    if (r.ok) {
      const models = r.models || [];
      fillModelSelect(models, r.model || 'auto');
      if (status) status.textContent = 'Token OK' + (r.model ? ' · model: ' + r.model : '') + (models.length ? '. Models: ' + models.slice(0, 6).map(m => m.id || m).join(', ') : '. (server lists no models)') + (r.warning ? ' ⚠ ' + r.warning : '');
    } else {
      if (status) status.textContent = r.warning || r.error || 'Token check failed';
      if (r.suggested_provider) {
        const sel = document.getElementById('setProvider');
        if (sel) sel.value = r.suggested_provider;
      }
    }
  } catch (e) {
    if (status) status.textContent = e.message;
  }
});

async function refreshModelsClick() {
  const status = document.getElementById('setStatus');
  if (status) status.textContent = 'Refreshing models…';
  try {
    const r = await ai.models();
    fillModelSelect(r.models || r || [], document.getElementById('setModel')?.value || 'auto');
    if (status) status.textContent = r.warning || 'Models updated';
  } catch (e) {
    if (status) status.textContent = e.message;
  }
}
// HTML button is id="setModels"; keep the legacy id working too.
['setModels', 'setRefreshModels'].forEach(id => document.getElementById(id)?.addEventListener('click', refreshModelsClick));

async function loadLogs() {
  const view = document.getElementById('logsView');
  if (!view) return;
  try {
    const r = await fetch('/api/logs');
    const j = await r.json();
    view.textContent = (j.logs || []).map(l => (l.ts || '') + ' [' + l.level + '] ' + l.msg).join('\n') || '(no logs)';
  } catch (e) {
    view.textContent = e.message;
  }
}
document.getElementById('logsRefresh')?.addEventListener('click', loadLogs);
document.getElementById('logsClear')?.addEventListener('click', async () => {
  await fetch('/api/logs', { method: 'DELETE' });
  loadLogs();
});

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
loadSettings();
fb.sync().catch(e => {
  const st = document.getElementById('fbStatus');
  if (st) st.textContent = 'Hub: ' + e.message;
});
setUnread(0);
setFabVisible(true);
