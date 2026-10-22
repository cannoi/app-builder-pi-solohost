const $ = (id) => document.getElementById(id);
function uiT(key, fallback = '') {
  try {
    if (window.pafI18n && typeof window.pafI18n.t === 'function') return window.pafI18n.t(key);
  } catch {}
  return fallback || key;
}
function uiLocale() {
  try {
    if (window.pafI18n && window.pafI18n.locale) return window.pafI18n.locale;
    const s = localStorage.getItem('paf_locale');
    if (s === 'vi' || s === 'en') return s;
  } catch {}
  return 'en';
}

const state = { projectId: null, projects: [], busy: false, jobId: null, poll: null, pollFailures: 0, seenEvents: 0, files: [], settings: null, pollInFlight: false, pollInFlightJobId: null, watchSeq: 0, lastNotice: '', jobStartedAt: 0, slowOffered: false };

async function api(url, options = {}) {
  const r = await fetch(url, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const text = await r.text(); let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (!r.ok) {
    const err = Object.assign(new Error(data.error || `HTTP ${r.status}`), { data, status: r.status });
    if (data.jobId) err.jobId = data.jobId;
    throw err;
  }
  return data;
}
function compactNotice(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (/container exited before smoke/i.test(raw)) return 'GHCR: the container exited before HTTP was ready. Copy this: Container exited before smoke test passed.';
  if (/did not become reachable/i.test(raw) || /cannot reach the web service/i.test(raw)) return 'GHCR: image built, but the app did not accept HTTP in time. Check startup crash and listen port.';
  if (/assignment to constant variable/i.test(raw)) return 'Builder hit an internal error while retrying the same GitHub fix. No extra app files were changed.';
  if (raw.length > 280 && /GitHub Actions failed/i.test(raw)) return 'GHCR: GitHub Actions smoke test failed. The image built, then the container died or did not listen. Copy the one-line Actions error, not this whole chat.';
  return String(text || '');
}

function isSoloHostKitPayload(text) {
  const s = String(text || '');
  return s.includes('"kind":"solohost_install"') || s.includes('"kind": "solohost_install"') || /=== docker-compose\.yml ===/.test(s);
}
function parseSoloHostKit(text) {
  const s = String(text || '');
  try {
    const j = JSON.parse(s);
    if (j && j.kind === 'solohost_install') return j;
  } catch {}
  const composeM = s.match(/=== docker-compose\.yml ===\s*\n([\s\S]*?)(?=\n=== config_options\.yml ===|\n—— end ——|$)/);
  const configM = s.match(/=== config_options\.yml ===\s*\n([\s\S]*?)(?=\n—— end ——|$)/);
  if (!composeM && !configM) return null;
  return {
    kind: 'solohost_install',
    compose: (composeM?.[1] || '').trim(),
    config: (configM?.[1] || '').trim(),
    guide: { en: '1) SoloHost → Add app  2) Paste files  3) Save → Start', vi: '1) SoloHost → Thêm app  2) Dán 2 file  3) Lưu → Start' },
  };
}
function copyText(label, value) {
  const v = String(value || '');
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(v).then(() => toast(`✓ Copied ${label}`)).catch(() => fallbackCopy(label, v));
  } else fallbackCopy(label, v);
}
function fallbackCopy(label, v) {
  const ta = document.createElement('textarea');
  ta.value = v; document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); toast(`✓ Copied ${label}`); } catch { toast(`Could not copy ${label}`); }
  ta.remove();
}

function renderFieldChoiceCard(projectId) {
  if (!projectId) return;
  document.querySelectorAll('.msg.ai.fieldChoiceCard').forEach((el) => el.remove());
  const box = document.createElement('div');
  box.className = 'msg ai fieldChoiceCard';
  box.innerHTML = '<div style="font-weight:700">Choose install fields</div>'
    + '<div class="small">What should SoloHost ask when installing this app?</div>'
    + '<div class="actionCard fieldModeRow" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px">'
    + '<button type="button" class="primary" data-field-mode="full">Full form</button>'
    + '<button type="button" data-field-mode="defaults">All defaults</button>'
    + '<button type="button" data-field-mode="auth">Login only</button>'
    + '<button type="button" data-field-mode="custom">Custom…</button>'
    + '</div>'
    + '<div class="customFieldEditor" hidden style="margin-top:10px"></div>'
    + '<div class="small fieldSummary" style="margin-top:6px;opacity:.8"></div>';
  const editor = box.querySelector('.customFieldEditor');
  const summary = box.querySelector('.fieldSummary');
  const customState = { fields: {} };

  async function saveMode(mode, fields, fixedValues) {
    await api(`/api/projects/${projectId}/solohost/fields`, {
      method: 'POST',
      body: JSON.stringify({ mode, fields: fields || {}, fixedValues: fixedValues || {} }),
    });
    add('system', `Install fields: ${mode}. Tap Publish to continue.`);
    box.remove();
  }

  function updateSummary(inv) {
    const n = Object.values(customState.fields).filter((v) => v === 'keep').length;
    summary.textContent = `The install form will have ${n} questions`;
  }

  async function openCustomEditor() {
    editor.hidden = false;
    editor.textContent = 'Loading inventory…';
    try {
      const data = await api(`/api/projects/${projectId}/solohost/fields`);
      const inv = (data.inventory || []).filter((i) => i.class !== 'internal');
      const groups = { auth: 'Login', credential: 'API keys', feature: 'Features', tuning: 'Tuning' };
      const by = {};
      for (const item of inv) {
        const g = groups[item.class] || 'Other';
        (by[g] = by[g] || []).push(item);
        customState.fields[item.name] = data.suggestions?.custom?.fields?.[item.name]
          || (item.class === 'tuning' ? 'omit' : 'keep');
      }
      editor.innerHTML = '';
      for (const [g, items] of Object.entries(by)) {
        const h = document.createElement('div');
        h.style.fontWeight = '600';
        h.style.marginTop = '8px';
        h.textContent = g;
        editor.appendChild(h);
        for (const item of items) {
          const row = document.createElement('div');
          row.style.display = 'flex';
          row.style.flexWrap = 'wrap';
          row.style.gap = '6px';
          row.style.alignItems = 'center';
          row.style.margin = '4px 0';
          const lab = document.createElement('span');
          lab.className = 'small';
          lab.style.minWidth = '120px';
          lab.textContent = item.name + (item.defaultValue != null ? ` (=${item.defaultValue})` : '');
          row.appendChild(lab);
          for (const opt of ['keep', 'fixed', 'omit']) {
            if (opt === 'fixed' && item.secret) continue;
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = opt === 'keep' ? 'Keep' : opt === 'fixed' ? 'Fixed' : 'Omit';
            b.dataset.treatment = opt;
            if (customState.fields[item.name] === opt) b.className = 'primary';
            b.onclick = () => {
              customState.fields[item.name] = opt;
              row.querySelectorAll('button').forEach((x) => { x.className = ''; });
              b.className = 'primary';
              updateSummary(inv);
            };
            row.appendChild(b);
          }
          editor.appendChild(row);
        }
      }
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'primary';
      save.style.marginTop = '10px';
      save.textContent = 'Save custom fields';
      save.onclick = () => saveMode('custom', customState.fields, {});
      editor.appendChild(save);
      updateSummary(inv);
    } catch (e) {
      editor.textContent = e.message || 'Could not load fields';
    }
  }

  box.querySelectorAll('[data-field-mode]').forEach((btn) => {
    btn.onclick = async () => {
      const mode = btn.dataset.fieldMode;
      if (mode === 'custom') {
        openCustomEditor();
        return;
      }
      try {
        await saveMode(mode, {}, {});
      } catch (e) {
        add('system', e.message || 'Could not save field choice');
      }
    };
  });
  $('chat').appendChild(box);
  if (chatNearBottom()) $('chat').scrollTop = $('chat').scrollHeight;
}


function renderSoloHostKitCard(kit) {
  const box = document.createElement('div');
  box.className = 'msg ai solohostKit';
  const title = document.createElement('div');
  title.className = 'solohostKitTitle';
  title.textContent = '📦 SoloHost install kit';  // i18n: solohost.kit.title
  box.appendChild(title);
  const steps = document.createElement('div');
  steps.className = 'solohostKitSteps';
  steps.textContent = (kit.guide?.en || kit.guide || '1) SoloHost → Add app  2) Copy each file  3) Save → Start');
  box.appendChild(steps);

  function section(filename, body) {
    const sec = document.createElement('div');
    sec.className = 'solohostFile';
    const head = document.createElement('div');
    head.className = 'solohostFileHead';
    const name = document.createElement('strong');
    name.textContent = filename;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'solohostCopyBtn';
    btn.textContent = '📋 Copy';
    btn.addEventListener('click', () => copyText(filename, body));
    head.appendChild(name);
    head.appendChild(btn);
    const pre = document.createElement('pre');
    pre.className = 'solohostPre';
    pre.textContent = body || '(empty)';
    sec.appendChild(head);
    sec.appendChild(pre);
    return sec;
  }
  if (kit.compose) box.appendChild(section('docker-compose.yml', kit.compose));
  if (kit.config) box.appendChild(section('config_options.yml', kit.config));
  return box;
}


function renderOrchestratorPlanCard(text) {
  const lines = String(text || '').split('\n').filter(Boolean);
  if (lines.length < 2) return null;
  if (!/^(Plan|Kế hoạch)/i.test(lines[0]) && !/[✅⚠️⏳⏭️☐]/.test(text)) return null;
  const items = lines.slice(1).map((ln) => {
    const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');
    return '<li>' + esc(ln) + '</li>';
  }).join('');
  return '<div class="orch-plan-card" data-orch-plan="1"><div class="orch-plan-title">' +
    lines[0].replace(/</g,'&lt;') + '</div><ul class="orch-plan-list">' + items + '</ul></div>';
}

function shouldSkipNotice(text, meta = {}) {
  // User-driven feedback always shows (buttons / chat). Job noise may dedupe within 3s.
  if (meta.force || meta.fromUser) {
    state.lastNotice = '';
    return false;
  }
  const key = compactNotice(text).slice(0, 180);
  if (!key) return true;
  const now = Date.now();
  if (state.lastNotice === key && (now - (state.lastNoticeAt || 0)) < 3000) return true;
  state.lastNotice = key;
  state.lastNoticeAt = now;
  return false;
}
function add(role, text, meta = {}) {
  if (!text) return;
  const textOut = role === 'user' ? text : compactNotice(text);
  if (role !== 'user' && shouldSkipNotice(textOut, meta)) return;
  const stick = chatNearBottom();
  const el = document.createElement('div'); el.className = `msg ${role}`; el.textContent = role === 'user' ? text : compactNotice(text);
  if (meta.small) { const s = document.createElement('span'); s.className = 'small'; s.textContent = meta.small; el.appendChild(s); }
  if (role === 'ai' && !meta.noTools) attachReplyTools(el);
  $('chat').appendChild(el); if (stick) $('chat').scrollTop = $('chat').scrollHeight; else maybeJump();
  if (state.projectId && !meta.ephemeral) {
    fetch(`/api/projects/${state.projectId}/remember`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, message: String(text).slice(0, 4000) }),
    }).catch(() => {});
  }
}
function attachReplyTools(box) {
  if (!state.projectId || !box) return;
  const row = document.createElement('div'); row.className = 'actionCard replyTools';
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = '↩ Rollback';
  b.title = 'Restore the last checkpoint';
  b.onclick = () => rollbackLast();
  row.appendChild(b);
  box.appendChild(row);
}
async function rollbackLast() {
  if (!state.projectId) { add('ai', 'No project yet. Build first.', { noTools: true }); return; }
  if (state.busy) { add('system', 'Wait for the current step to finish, then rollback.'); return; }
  setBusy(true, 'Restoring last checkpoint…');
  try {
    const r = await api(`/api/projects/${state.projectId}/rollback`, { method: 'POST', body: '{}' });
    add('ai', `↩ Restored checkpoint${r.snapshot?.reason ? ` (${r.snapshot.reason})` : ''}. Working files are back to that snapshot. Tap Run to verify.`);
  } catch (e) { add('ai', e.message || 'No snapshot available yet.'); }
  finally { setBusy(false); }
}
async function downloadScript(kind) {
  const map = {
    github: {
      url: '/api/scripts/github-publisher',
      name: 'GitHub-ZIP-Image-Publisher-v5.0.ps1',
      guide: 'GitHub helper downloaded.\n1) On Windows, right-click the .ps1 → Run with PowerShell (or: powershell -ExecutionPolicy Bypass -File .\\GitHub-ZIP-Image-Publisher-v5.0.ps1).\n2) Choose the app ZIP and the GitHub repo (or a new name).\n3) Sign in with a classic token: repo + workflow + write:packages.\n4) Wait until the script prints the GHCR image URL.\n5) Come back here and send: tạo file install SoloHost <image-url>',
    },
    run: {
      url: '/api/scripts/run-docker-app',
      name: 'run-docker-app.ps1',
      guide: 'Run-from-ZIP helper downloaded.\n1) Install Docker Desktop and keep it running.\n2) Put run-docker-app.ps1 next to your app ZIP.\n3) Right-click → Run with PowerShell (or: powershell -ExecutionPolicy Bypass -File .\\run-docker-app.ps1 -ZipFile app.zip).\n4) The script unpacks, builds/starts compose, then opens the UI URL.\n5) Use the on-screen menu to check logs or stop the app.',
    },
  };
  const spec = map[kind];
  if (!spec) return;
  try {
    const r = await fetch(spec.url);
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data.error || 'Could not download the helper script.');
    }
    const blob = await r.blob();
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href; a.download = spec.name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 2000);
    add('ai', spec.guide);
  } catch (e) { add('ai', e.message); }
}
function event(stage, status, message) {
  // Do not render SoloHost kit from events (avoids duplicate cards). Kit comes once from job.result.solohostFiles.
  if (stage === 'solohost_files' || isSoloHostKitPayload(message)) {
    return; // skip noisy JSON event line
  }
  const shown = compactNotice(message);
  if (shouldSkipNotice(`${status}:${shown}`)) return;
  const el = document.createElement('div');
  el.className = `event ${status}`;
  // Preserve multi-line diagnostics
  if (String(message || '').includes('\n') && String(message || '').length > 120) {
    el.style.whiteSpace = 'pre-wrap';
    el.textContent = `${status === 'done' ? '✓' : status === 'failed' ? '⚠' : '•'} ${String(message || '')}`;
  } else {
    el.textContent = `${status === 'done' ? '✓' : status === 'failed' ? '⚠' : '•'} ${shown}`;
  }
  $('chat').appendChild(el); if (chatNearBottom()) $('chat').scrollTop = $('chat').scrollHeight; else maybeJump();
}
function toast(message) { add('system', message); }
function setLive(on) {
  const btn = $('liveBtn');
  if (!btn) return;
  btn.hidden = !on;
}
async function stopLive() {
  if (!state.projectId || state.busy) return;
  setBusy(true, 'Stopping the test app…');
  try {
    const r = await api(`/api/projects/${state.projectId}/stop`, { method: 'POST', body: '{}' });
    await api('/api/docker/gc', { method: 'POST', body: JSON.stringify({ projectId: state.projectId }) }).catch(() => ({}));
    setLive(false);
    add('ai', 'Test app stopped. Extra Builder containers and unused images were removed.');
    if (r.jobId) watch(r.jobId);
    else setBusy(false);
  } catch (e) { handleJobActionError(e); }
}

function showSlowWaitCard(secs, modelHint) {
  if (state.slowOffered) return;
  state.slowOffered = true;
  const box = document.createElement('div');
  box.className = 'msg system';
  box.id = 'slowWaitCard';
  const m = modelHint || 'AI';
  box.innerHTML = `<div><strong>Waiting for ${m} (${secs}s)…</strong></div>`;
  const row = document.createElement('div');
  row.className = 'actionCard';
  const waitBtn = document.createElement('button');
  waitBtn.textContent = 'Wait';
  waitBtn.onclick = () => { state.slowOffered = false; box.remove(); };
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => cancelCurrentJob();
  const switchBtn = document.createElement('button');
  switchBtn.textContent = 'Switch model';
  switchBtn.onclick = () => { try { $('settingsBtn')?.click(); } catch {} };
  row.append(waitBtn, cancelBtn, switchBtn);
  box.appendChild(row);
  $('chat')?.appendChild(box);
}

function setBusy(on, text = 'Working…') {
  state.busy = on;
  if (on) { state.jobStartedAt = Date.now(); state.slowOffered = false; }
  $('busyBar').hidden = !on;
  $('busyText').textContent = on ? text : 'Ready';
  if ($('workPill')) { $('workPill').textContent = on ? 'Working' : 'Ready'; $('workPill').className = on ? 'pill work' : 'pill ready'; }
  document.querySelectorAll('#attachBtn,#message,#moreBtn').forEach((x) => { if (x) x.disabled = on && x.id !== 'sendBtn'; });
  if ($('projectSelect')) $('projectSelect').disabled = on;
  // Send button turns into a Stop button while a job is running, instead of being disabled.
  const sendBtn = $('sendBtn');
  if (sendBtn) {
    sendBtn.disabled = false;
    sendBtn.textContent = on ? '⏹' : '➤';
    sendBtn.title = on ? 'Stop / cancel current action' : 'Send';
    sendBtn.classList.toggle('stopMode', on);
  }
}
function handleJobActionError(e) {
  // A 409 from the server can include the job that already owns this project.
  // Never drop the visible job state in that case: attach the chat to the existing
  // job instead of telling the user to retry or starting a duplicate action.
  if (e?.jobId) {
    add('system', `↻ An action is already running · following the current job.`);
    watch(e.jobId);
    return true;
  }
  setBusy(false);
  add('ai', e?.message || 'The action could not start.');
  return false;
}

async function cancelCurrentJob() {
  if (!state.busy) return;
  const jobId = state.jobId;
  stopJobWatch();
  setBusy(false);
  add('system', '⏹ Cancelled. The step may still finish in the background, but you can send a new message now.');
  if (jobId) { try { await api(`/api/jobs/${jobId}/cancel`, { method: 'POST', body: '{}' }); } catch {} }
}
function chatNearBottom() {
  const el = $('chat');
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}
function maybeJump() {
  const el = $('chat');
  $('jumpDown').hidden = chatNearBottom() || el.scrollHeight <= el.clientHeight + 20;
}
function project() { return state.projects.find((p) => p.id === state.projectId) || null; }
function actionText(action) { return ({ build:'Build the app', run:'Run the app', improve:'Improve the app', edit:'Edit the app', analyze:'Check the app', diagnose:'Diagnose the app', upgrade:'Inspect & upgrade', publish:'Prepare the release', sandbox:'Test the sandbox' })[action] || action; }

async function loadStatus() {
  try {
    const s = await api('/api/status'); state.settings = s;
  } catch {}
}
function modelRef(c, m) { return `${c.provider}:${m.id}`; }
function renderProviderSelector(hub) {
  const top = $('aiSelect');
  if (!top) return;
  const rows = (hub?.connections || []).filter((c) => c.status !== 'INVALID');
  top.innerHTML = '<option value="">AI provider</option>' + rows.map((c) => `<option value="${esc(c.provider)}">${esc(c.name || c.provider)}</option>`).join('');
  const preferred = hub?.preferredProvider || '';
  if (preferred && rows.some((c) => c.provider === preferred)) top.value = preferred;
  else if (rows[0]) top.value = rows[0].provider;
}

function fillModelOptionsFromList(models, provider) {
  const list = $('hubModelOptions');
  const input = $('hubModel');
  if (!list) return;
  const p = provider || $('hubProvider')?.value || 'ai';
  const opts = (models || []).map((m) => {
    const id = typeof m === 'string' ? m : (m.id || m.name || '');
    if (!id) return '';
    const value = id.includes(':') ? id : `${p}:${id}`;
    return `<option value="${esc(value)}">${esc(id)}</option>`;
  }).filter(Boolean);
  // Merge with existing options
  const seen = new Set();
  const merged = [];
  for (const html of opts) {
    const v = html.match(/value="([^"]*)"/)?.[1];
    if (v && !seen.has(v)) { seen.add(v); merged.push(html); }
  }
  for (const o of Array.from(list.options || [])) {
    if (o.value && !seen.has(o.value)) { seen.add(o.value); merged.push(`<option value="${esc(o.value)}">${esc(o.label || o.value)}</option>`); }
  }
  list.innerHTML = merged.join('');
  if (input && !input.value && models?.[0]) {
    const id = typeof models[0] === 'string' ? models[0] : models[0].id;
    if (id) input.value = id.includes(':') ? id : `${p}:${id}`;
  }
}

function renderModelSelectors(hub) {
  const list = $('hubModelOptions');
  const input = $('hubModel');
  if (!list && !input) return;
  const all = [];
  for (const c of (hub?.connections || [])) {
    const name = c.name || c.provider || 'provider';
    const models = (c.models || []).slice().sort((a, b) => Number(!!b.verified) - Number(!!a.verified));
    for (const m of models) {
      if (!m?.id) continue;
      all.push({ value: modelRef(c, m), label: `${name} · ${m.id}${m.verified ? '' : ''}` });
    }
  }
  if (list) {
    list.innerHTML = all.map((x) => `<option value="${esc(x.value)}">${esc(x.label)}</option>`).join('');
  }
  // Keep select-style compatibility if hubModel is still a <select>
  if (input && input.tagName === 'SELECT') {
    const current = input.value;
    input.innerHTML = `<option value="">Select model</option>` + all.map((x) => `<option value="${esc(x.value)}">${esc(x.label)}</option>`).join('');
    if (all.some((x) => x.value === current)) input.value = current;
  }
}
async function loadHub() {
  try {
    const hub = await api('/api/ai/hub');
    renderHubList(hub); renderProviderSelector(hub); renderModelSelectors(hub);
    if ($('hubModel')) {
      const pref = hub.preferredModels?.[0] || '';
      if (pref) $('hubModel').value = pref;
    }
    return hub;
  } catch (e) { if ($('settingsState')) $('settingsState').textContent = e.message; return null; }
}
function rememberProject(id) {
  try {
    if (id) localStorage.setItem('paf.projectId', id);
    else localStorage.removeItem('paf.projectId');
  } catch {}
}
function savedProjectId() {
  try {
    const q = new URLSearchParams(location.search).get('p');
    if (q) return q;
    return localStorage.getItem('paf.projectId');
  } catch { return null; }
}
async function loadProjects() {
  state.projects = await api('/api/projects');
  const select = $('projectSelect');
  select.innerHTML = '<option value="">New app</option>' + state.projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  select.value = state.projectId || '';
}
function renderUpgradeSession(session) {
  if (!session) return;
  const reason = String(session.lastError?.message || session.pauseReason || '').slice(0, 200);
  const key = [session.status, session.currentStep || '', reason, (session.completedSteps || []).join(',')].join('|');
  // One card only — openProject + job.done both used to append duplicates
  if (state._upgradeSessionKey === key) return;
  state._upgradeSessionKey = key;
  document.querySelectorAll('.msg.ai.upgradeSessionCard').forEach((el) => el.remove());
  const box = document.createElement('div'); box.className = 'msg ai upgradeSessionCard';
  const title = document.createElement('div'); title.style.fontWeight = '700';
  title.textContent = session.status === 'paused' ? '⏸ Upgrade paused — work is saved' : '🔧 Upgrade progress';
  box.appendChild(title);
  const body = document.createElement('div'); body.className = 'small';
  const completed = (session.completedSteps || []).join(', ') || 'none';
  const files = (session.changedFiles || []).join(', ') || 'none';
  body.textContent = `Step: ${session.currentStep || '—'}\nCompleted: ${completed}\nFiles changed: ${files}${reason ? `\nPause reason: ${reason}` : ''}`;
  body.style.whiteSpace = 'pre-wrap'; box.appendChild(body);
  const row = document.createElement('div'); row.className = 'actionCard';
  if (session.resumable && session.status === 'paused') {
    const resume = document.createElement('button'); resume.className = 'primary'; resume.textContent = '▶ Continue Upgrade';
    resume.onclick = async () => {
      if (state.busy) return;
      state._upgradeSessionKey = null; // allow a fresh card after resume
      setBusy(true, 'Continuing Upgrade from the saved plan…');
      try { const r = await api(`/api/projects/${state.projectId}/upgrade/resume`, { method: 'POST', body: '{}' }); watch(r.jobId); }
      catch (e) { handleJobActionError(e); }
    };
    row.appendChild(resume);
  }
  box.appendChild(row); $('chat').appendChild(box); if (chatNearBottom()) $('chat').scrollTop = $('chat').scrollHeight;
}

async function openProject(id, announce = true) {
  state.projectId = id; rememberProject(id); await loadProjects();
  const p = await api(`/api/projects/${id}`);
  if (announce) { $('chat').innerHTML = ''; state._upgradeSessionKey = null; }
  const recent = Array.isArray(p.releases) ? p.releases : [];
  // Refresh/reconnect must use the authoritative current-job endpoint first. The
  // activity list is historical and can lag while a long Publish is still running.
  const currentJob = await api(`/api/jobs/current?projectId=${encodeURIComponent(id)}`).catch(() => null);
  if (currentJob?.active && currentJob.jobId) {
    add('system', `↻ ${currentJob.type || 'action'} is still running · ${currentJob.stage || 'working'}`);
    watch(currentJob.jobId);
  }
  const activity = await api(`/api/activity?projectId=${encodeURIComponent(id)}`).catch(() => ({items:[]}));
  const running = !currentJob?.active ? activity.items?.find((x) => x.running) : null;
  if (running) { add('system', `↻ ${running.type} is still running · ${running.stage || 'working'}`); watch(running.id); }
  const last = activity.items?.find((x) => !x.running);
  if (last?.status === 'failed' && last.error) add('system', `⚠ Last issue: ${String(last.error).split('\n')[0].slice(0, 220)}`);
  if (announce) {
    if (p.chat?.length) p.chat.forEach((m) => add(m.role === 'user' ? 'user' : m.role === 'assistant' ? 'ai' : 'system', m.message, { ephemeral: true, noTools: m.role !== 'assistant' && m.role !== 'ai' }));
    else add('ai', String(p.status || '').startsWith('UPGRADE')
      ? `Upgrade Workshop is open for ${p.name}. Tell me what you want to improve.`
      : `I’m ready to build ${p.name}. Tell me what you want next.`);
  }
  if (p.workPlan?.steps?.length) renderWorkPlan(p.workPlan);
  if (p.upgradeSession && ['paused','running'].includes(p.upgradeSession.status)) renderUpgradeSession(p.upgradeSession);
  if (Array.isArray(p.workHistory) && p.workHistory.length) renderWorkHistory(p.workHistory);
  if (announce) add('system', `Project: ${p.name}`);
  setLive(p.runtime?.status === 'passed');
}
async function sendMessage() {
  if (state.busy) return;
  const message = $('message').value.trim();
  if (!message && !state.files.length) return;
  if (state.awaitingChoices && state.projectId && message) {
    $('message').value = '';
    add('user', message);
    state.awaitingChoices = false;
    setBusy(true, 'Saving your custom answers…');
    try {
      const r = await api(`/api/projects/${state.projectId}/answer`, { method: 'POST', body: JSON.stringify({ answers: { custom: message, ...state.pendingAnswers } }) });
      watch(r.jobId);
    } catch (e) { handleJobActionError(e); }
    return;
  }
  const files = state.files.slice(); state.files = []; renderFiles();
  if (message) { add('user', message); $('message').value = ''; }
  const githubUrl = parseGithubInput(message);
  if (githubUrl && !files.length) {
    setBusy(true, 'Importing public GitHub source…');
    try {
      const r = await api('/api/projects/upgrade/github', { method: 'POST', body: JSON.stringify({ url: githubUrl }) });
      add('ai', '🔧 GitHub source imported into the independent Upgrade Workshop.');
      watch(r.jobId);
    } catch (e) { handleJobActionError(e); }
    return;
  }
  setBusy(true, state.projectId ? 'AI is working on your app…' : 'AI is creating your app…');
  try {
    const url = state.projectId ? `/api/projects/${state.projectId}/chat` : '/api/chat';
    const form = new FormData(); form.append('message', message || 'Analyze these files and build the right app.');
    for (const f of files) form.append('files', f);
    const r = await fetch(url, { method: 'POST', body: form });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Builder could not start.');
    if (data.reply) { setBusy(false); add('ai', data.reply); return; }
    watch(data.jobId);
  } catch (e) {
    setBusy(false);
    if (e.jobId) {
      add('ai', `An action is already running (${e.data?.stage || 'working'}). I will follow that job instead of starting another one.`);
      watch(e.jobId);
    } else add('ai', e.message, { small: 'Nothing was changed.' });
  }
}
async function downloadZip(projectId, kind) {
  const url = `/api/projects/${projectId}/download?kind=${encodeURIComponent(kind || 'project')}`;
  const r = await fetch(url);
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.error || 'Could not create the ZIP.');
  }
  const blob = await r.blob();
  const name = (r.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || `${kind}.zip`;
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 2000);
  add('ai', `ZIP ready: ${name}`);
}
function pickImportZip() {
  const input = $('importZipInput');
  if (!input) { add('ai', 'Import is not available in this screen.'); return; }
  input.onchange = async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    setBusy(true, 'Importing ZIP…');
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('idea', `Imported ZIP: ${file.name}`);
      const url = state.projectId ? `/api/projects/${state.projectId}/import` : '/api/projects/import';
      const r = await fetch(url, { method: 'POST', body: form });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Import failed.');
      add('ai', `Importing ${file.name}. I will unpack it and flatten a wrapper folder if needed.`);
      watch(data.jobId);
    } catch (e) { handleJobActionError(e); }
  };
  input.click();
}
function parseGithubInput(text) {
  const raw = String(text || '').trim();
  const full = raw.match(/https?:\/\/(?:www\.)?github\.com\/([^/\s#?]+)\/([^/\s#?]+)/i);
  if (full) return `https://github.com/${full[1]}/${full[2].replace(/\.git$/i, '')}`;
  const short = raw.match(/^([^/\s#?]+)\/([^/\s#?]+)$/);
  if (short && !short[1].includes('.')) return `https://github.com/${short[1]}/${short[2].replace(/\.git$/i, '')}`;
  return '';
}
async function startUpgrade() {
  if (!state.projectId) {
    const request = add('ai', 'Dán link GitHub vào ô chat / Paste a GitHub URL in the chat box.');
    return;
    if (!request) return;
    const url = parseGithubInput(request.text) || request.text.trim();
    setBusy(true, 'Importing public GitHub source…');
    try { const r = await api('/api/projects/upgrade/github', { method: 'POST', body: JSON.stringify({ url }) }); add('ai', '🔧 GitHub source imported into the independent Upgrade Workshop.'); watch(r.jobId); }
    catch (e) { handleJobActionError(e); }
    return;
  }
  setBusy(true, 'Inspecting the existing app…');
  try {
    const r = await api(`/api/projects/${state.projectId}/upgrade/inspect`, { method: 'POST', body: '{}' });
    add('ai', '🔧 Upgrade Workshop started. I will inspect the existing app, repair only safe deterministic issues, and create a baseline before asking what you want to change.');
    watch(r.jobId);
  } catch (e) { handleJobActionError(e); }
}
async function askUpgradeRequest() {
  add('ai', 'Mô tả nâng cấp trong ô chat, hoặc đính kèm Rule / Describe the upgrade in chat or attach a Rule file.');
  return;
  if (!request) return;
  setBusy(true, 'Loading the Rule and inspecting the app…');
  try {
    let ruleText = '';
    for (const file of request.files || []) {
      if (/\.(rule|ya?ml|json|md)$/i.test(file.name || '')) ruleText += `${await file.text()}\n`;
    }
    const r = await api(`/api/projects/${state.projectId}/upgrade/request`, { method: 'POST', body: JSON.stringify({ request: request.text, ruleText }) });
    watch(r.jobId);
  } catch (e) { handleJobActionError(e); }
}
function renderUpgradeBaseline(result) {
  const health = result.baseline?.health?.status || result.knowledge?.runtime?.status || 'HEALTHY';
  const issues = result.issues || result.baseline?.knownIssues || [];
  const findings = issues.filter((i) => i.id !== 'healthy');
  add('ai', [
    '✓ App inspected',
    '✓ Security checked',
    '✓ Runtime checked',
    '✓ Existing features mapped',
    '✓ Baseline created',
    '',
    `APP CONDITION: ${health === 'HEALTHY' ? 'Healthy' : 'Needs Attention'}`,
    findings.length ? `Findings: ${findings.length}` : 'Findings: none blocking',
    `${result.safeRepairs?.length || 0} safe repair(s) applied.`,
    '',
    'Your app is ready for upgrade.',
  ].join('\n'));
}
function renderUpgradePlan(plan, request) {
  if (!plan) return;
  const box = document.createElement('div'); box.className = 'msg ai';
  const title = document.createElement('div'); title.textContent = '🔧 Upgrade Plan saved'; title.style.fontWeight = '700'; box.appendChild(title);
  const body = document.createElement('div'); body.className = 'small';
  body.textContent = `Problem: ${plan.root_cause || '—'}\n\nRecommended: ${plan.recommendation || '—'}\n\nRisk: ${plan.risk || 'unknown'}\n\nFiles: ${(plan.files || []).map(f => typeof f === 'string' ? f : f.path).join(', ') || 'none'}\n\nExpected: ${plan.expected_result || '—'}\n\nThe Builder will continue automatically. If an AI provider stops, the saved plan remains available to Continue Upgrade.`;
  body.style.whiteSpace = 'pre-wrap'; box.appendChild(body); $('chat').appendChild(box); if (chatNearBottom()) $('chat').scrollTop = $('chat').scrollHeight;
}

async function startDiagnose() {
  if (!state.projectId) { add('ai', '🩺 Open or create an app first.'); return; }
  setBusy(true, 'Diagnosing the real project…');
  try { const r = await api(`/api/projects/${state.projectId}/diagnose`, { method: 'POST', body: '{}' }); add('ai', '🩺 I will inspect the project, evidence, runtime configuration, and recent repair history before suggesting any change.'); watch(r.jobId); }
  catch (e) { handleJobActionError(e); }
}
async function startSandboxDemo() {
  setBusy(true, 'Testing sandbox…');
  try {
    const r = await api('/api/projects/sandbox-demo', { method: 'POST', body: '{}' });
    add('ai', 'Starting Sandbox Benchmark: runtime + Internet/DNS + browser checks. This separates Sandbox network problems from app problems.');
    watch(r.jobId);
  } catch (e) { handleJobActionError(e); }
}
async function quick(action, extraPayload = {}) {
  // Donate / undo always available (F4)
  if (action === 'support') return openSupport();
  if (action === 'rollback' || action === 'undo') return rollbackLast();
  if (state.busy) {
    if (action === 'run' || action === 'publish' || action === 'release') {
      add('system', uiT('msg.busy', 'Wait for the current step to finish…'), { force: true });
    }
    return;
  }
  state.lastNotice = '';
  if (action === 'script-run') return downloadScript('run');
  if (action === 'script-github') return downloadScript('github');
  if (action === 'docker') return inspectDocker();
  if (action === 'sandbox') return startSandboxDemo();
  if (action === 'upgrade') return startUpgrade();
  if (action === 'import') return pickImportZip();
  if (action === 'run') {
    try {
      const probe = await api('/api/sandbox-status');
      if (!probe?.ok) {
        add('ai', uiT('msg.runTip', 'Tip: open ⋯ and choose Sandbox if preview fails — that separates Builder/preview issues from your app.'), { force: true });
      }
    } catch {}
  }
  if (action === 'export') {
    if (!state.projectId) { add('ai', uiT('msg.zipNeedApp', 'Create an app first, then download ZIP.'), { force: true }); return; }
    add('ai', uiT('msg.zipPrep', 'Preparing a ZIP of your app…'), { force: true });
    try { await downloadZip(state.projectId, extraPayload.kind || 'project'); }
    catch (e) { add('ai', e.message); }
    return;
  }
  if (!state.projectId) { add('ai', uiT('msg.startIdea', 'Start with your app idea in the chat. I will create the project first.')); return; }
  setBusy(true, `${actionText(action)}…`);
  try {
    let r;
    if (action === 'release') action = 'publish';
  if (action === 'publish') {
      const checkOnly = extraPayload.verifyImage === true || extraPayload.recheck === true;
      r = await api(`/api/projects/${state.projectId}/release`, { method: 'POST', body: JSON.stringify({
        approved: true,
        confirm: true,
        push: true,
        forcePublish: checkOnly ? false : true,
        existingAction: extraPayload.existingAction || (checkOnly ? undefined : 'overwrite'),
        ...extraPayload,
      }) });
    }
    else if (action === 'improve' || action === 'edit') {
      setBusy(false);
      add('ai', uiT('msg.typeRequest', 'Type your request in the chat box. AI key required in Settings (Gemini default).'), { force: true });
      return;
    }
    else r = await api(`/api/projects/${state.projectId}/${action}`, { method: 'POST', body: '{}' });
    if (r.needsConfirmation || r.repoExists || r.requiresOverwrite) {
      setBusy(false);
      renderOverwriteConfirm(r);
      return;
    }
    watch(r.jobId);
  } catch (e) { handleJobActionError(e); }
}
async function askSafeAction(kind, initial = '') {
  return { text: initial || '', files: [] };
}

function stopJobWatch() {
  if (state.poll) clearTimeout(state.poll);
  state.poll = null;
}

async function recoverMissingJob(jobId, seq) {
  if (state.jobId !== jobId || state.watchSeq !== seq) return true;
  try {
    const projectId = state.projectId ? encodeURIComponent(state.projectId) : '';
    const current = await api(`/api/jobs/current?projectId=${projectId}`);
    if (state.jobId !== jobId || state.watchSeq !== seq) return true;
    if (current?.jobId) {
      if (current.jobId !== jobId) add('system', '↻ Reconnected to the latest project job. Chat stays on the result.');
      watch(current.jobId, { preserveEvents: false, resetFailures: true });
      return true;
    }
    // Keep waiting briefly instead of cancelling the visible work state.
    state.pollFailures = (state.pollFailures || 0) + 1;
    if (state.pollFailures < 8) {
      setBusy(true, 'Still working…');
      scheduleJobPoll(jobId, 1200);
      return true;
    }
    stopJobWatch();
    state.jobId = null;
    setBusy(false);
    add('system', '⚠ The current job is no longer available. No new action was started. You can safely retry the last action.');
    return true;
  } catch (recoveryError) {
    stopJobWatch();
    state.jobId = null;
    setBusy(false);
    add('system', `⚠ The current job could not be recovered (${recoveryError.message || 'job unavailable'}). No duplicate action was started.`);
    return true;
  }
}

function scheduleJobPoll(jobId, delay = 700) {
  stopJobWatch();
  const seq = state.watchSeq;
  state.poll = setTimeout(() => {
    if (seq !== state.watchSeq || state.jobId !== jobId) return;
    watch(jobId, { preserveEvents: true, resetFailures: false });
  }, delay);
}

async function watch(jobId, { preserveEvents = false, resetFailures = true } = {}) {
  if (state.jobId !== jobId) {
    state.jobId = jobId;
    state.watchSeq += 1;
    state.seenEvents = 0;
    state.pollFailures = 0;
  } else if (resetFailures) {
    state.pollFailures = 0;
  }
  if (!preserveEvents && state.seenEvents) state.seenEvents = 0;
  setBusy(true, state.pollFailures ? 'Still working…' : 'Working…');
    if (state.jobStartedAt) {
      const secs = Math.round((Date.now() - state.jobStartedAt) / 1000);
      if (secs >= 15) showSlowWaitCard(secs, ($('hubModel')?.value || $('aiSelect')?.value || 'AI'));
    }

  // Multiple UI paths can attach to the same job (for example a duplicate Publish
  // request receiving the existing jobId). Never issue overlapping GETs for the same
  // job, but allow a new job to take over while an obsolete request is finishing.
  // Check this BEFORE clearing the scheduled poll: an attach during an in-flight
  // request must not cancel the only continuation that will schedule the next poll.
  if (state.pollInFlight && state.pollInFlightJobId === jobId) return;
  stopJobWatch();
  const seq = state.watchSeq;
  state.pollInFlight = true;
  state.pollInFlightJobId = jobId;

  try {
    const job = await api(`/api/jobs/${jobId}`);
    if (state.jobId !== jobId || state.watchSeq !== seq) return;
    state.pollFailures = 0;
    const events = job.events || [];
    for (let i = state.seenEvents; i < events.length; i++) event(events[i].stage, events[i].status, events[i].message);
    if (job.status === 'done' && (job.result?.solohostFiles?.compose || job.result?.solohostFiles?.config)) {
      const kitKey = `${jobId}:${(job.result.solohostFiles.compose || '').length}:${(job.result.solohostFiles.config || '').length}`;
      if (state._solohostKitShown !== kitKey) {
        state._solohostKitShown = kitKey;
        const sf = job.result.solohostFiles;
        const stick = chatNearBottom();
        $('chat').appendChild(renderSoloHostKitCard({
          compose: sf.compose, config: sf.config,
          guide: { en: '1) SoloHost → Add app  2) Copy each file  3) Save → Start' },
        }));
        if (stick) $('chat').scrollTop = $('chat').scrollHeight; else maybeJump();
      }
    }
    state.seenEvents = events.length;

    if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
      stopJobWatch(); setBusy(false);
      const result = job.result || {};
      if (result.projectId && result.projectId !== state.projectId) {
        state.projectId = result.projectId;
        await loadProjects();
        await openProject(result.projectId, false);
      }
      if (job.status === 'done' && (job.type === 'upgrade_inspect' || job.type === 'upgrade_github_import')) {
        if (result.projectId && result.projectId !== state.projectId) {
          state.projectId = result.projectId;
          await loadProjects();
          await openProject(result.projectId, false);
        }
        renderUpgradeBaseline(result);
        if (state.projectId) await askUpgradeRequest();
      }
      if (job.status === 'done' && job.type === 'upgrade_request' && result.plan && !result.execution) {
        renderUpgradePlan(result.plan, result.plan.request || '');
      }
      if (job.status === 'done' && job.type === 'upgrade_request' && result.execution) {
        const state = result.execution;
        const pending = (state.tasks || []).filter(t => ['pending','waiting_user','failed','blocked'].includes(t.status));
        add('ai', result.brief || `Rule ${state.status}. ${state.cycle || 0} cycle(s) completed.`);
        if (result.needsUserAction) add('ai', `🔑 ${result.needsUserAction}`);
        else if (pending.length) add('ai', `Next: Builder stopped safely with ${pending.length} task(s) remaining. No identical repair was repeated.`);
      }
      if (result.session) renderUpgradeSession(result.session);
      if (result.status === 'needs_field_choice') renderFieldChoiceCard(state.projectId);
      if (result.status === 'needs_confirmation' && result.code === 'UNREACHABLE') {
        add('system', 'SoloHost validator unreachable. Use Accept unverified on the next Publish, or retry later.');
      }
      if (result.paused && result.resumable) {
        setBusy(false);
        renderUpgradeSession(result.session || result.execution || null);
        if (result.brief) add('ai', result.brief);
      }
      if (job.status === 'failed') {
        const failure = String(job.error || 'The action failed.');
        if (result.diagnosis) add('ai', result.diagnosis.brief || result.brief || failure);
        else add('ai', failure);
        renderRepairAction(failure);
      }
      const reportFailure = Array.isArray(result.reports) && result.reports.find((r) => r.status === 'failed' || r.status === 'blocked');
      if (reportFailure) {
        const failure = `Step ${reportFailure.action} was not completed: ${reportFailure.error || 'blocked by a previous failure.'}`;
        add('ai', failure);
        renderRepairAction(failure);
      }
      if (result.status === 'github_actions_failed' && result.diagnosis) {
        renderRepairAction(result.diagnosis);
      }
      if (result.brief) add('ai', result.brief);
      else if (result.reply) add('ai', result.reply);
      else if (state.projectId) { await loadProjects(); }
      summarizeResult(result, job.status);
      if (result.guide) renderGuide(result.guide);
      const live = extractRuntime(result);
      if (live?.status === 'passed') setLive(true);
      if (live?.status === 'stopped' || result.status === 'released') setLive(Boolean(live?.status === 'passed'));
      maybeJump();
      return;
    }

    // A successful poll proves the backend still owns the job. Keep the chat in a
    // waiting state until the server records a terminal status.
    scheduleJobPoll(jobId, 700);
  } catch (e) {
    if (state.jobId !== jobId || state.watchSeq !== seq) return;
    if (e?.status === 404 || /Job not found/i.test(String(e?.message || ''))) {
      await recoverMissingJob(jobId, seq);
      return;
    }
    state.pollFailures += 1;
    const delay = Math.min(5000, 700 * (2 ** Math.min(state.pollFailures, 3)));
    setBusy(true, state.pollFailures === 1 ? 'Reconnecting…' : 'Still working…');
    if (state.pollFailures === 1) add('system', '↻ Still waiting for the current job. Chat stays open until the result arrives.');
    scheduleJobPoll(jobId, delay);
  } finally {
    if (state.pollInFlightJobId === jobId) {
      state.pollInFlight = false;
      state.pollInFlightJobId = null;
    }
  }
}
// Fix: `result.runtime` can be either the preview engine name as a plain string
// (e.g. "native-preview", set by src/runtime/native-preview.js) or, in older/other
// result shapes, an object carrying { status, previewPath, url, ... }. Treating the
// string case as the object silently made `runtime.status` always undefined, so the
// "Open the test UI" link (and the Live indicator) never rendered even after a
// successful Run. This only reads it as the runtime object when it actually is one.
function extractRuntime(result) {
  if (result?.runtime && typeof result.runtime === 'object') return result.runtime;
  if (result?.result?.runtime && typeof result.result.runtime === 'object') return result.result.runtime;
  if (result?.previewPath || result?.url || result?.publicUiUrl) return result;
  return null;
}

function renderRepairAction(errorText) {
  if (!state.projectId) return;
  const box = document.createElement('div'); box.className = 'msg ai';
  const isSecurity = /RELEASE_SECURITY_BLOCKED|security issue|security warning/i.test(errorText);
  const title = document.createElement('div');
  title.textContent = isSecurity ? '🛡️ Security fix available' : '🛠️ Fix this problem with AI';
  title.style.fontWeight = '700';
  box.appendChild(title);
  const note = document.createElement('div');
  note.className = 'small';
  note.textContent = isSecurity
    ? 'The report above contains the file, root cause, and recommended fix. AI will use it as evidence and apply the smallest safe patch.'
    : 'AI will inspect the error, logs, recent activity, and affected files before changing anything.';
  box.appendChild(note);
  const row = document.createElement('div'); row.className = 'actionCard';
  const b = document.createElement('button'); b.textContent = isSecurity ? '🛡️ Fix security issue' : '🛠️ Diagnose & Fix';
  b.onclick = async () => {
    if (state.busy) return;
    setBusy(true, isSecurity ? 'Fixing security…' : 'Diagnosing & fixing…');
    try {
      const feedback = (isSecurity ? 'SAFE REPAIR\n' : 'DIAGNOSE_AND_FIX\n')
        + 'USER REQUEST: diagnose and fix the problem\n\nEVIDENCE REPORT:\n' + String(errorText || '').slice(0, 8000);
      const form = new FormData();
      form.append('feedback', feedback);
      const response = await fetch('/api/projects/' + state.projectId + '/improve', { method: 'POST', body: form });
      const r = await response.json().catch(() => ({}));
      if (!response.ok) {
        setBusy(false);
        const needsKey = /AI key|not configured|AI_UNAVAILABLE|No active AI/i.test(String(r.error || ''));
        add('ai', needsKey
          ? (uiT('msg.needsAiKey', 'Deterministic checks only — add an AI key in ⚙ Settings (Gemini recommended) to let AI repair this.') + '\n' + (r.error || ''))
          : (r.error || 'Diagnose could not start.'), { force: true });
        return;
      }
      if (r.jobId) watch(r.jobId);
      else setBusy(false);
    } catch (e) {
      handleJobActionError(e);
    }
  };
  row.appendChild(b); box.appendChild(row);
  $('chat').appendChild(box); $('chat').scrollTop = $('chat').scrollHeight;
}

function summarizeResult(result, status) {
  const runtime = extractRuntime(result);
  if (result?.provider || result?.model) { /* attribution shown on brief */ }
  if (status === 'failed' && !result.brief) {
    if (/JOB_TIMEOUT/i.test(String(result.error || ''))) {
      add('ai', 'Timed out — the AI or network took too long. Tap Cancel if still busy, or Switch model in Settings, then try again.');
    } else {
      add('ai', result.error || 'RESULT: Not ready.\nNEXT: Use Diagnose & Fix above, or tell me what you want changed.');
    }
    return;
  }
  if (runtime?.status === 'passed' && (runtime.previewPath || runtime.url || runtime.publicUiUrl)) {
    addLink('Open the test UI', runtime.publicUiUrl || runtime.previewPath || runtime.url, runtime.publicUiUrl || runtime.previewPath || runtime.url);
    add('ai', 'Preview is limited: main page only, most buttons off, no Internet. For a real test use 📦 Run ZIP on your PC, or Publish and add it in SoloHost as Unlisted.');
  }
  if (Array.isArray(result.downloads)) {
    result.downloads.forEach((d) => addLink(
      d.kind === 'image' ? 'Download Docker image (.tar)' :
        (d.kind === 'solohost' ? 'Download SoloHost install kit' :
          (d.kind === 'github-fallback' ? 'Download Windows GitHub fallback (.ps1)' : 'Download project ZIP')),
      d.url, d.filename));
  } else if (result.imageFile?.status === 'passed' && result.imageFile?.filename) {
    addLink('Download Docker image (.tar)', `/api/projects/${state.projectId}/image`, result.imageFile.filename);
  }
  if (result.next) add('ai', `Next: ${result.next}`);
  if (Array.isArray(result.questions) && result.questions.length) renderQuestions(result.questions);
  if (Array.isArray(result.checklist)) add('system', result.checklist.join('\n'));
  if (result.workPlan?.steps?.length) renderWorkPlan(result.workPlan);
  if (result.installReady) add('ai', 'Ready to install. The required file is available above.');
  if (result.fallback?.steps && !result.installReady) add('ai', result.fallback.steps.join('\n'));
  if (result.repoChoice && Array.isArray(result.choices)) renderRepoChoices(result.choices);
  if (result.githubPublish?.guide?.classic) {
    add('ai', '🔐 GitHub setup guide:\n' + result.githubPublish.guide.classic.join('\n') + '\n\n⚙ Workflow permission:\n' + (result.githubPublish.guide.workflow || []).join('\n'));
    if (result.githubPublish.guide.tokenUrl) addLink('Open GitHub token page', result.githubPublish.guide.tokenUrl, result.githubPublish.guide.tokenUrl);
  }
}
function renderWorkHistory(history) {
  const box = document.createElement('div'); box.className = 'msg system';
  const title = document.createElement('div'); title.textContent = '🕘 Recent work'; title.style.fontWeight = '700'; box.appendChild(title);
  history.slice(-12).forEach((item) => {
    const row = document.createElement('div');
    const mark = item.status === 'done' ? '✓' : item.status === 'failed' ? '⚠' : '•';
    row.textContent = `${mark} ${item.type}: ${item.summary || item.error || item.status}`;
    box.appendChild(row);
  });
  $('chat').appendChild(box); maybeJump();
}
function renderWorkPlan(plan) {
  const box = document.createElement('div'); box.className = 'msg system';
  const title = document.createElement('div');
  title.textContent = `📋 Job plan · ${plan.status || 'running'}`;
  title.style.fontWeight = '700'; box.appendChild(title);
  (plan.steps || []).forEach((step) => {
    const row = document.createElement('div');
    const marker = step.status === 'done' ? '✓' : step.status === 'failed' ? '⚠' : step.status === 'blocked' ? '⏸' : step.status === 'running' ? '•' : '○';
    row.textContent = `${marker} ${step.order || ''}. ${step.goal || step.action || 'Step'}${step.error ? ` — ${step.error}` : ''}`;
    box.appendChild(row);
  });
  if (plan.handoff) {
    const note = document.createElement('div'); note.className = 'small'; note.textContent = plan.handoff; box.appendChild(note);
  }
  $('chat').appendChild(box); maybeJump();
}
function renderRepoChoices(choices) {
  const box = document.createElement('div'); box.className = 'msg ai';
  const title = document.createElement('div'); title.textContent = '📦 Repository already exists'; box.appendChild(title);
  const row = document.createElement('div'); row.className = 'actionCard';
  (choices || []).slice(0, 2).forEach((choice) => {
    const b = document.createElement('button'); b.textContent = choice.label; b.onclick = async () => {
      if (state.busy) return; setBusy(true, 'Publishing…');
      try {
        const body = { approved: true, confirm: true, push: true, existingAction: choice.action, repoName: choice.repoName };
        const r = await api(`/api/projects/${state.projectId}/release`, { method: 'POST', body: JSON.stringify(body) });
        watch(r.jobId);
      } catch (e) { handleJobActionError(e); }
    }; row.appendChild(b);
  });
  box.appendChild(row); $('chat').appendChild(box); maybeJump();
}
function addLink(label, href, text) {
  const el = document.createElement('div'); el.className = 'msg ai';
  const p = document.createElement('div'); p.textContent = label; el.appendChild(p);
  // Fix: many embedded WebViews (including Pi Desktop's) don't support opening a new
  // tab/window at all — target="_blank" and window.open() silently do nothing when
  // tapped there. Resolve to an absolute URL (relative "/preview/..." only worked by
  // accident, and breaks if copied elsewhere) and, on click, try a new tab first;
  // if the environment blocks/ignores that, fall back to same-tab navigation, which
  // works everywhere. Desktop-browser users keep normal right-click/long-press.
  let absolute = href;
  try { absolute = new URL(href, window.location.origin).href; } catch {}
  const a = document.createElement('a');
  a.href = absolute; a.rel = 'noopener'; a.textContent = text || absolute; a.style.color = '#8b7cff'; a.style.fontWeight = '700';
  a.addEventListener('click', (e) => {
    // Same-tab is the reliable path in Pi Desktop WebViews. The preview page
    // itself has a project-aware Back link, so browser history cannot land on New App.
    e.preventDefault();
    window.location.assign(absolute);
  });
  el.appendChild(a);
  $('chat').appendChild(el); $('chat').scrollTop = $('chat').scrollHeight;
}
function renderQuestions(questions) {
  const list = (questions || []).slice(0, 3);
  if (!list.length) return;
  state.pendingAnswers = {};
  state.awaitingChoices = true;
  const box = document.createElement('div'); box.className = 'msg ai';
  const title = document.createElement('div'); title.textContent = 'Choose every option below, or type your own answers in chat.'; box.appendChild(title);
  list.forEach((q, i) => {
    const key = q.id || `q${i}`;
    const qEl = document.createElement('div'); qEl.style.marginTop = '8px'; qEl.textContent = `${i + 1}. ${q.question}`; box.appendChild(qEl);
    const row = document.createElement('div'); row.className = 'actionCard';
    (q.options || []).slice(0, 4).forEach((option) => {
      const b = document.createElement('button'); b.textContent = option;
      b.onclick = () => {
        if (state.busy) return;
        state.pendingAnswers[key] = option;
        row.querySelectorAll('button').forEach((x) => { x.style.outline = ''; });
        b.style.outline = '2px solid #8b7cff';
        const left = list.filter((item, idx) => !state.pendingAnswers[item.id || `q${idx}`]).length;
        hint.textContent = left ? `${left} choice(s) left. Or type a custom answer in chat.` : 'All choices picked. Tap Continue.';
        go.disabled = left > 0;
      };
      row.appendChild(b);
    });
    box.appendChild(row);
  });
  const hint = document.createElement('div'); hint.className = 'small'; hint.textContent = 'Pick every choice, or type your own answers and send.'; box.appendChild(hint);
  const go = document.createElement('button'); go.textContent = 'Continue'; go.disabled = true; go.style.marginTop = '8px';
  go.onclick = () => submitQuestionAnswers(list);
  box.appendChild(go);
  $('chat').appendChild(box); $('chat').scrollTop = $('chat').scrollHeight;
}
async function submitQuestionAnswers(questions) {
  if (state.busy) return;
  if (!state.projectId) { add('ai', 'Create the project first, then answer the choices.'); return; }
  const answers = { ...(state.pendingAnswers || {}) };
  questions.forEach((q, i) => { if (!answers[q.id || `q${i}`] && q.question) answers[q.id || `q${i}`] = q.question; });
  state.awaitingChoices = false;
  setBusy(true, 'Saving your choices…');
  try {
    const r = await api(`/api/projects/${state.projectId}/answer`, { method: 'POST', body: JSON.stringify({ answers }) });
    watch(r.jobId);
  } catch (e) { handleJobActionError(e); }
}
async function inspectDocker() {
  if (state.busy) return;
  setBusy(true, 'Reading Docker apps…');
  try {
    const data = await api('/api/docker/containers?all=0');
    if (data.status !== 'passed') throw new Error(data.reason || data.error || 'Docker is not available.');
    if (!data.items.length) add('ai', 'No running Docker apps were found.');
    else {
      add('ai', `I found ${data.items.length} running Docker app(s). Pick one to analyze:`);
      data.items.slice(0, 20).forEach((c) => {
        const box = document.createElement('div'); box.className = 'msg system';
        const title = document.createElement('div'); title.textContent = `🐳 ${c.name} · ${c.image} · ${c.status}`; box.appendChild(title);
        const row = document.createElement('div'); row.className = 'actionCard';
        for (const [label, fn] of [['🔎 Check', () => inspectNamedContainer(c.name)], ['📥 Copy', () => importContainer(c.name)]]) { const b = document.createElement('button'); b.textContent = label; b.onclick = fn; row.appendChild(b); }
        box.appendChild(row); $('chat').appendChild(box);
      });
      $('chat').scrollTop = $('chat').scrollHeight;
      add('ai', 'Choose Check to inspect an app, or Copy to turn it into a project for upgrades.');
    }
  } catch (e) { add('ai', e.message); }
  finally { setBusy(false); }
}
async function inspectNamedContainer(name) {
  if (state.busy) return;
  setBusy(true, 'Analyzing Docker app…');
  try {
    const r = await api(`/api/docker/containers/${encodeURIComponent(name)}/analyze`, { method: 'POST', body: '{}' });
    add('ai', `${r.container.name || name}\nImage: ${r.container.image}\nState: ${r.container.state}\nHealth: ${r.container.health}\nFindings: ${r.findings.length}`);
    if (r.logs) add('system', r.logs.slice(-3500), { small: 'Recent container logs' });
    if (r.findings.length) r.findings.forEach((f) => add(f.severity === 'critical' ? 'error' : 'system', `${f.title}: ${f.detail}`));
    add('ai', 'If you want, I can copy this running app into a project and work on it like any other app.');
  } catch (e) { add('ai', e.message); }
  finally { setBusy(false); }
}
async function handleTextCommand(text) {
  const m = text.match(/^(?:analyze|inspect|check)\s+(?:docker\s+)?(?:app|container)?\s*[:#]?\s*(\S+)$/i);
  if (m && !state.projectId) return inspectNamedContainer(m[1]);
  const c = text.match(/^(?:copy|import)\s+(?:docker\s+)?(?:app|container)?\s*[:#]?\s*(\S+)$/i);
  if (c && !state.projectId) return importContainer(c[1]);
  return sendMessage();
}
async function importContainer(name) {
  if (state.busy) return;
  setBusy(true, 'Copying Docker app into a project…');
  try { const r = await api(`/api/docker/containers/${encodeURIComponent(name)}/import`, { method: 'POST', body: '{}' }); state.projectId = r.projectId; await loadProjects(); await openProject(r.projectId, false); add('ai', 'The running Docker app is now a project. I can inspect, fix, test, and improve it here.'); } catch (e) { add('ai', e.message); } finally { setBusy(false); }
}
function renderFiles() { $('attachments').innerHTML = state.files.map((f, i) => `<span class="attachment">📎 ${esc(f.name)} <button data-remove="${i}">×</button></span>`).join(''); }
function esc(v) { return String(v || '').replace(/[&<>'"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function renderHubList(hub) {
  const box = $('hubList');
  if (!box) return;
  const rows = hub?.connections || [];
  if (!rows.length) { box.textContent = 'No AI provider connected yet.'; return; }
  box.innerHTML = rows.map((c) => {
    const models = c.models || [];
    const verified = models.filter(m => m.verified).length || 0;
    const modelIds = models.map(m => m.id).filter(Boolean).slice(0, 4).join(', ');
    const buttons = `<span class="hubActions"><button type="button" data-hub-refresh="${esc(c.id)}">↻</button><button type="button" data-hub-remove="${esc(c.id)}">×</button></span>`;
    return `<div class="hubRow"><span>${c.status === 'VERIFIED' && verified ? '✓' : '•'} ${esc(c.name)} · ${esc(c.masked || 'key')} · ${verified}/${models.length || 0} models${modelIds ? ` · ${esc(modelIds)}` : ''}</span>${buttons}</div>`;
  }).join('');
}
async function addHubProvider() {
  const provider = $('hubProvider')?.value;
  const apiKey = $('hubKey')?.value?.trim();
  const baseUrl = $('hubBase')?.value?.trim();
  if (!apiKey) { $('settingsState').textContent = 'Paste an API key first.'; return; }
  $('settingsState').textContent = 'Checking token and discovering usable models…';
  try {
    const selectedModel = ($('hubModel')?.value || '').trim();
    const r = await api('/api/ai/hub/connect', { method: 'POST', body: JSON.stringify({ provider, apiKey, baseUrl }) });
    $('hubKey').value = ''; $('hubBase').value = '';
    if (selectedModel && selectedModel.startsWith(provider + ':')) {
      await api('/api/ai/hub/routing', { method: 'POST', body: JSON.stringify({ preferredProvider: provider, preferredModels: [selectedModel] }) });
    } else if (selectedModel && !selectedModel.includes(':')) {
      await api('/api/ai/hub/routing', { method: 'POST', body: JSON.stringify({ preferredProvider: provider, preferredModels: [`${provider}:${selectedModel}`] }) });
    }
    await loadHub();
    $('settingsState').textContent = `${provider} added. First key is used first. Tap Save if you also set GitHub.`;
    await loadStatus();
  } catch (e) { $('settingsState').textContent = e.message; }
}
async function refreshHub(id) {
  try {
    const r = await api('/api/ai/hub/refresh', { method: 'POST', body: JSON.stringify({ id }) });
    renderHubList(r.hub); $('settingsState').textContent = 'Models refreshed. Only previously verified models remain eligible until verified again.';
  } catch (e) { $('settingsState').textContent = e.message; }
}
async function removeHub(id) {
  try {
    const r = await api('/api/ai/hub/remove', { method: 'POST', body: JSON.stringify({ id }) });
    renderHubList(r.hub); $('settingsState').textContent = 'Connection removed.'; await loadStatus();
  } catch (e) { $('settingsState').textContent = e.message; }
}
async function loadSettings() {
  try {
    state.settings = await api('/api/settings');
    $('setGhOwner').value = state.settings.github?.owner || '';
    $('settingsState').textContent = '';
    await loadHub();
  } catch {}
}
async function saveSettings() {
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify({ GITHUB_TOKEN: $('setGhToken').value, GITHUB_OWNER: $('setGhOwner').value, setupComplete: true }) });
    $('setGhToken').value = '';
    $('settingsState').textContent = 'Saved.';
    await loadStatus(); await loadHub();
  } catch (e) { $('settingsState').textContent = e.message; }
}
function renderGuide(guide) {
  if (!guide?.label) return;
  const box = document.createElement('div'); box.className = 'msg ai';
  const t = document.createElement('div'); t.textContent = `Next step ${guide.step || ''}: ${guide.title || ''}`.trim(); box.appendChild(t);
  const d = document.createElement('div'); d.className = 'small'; d.textContent = guide.detail || ''; box.appendChild(d);
  if (guide.label && guide.action) {
    const row = document.createElement('div'); row.className = 'actionCard';
    const b = document.createElement('button'); b.textContent = guide.label; b.onclick = () => { if (state.busy) return; quick(guide.action, guide.payload || {}); }; row.appendChild(b);
    box.appendChild(row);
  }
  $('chat').appendChild(box); maybeJump();
}
function renderWelcome() {
  const chat = $('chat');
  if (!chat) return;
  chat.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'msg ai welcomeCard';
  const title = uiT('welcome.title', 'App Builder — Pi SoloHost');
  const body = uiT('welcome.body', 'Type an idea, paste a GitHub link to upgrade, attach a ZIP, or ask to change a feature. One chat — I route the rest.');
  const ideaLabel = uiT('welcome.idea', '💡 Sample idea');
  const ghLabel = uiT('welcome.github', '🔗 Paste GitHub link');
  const setLabel = uiT('welcome.settings', '⚙ Connect AI');
  box.innerHTML = `
    <h2>${title}</h2>
    <p>${body}</p>
    <div class="welcomeActions">
      <button type="button" class="primary" data-welcome="idea">${ideaLabel}</button>
      <button type="button" data-welcome="github">${ghLabel}</button>
      <button type="button" data-welcome="settings">${setLabel}</button>
    </div>`;
  chat.appendChild(box);
  const bindWelcome = (sel, fn) => { const b = box.querySelector(sel); if (b) b.onclick = fn; };
  bindWelcome('[data-welcome="idea"]', () => {
    if ($('message')) { $('message').value = uiT('welcome.ideaText', 'Create a simple sales app for a small shop'); $('message').focus(); }
  });
  bindWelcome('[data-welcome="github"]', () => {
    if ($('message')) { $('message').value = 'https://github.com/'; $('message').focus(); }
  });
  bindWelcome('[data-welcome="settings"]', () => {
    if (typeof openSettings === 'function') openSettings();
    else $('settings')?.removeAttribute('hidden');
  });
  const chip = $('contextChip');
  if (chip) {
    chip.hidden = false;
    chip.textContent = uiT('welcome.chip', '💡 Try: milk-tea shop app');
    chip.onclick = () => {
      $('message').value = uiT('welcome.chipText', 'Create a milk-tea shop app with menu and cart');
      $('message').focus();
    };
  }
}

$('sendBtn').onclick = () => { if (state.busy) return cancelCurrentJob(); return handleTextCommand($('message').value.trim()); };

// UI_SIMPLE more menu
$('moreBtn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = $('moreMenu');
  if (!menu) return;
  menu.hidden = !menu.hidden;
});
document.addEventListener('click', () => { const m = $('moreMenu'); if (m) m.hidden = true; });
$('moreMenu')?.addEventListener('click', (e) => e.stopPropagation());
document.querySelectorAll('#moreMenu [data-more]').forEach((btn) => {
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const act = btn.dataset.more;
    const menu = $('moreMenu');
    if (menu) menu.hidden = true;
    try {
      // Same actions as v1.7.4 data-action buttons (via quick)
      if (act === 'export') return quick('export');
      if (act === 'import') return quick('import');
      if (act === 'sandbox') return quick('sandbox');
      if (act === 'script-run') return quick('script-run');
      if (act === 'script-github') return quick('script-github');
      if (act === 'rollback') return quick('rollback');
      if (act === 'support') return quick('support');
    } catch (err) {
      add('ai', err.message || String(err));
    }
  });
});

$('message').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleTextCommand($('message').value.trim()); } });
document.querySelectorAll('[data-action]').forEach((b) => {
  b.onclick = (e) => {
    // quickActions handles its own buttons
    if (b.closest('#quickActions')) return;
    e.preventDefault();
    const a = b.dataset.action;
    if (a === 'publish') quick('publish', { approved: true, confirm: true, push: true });
    else quick(a);
  };
});
if ($('liveBtn')) $('liveBtn').onclick = () => stopLive();
$('attachBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = () => { state.files.push(...Array.from($('fileInput').files || [])); renderFiles(); $('fileInput').value = ''; };
$('attachments').onclick = (e) => { const b = e.target.closest('[data-remove]'); if (b) { state.files.splice(Number(b.dataset.remove),1); renderFiles(); } };
$('settingsBtn').onclick = () => { loadSettings(); $('settings').hidden = false; };
$('closeSettings').onclick = () => $('settings').hidden = true;
$('saveSettings').onclick = saveSettings;
if ($('hubAdd')) $('hubAdd').onclick = addHubProvider;

function renderModelBadges(models) {
  const box = $('hubModelBadges');
  if (!box) return;
  box.innerHTML = '';
  (models || []).slice(0, 24).forEach((m) => {
    const id = m.id || m;
    const verified = m.verified === true;
    const failed = m.verified === false && m.lastError;
    const icon = verified ? '✅' : (failed ? '⚠' : '⚪');
    const span = document.createElement('button');
    span.type = 'button';
    span.className = 'ws-btn';
    span.style.cssText = 'font-size:12px;padding:2px 8px';
    span.textContent = `${icon} ${id}`;
    span.title = failed ? String(m.lastError || 'failed') : (verified ? 'verified' : 'untested');
    span.onclick = () => {
      if ($('hubModel')) $('hubModel').value = String(id).includes(':') ? id : `${($('hubProvider')?.value || 'gemini')}:${id}`;
      if ($('routingSelected')) $('routingSelected').checked = true;
    };
    box.appendChild(span);
  });
}

if ($('hubLoadModels')) $('hubLoadModels').onclick = async () => {
  const b = $('hubLoadModels'); const old = b.textContent;
  b.disabled = true; b.textContent = 'Loading…';
  try {
    const provider = ($('hubProvider')?.value || '').trim();
    const apiKey = ($('hubKey')?.value || '').trim();
    const baseUrl = ($('hubBase')?.value || '').trim();
    if (!provider) {
      $('settingsState').textContent = 'Choose an AI provider first.';
      return;
    }
    $('settingsState').textContent = apiKey
      ? `Fetching models from ${provider} with the key you entered…`
      : `Fetching models for ${provider} (using saved key if any)…`;
    const r = await api('/api/ai/hub/discover', {
      method: 'POST',
      body: JSON.stringify({ provider, apiKey, baseUrl }),
    });
    fillModelOptionsFromList(r.models || [], provider);
    if (r.hub) {
      renderHubList(r.hub);
      renderModelSelectors(r.hub);
    }
    const n = (r.models || []).length;
    // v2.1: Load models lists only — does not auto-fill model box or preferredModels
    if (typeof renderModelBadges === 'function') renderModelBadges(r.models || r || []);
    $('settingsState').textContent = n
      ? `Loaded ${n} model(s) from ${provider}. Type or pick a model, then ＋ Add.`
      : (r.warning || `No models returned for ${provider}. You can still type a model id manually.`);
  } catch (e) {
    $('settingsState').textContent = e.message || 'Could not load models. Check provider + API key.';
  } finally {
    b.disabled = false; b.textContent = old;
  }
};
if ($('hubRefresh')) $('hubRefresh').onclick = async () => { const rows = await api('/api/ai/hub'); for (const c of (rows.connections || [])) await refreshHub(c.id); };
$('hubList').addEventListener('click', (e) => { const r=e.target.closest('[data-hub-refresh]'); const x=e.target.closest('[data-hub-remove]'); if(r) refreshHub(r.dataset.hubRefresh); if(x) removeHub(x.dataset.hubRemove); });
if ($('hubProvider')) $('hubProvider').onchange = () => {
  if ($('hubBaseWrap')) $('hubBaseWrap').hidden = $('hubProvider').value !== 'custom';
};
if ($('aiSelect')) $('aiSelect').onchange = async () => {
  const provider = $('aiSelect').value; if (!provider) return;
  const hub = await api('/api/ai/hub');
  const conn = (hub.connections || []).find((c) => c.provider === provider);
  const rows = (conn?.models || []).slice();
  const auto = rows.find((m) => String(m.id || '').toLowerCase() === 'auto');
  const verified = rows.filter((m) => m.verified);
  const pick = auto ? [auto, ...verified.filter((m) => m.id !== auto.id)] : (verified.length ? verified : rows);
  const preferredModels = pick.slice(0, 2).map((m) => `${provider}:${m.id}`);
  const applied = await api('/api/ai/hub/routing', { method: 'POST', body: JSON.stringify({ preferredProvider: provider, preferredModels }) });
  await loadHub();
  const name = conn?.name || provider;
  add('system', `AI provider is now ${name}${preferredModels[0] ? ` · ${preferredModels[0].split(':').slice(1).join(':')}` : ''}.`);
  $('aiSelect').value = applied?.hub?.preferredProvider || provider;
};
if ($('hubModel')) $('hubModel').onchange = async () => {
  const first = $('hubModel').value;
  if (!first) return;
  await api('/api/ai/hub/routing', { method: 'POST', body: JSON.stringify({ preferredProvider: first.split(':')[0], preferredModels: [first] }) });
  await loadHub();
  if ($('settingsState')) $('settingsState').textContent = `Model selected: ${first}`;
};

function parseModelListFile(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  try {
    const j = JSON.parse(raw);
    if (Array.isArray(j)) return j.map((x) => (typeof x === 'string' ? x : (x.id || x.name || ''))).filter(Boolean);
    if (Array.isArray(j.models)) return j.models.map((x) => (typeof x === 'string' ? x : (x.id || x.name || ''))).filter(Boolean);
    if (j.data && Array.isArray(j.data)) return j.data.map((x) => x.id || x).filter(Boolean);
  } catch {}
  return raw.split(/[\n,]+/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
}

async function importModelListFromFile(file) {
  if (!file) return;
  const text = await file.text();
  const models = parseModelListFile(text);
  if (!models.length) throw new Error('No model ids in file. Use JSON ["model-a"] or one id per line.');
  const provider = $('hubProvider')?.value || '';
  const r = await api('/api/ai/hub/models/import', {
    method: 'POST',
    body: JSON.stringify({ models, provider }),
  });
  await loadHub();
  if ($('hubModel') && r.preferredModels?.[0]) $('hubModel').value = r.preferredModels[0];
  if ($('settingsState')) $('settingsState').textContent = `Imported ${r.imported || models.length} model(s). Selected: ${r.preferredModels?.[0] || models[0]}`;
  return r;
}

$('projectSelect').onchange = async () => { if (state.busy) return; state.projectId = $('projectSelect').value || null; if (state.projectId) await openProject(state.projectId); else { rememberProject(null); renderWelcome(); } };
$('jumpDown').onclick = () => { $('chat').scrollTop = $('chat').scrollHeight; $('jumpDown').hidden = true; };
$('chat').addEventListener('scroll', maybeJump);
setBusy(false, 'Ready');
$('chat').addEventListener('click', (e) => { const b = e.target.closest('[data-container]'); if (b) inspectNamedContainer(b.dataset.container); });


function renderOverwriteConfirm(result = {}) {
  const chat = $('chat');
  if (!chat) return;
  const box = document.createElement('div');
  box.className = 'msg ai';
  const msg = result.message || result.error || uiT('msg.repoExists', 'This GitHub repository already has content. Overwrite or cancel?');
  box.textContent = String(msg);
  const row = document.createElement('div');
  row.className = 'actionCard';
  const over = document.createElement('button');
  over.textContent = uiT('msg.overwrite', 'Overwrite');
  over.onclick = () => {
    box.remove();
    quick('publish', { approved: true, confirm: true, push: true, existingAction: 'overwrite', forcePublish: true });
  };
  const cancel = document.createElement('button');
  cancel.textContent = uiT('msg.cancel', 'Cancel');
  cancel.onclick = () => box.remove();
  row.appendChild(over);
  row.appendChild(cancel);
  box.appendChild(row);
  chat.appendChild(box);
  $('chat').scrollTop = $('chat').scrollHeight;
}

function openSupport() {
  const modal = $('supportModal');
  if (modal) modal.hidden = false;
  const title = modal?.querySelector('h2');
  if (title) title.textContent = uiT('support.title', '💛 Support this project');
  const info = modal?.querySelector('.info');
  if (info) info.textContent = uiT('support.body', 'Thank you for supporting App Builder — Pi SoloHost. Choose Pi Wallet or MB Bank, copy the details, and send what you can.');
  add('ai', uiT('support.body', 'Thank you for supporting App Builder — Pi SoloHost. Choose Pi Wallet or MB Bank, copy the details, and send what you can.'), { force: true });
}
function bindSupport() {
  const modal = $('supportModal');
  if (!modal) return;
  $('closeSupport').onclick = () => { modal.hidden = true; };
  modal.querySelectorAll('.supportTab').forEach((tab) => {
    tab.onclick = () => {
      modal.querySelectorAll('.supportTab').forEach((x) => x.classList.toggle('on', x === tab));
      $('supportPi').hidden = tab.dataset.support !== 'pi';
      $('supportMb').hidden = tab.dataset.support !== 'mb';
    };
  });
  modal.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.onclick = async () => {
      try { await navigator.clipboard.writeText(btn.dataset.copy); add('system', 'Copied. Thank you for supporting this project.'); }
      catch { add('system', btn.dataset.copy); }
    };
  });
}
/* Quick actions — data-action → quick() (must run even if later init fails) */
(function wireQuickActions() {
  const root = document.getElementById('quickActions');
  if (!root) return;
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn || !root.contains(btn)) return;
    e.preventDefault();
    e.stopPropagation();
    const action = btn.getAttribute('data-action');
    if (!action) return;
    if (action === 'support') {
      quick('support');
      return;
    }
    if (state.busy && (action === 'run' || action === 'publish')) {
      const bar = document.getElementById('busyBar');
      if (bar && bar.hidden) state.busy = false;
    }
    if (state.busy) {
      add('system', uiT('msg.busy', 'Wait for the current step to finish…'), { force: true });
      return;
    }
    if (action === 'publish') {
      if (!state.projectId) { add('ai', uiT('msg.needApp', 'Open or create an app first.'), { force: true }); return; }
      quick('publish', { approved: true, confirm: true, push: true });
      return;
    }
    if (action === 'run') {
      if (!state.projectId) { add('ai', uiT('msg.needApp', 'Open or create an app first.'), { force: true }); return; }
      quick('run');
      return;
    }
    quick(action);
  });
})();

window.addEventListener('paf-locale', () => {
  try {
    if (!state.projectId) renderWelcome();
    if (window.pafI18n && typeof window.pafI18n.apply === 'function') window.pafI18n.apply();
  } catch {}
});

bindSupport();
async function init() {
  try {
    await Promise.all([loadStatus(), loadProjects(), loadSettings()]);
    const id = savedProjectId();
    if (id && state.projects.some((p) => p.id === id)) await openProject(id, false);
    else {
      state.projectId = null;
      rememberProject(null);
      if ($('projectSelect')) $('projectSelect').value = '';
      renderWelcome();
    }
  } catch (err) {
    console.error('init failed', err);
    try { renderWelcome(); } catch (e2) { console.error(e2); }
  }
}
init();

/* Language: #langToggle wired in public/i18n.js */




// Routing mode Auto / Choose
async function applyRoutingModeFromUi() {
  const mode = $('routingSelected')?.checked ? 'SELECTED' : 'AUTO';
  const model = ($('hubModel')?.value || '').trim();
  const provider = ($('hubProvider')?.value || $('aiSelect')?.value || '').trim();
  const body = { mode };
  if (mode === 'SELECTED' && model) {
    body.preferredModels = [model.includes(':') ? model : `${provider}:${model}`];
    body.preferredProvider = provider;
  } else {
    body.preferredModels = [];
  }
  try {
    await api('/api/ai/hub/routing', { method: 'POST', body: JSON.stringify(body) });
  } catch (e) {
    if ($('settingsState')) $('settingsState').textContent = e.message || 'Routing update failed';
  }
}
if ($('routingAuto')) $('routingAuto').onchange = applyRoutingModeFromUi;
if ($('routingSelected')) $('routingSelected').onchange = applyRoutingModeFromUi;

async function runAiDoctor() {
  try {
    if ($('settingsState')) $('settingsState').textContent = 'Running AI check…';
    const r = await api('/api/ai/doctor');
    const lines = (r.steps || []).map((s) => `${s.ok ? '✅' : '✖'} ${s.id}: ${s.detail || ''}`);
    const msg = [`AI Doctor: ${r.status || (r.ok ? 'healthy' : 'degraded')}`, ...lines].join('\n');
    if ($('settingsState')) $('settingsState').textContent = msg;
    add('system', msg, { force: true });
  } catch (e) {
    if ($('settingsState')) $('settingsState').textContent = e.message || 'AI check failed';
  }
}
if ($('aiDoctorBtn')) $('aiDoctorBtn').onclick = () => runAiDoctor();
