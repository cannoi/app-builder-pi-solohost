const $ = (id) => document.getElementById(id);
const state = { projectId: null, projects: [], busy: false, jobId: null, poll: null, seenEvents: 0, files: [], settings: null };

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
function add(role, text, meta = {}) {
  if (!text) return;
  const stick = chatNearBottom();
  const el = document.createElement('div'); el.className = `msg ${role}`; el.textContent = text;
  if (meta.small) { const s = document.createElement('span'); s.className = 'small'; s.textContent = meta.small; el.appendChild(s); }
  $('chat').appendChild(el); if (stick) $('chat').scrollTop = $('chat').scrollHeight; else maybeJump();
}
function event(stage, status, message) {
  const el = document.createElement('div'); el.className = `event ${status}`; el.textContent = `${status === 'done' ? '✓' : status === 'failed' ? '⚠' : '•'} ${message}`;
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
  } catch (e) { setBusy(false); add('ai', e.message); }
}
function setBusy(on, text = 'Working…') {
  state.busy = on;
  $('busyBar').hidden = !on;
  $('busyText').textContent = on ? text : 'Ready';
  if ($('workPill')) { $('workPill').textContent = on ? 'Working' : 'Ready'; $('workPill').className = on ? 'pill work' : 'pill ready'; }
  document.querySelectorAll('.quickGroups button,#attachBtn,#message').forEach((x) => { x.disabled = on; });
  if ($('projectSelect')) $('projectSelect').disabled = on;
  // Send button turns into a Stop button while a job is running, instead of being disabled.
  const sendBtn = $('sendBtn');
  if (sendBtn) {
    sendBtn.disabled = false;
    sendBtn.textContent = on ? '■' : '➤';
    sendBtn.title = on ? 'Stop / cancel current action' : 'Send';
    sendBtn.classList.toggle('stopMode', on);
  }
}
async function cancelCurrentJob() {
  if (!state.busy) return;
  const jobId = state.jobId;
  clearInterval(state.poll); state.poll = null;
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
function actionText(action) { return ({ build:'Build the app', run:'Run the app', improve:'Improve the app', edit:'Edit the app', analyze:'Check the app', publish:'Prepare the release', sandbox:'Test the sandbox' })[action] || action; }

async function loadStatus() {
  try {
    const s = await api('/api/status'); state.settings = s;
    const mode = s.ai?.mode === 'council' ? 'council' : (s.ai?.provider || 'deepseek');
    if ($('aiSelect')) $('aiSelect').value = mode;
    if ($('setProvider')) $('setProvider').value = mode;
  } catch {}
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
async function openProject(id, announce = true) {
  state.projectId = id; rememberProject(id); await loadProjects();
  const p = await api(`/api/projects/${id}`);
  $('chat').innerHTML = '';
  const recent = Array.isArray(p.releases) ? p.releases : [];
  const activity = await api(`/api/activity?projectId=${encodeURIComponent(id)}`).catch(() => ({items:[]}));
  const running = activity.items?.find((x) => x.running);
  if (running) add('system', `↻ ${running.type} is still running · ${running.stage || 'working'}`);
  const last = activity.items?.find((x) => !x.running);
  if (last?.status === 'failed' && last.error) add('system', `⚠ Last issue: ${String(last.error).split('\n')[0].slice(0, 220)}`);
  if (p.chat?.length) p.chat.forEach((m) => add(m.role === 'user' ? 'user' : m.role === 'assistant' ? 'ai' : 'system', m.message));
  else add('ai', `I’m ready to build ${p.name}. Tell me what you want next.`);
  if (p.workPlan?.steps?.length) renderWorkPlan(p.workPlan);
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
    } catch (e) { setBusy(false); add('ai', e.message); }
    return;
  }
  const files = state.files.slice(); state.files = []; renderFiles();
  if (message) { add('user', message); $('message').value = ''; }
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
    } catch (e) { setBusy(false); add('ai', e.message); }
  };
  input.click();
}
async function startSandboxDemo() {
  setBusy(true, 'Testing sandbox…');
  try {
    const r = await api('/api/projects/sandbox-demo', { method: 'POST', body: '{}' });
    add('ai', 'Starting Sandbox Benchmark: runtime + Internet/DNS + browser checks. This separates Sandbox network problems from app problems.');
    watch(r.jobId);
  } catch (e) { setBusy(false); add('ai', e.message); }
}
async function quick(action, extraPayload = {}) {
  if (state.busy) return;
  if (action === 'support') return openSupport();
  if (action === 'docker') return inspectDocker();
  if (action === 'sandbox') return startSandboxDemo();
  if (action === 'import') return pickImportZip();
  if (action === 'run') {
    try {
      const probe = await api('/api/sandbox-status');
      if (!probe?.ok) {
        add('ai', 'Tip: tap 🧪 Sandbox first. If that preview fails, the problem is Builder/preview — not your app. If it works, then ▶ Run tests the product.');
      }
    } catch {}
  }
  if (action === 'export') {
    if (!state.projectId) { add('ai', 'Create an app first, then tap Zip.'); return; }
    add('ai', 'Preparing a ZIP of your app…');
    try { await downloadZip(state.projectId, extraPayload.kind || 'project'); }
    catch (e) { add('ai', e.message); }
    return;
  }
  if (!state.projectId) { add('ai', 'Start with your app idea in the chat. I’ll create the project first.'); return; }
  setBusy(true, `${actionText(action)}…`);
  try {
    let r;
    if (action === 'publish') r = await api(`/api/projects/${state.projectId}/release`, { method: 'POST', body: JSON.stringify({ approved: true, confirm: true, push: true, ...extraPayload }) });
    else if (action === 'improve' || action === 'edit') {
      const kind = action === 'edit' ? 'SAFE EDIT' : 'SAFE UPGRADE';
      const request = await askSafeAction(kind);
      if (!request) { setBusy(false); return; }
      const form = new FormData();
      form.append('feedback', `${kind}\nUSER REQUEST: ${request.text}`);
      for (const f of request.files || []) form.append('files', f);
      const response = await fetch(`/api/projects/${state.projectId}/improve`, { method: 'POST', body: form });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'AI improvement could not start.');
      r = data;
    }
    else r = await api(`/api/projects/${state.projectId}/${action}`, { method: 'POST', body: '{}' });
    if (r.needsConfirmation) { setBusy(false); add('ai', `I need your approval before ${actionText(action).toLowerCase()}.`); return; }
    watch(r.jobId);
  } catch (e) { setBusy(false); add('ai', e.message); }
}
async function askSafeAction(kind, initial = '') {
  return new Promise((resolve) => {
    const wrap = document.createElement('div'); wrap.className = 'modal';
    wrap.innerHTML = `<div class="sheet"><div class="sheetHead"><h2>${kind}</h2><button class="iconBtn" type="button">✕</button></div><p class="info">What do you want to change?</p><textarea rows="4" style="width:100%;box-sizing:border-box" placeholder="What do you want to change?"></textarea><div class="inputRow" style="margin-top:10px"><button type="button" class="attach modalAttach" title="Attach files">📎</button><input class="modalFiles" type="file" multiple hidden accept=".zip,.pdf,.txt,.md,.json,.yaml,.yml,.js,.ts,.jsx,.tsx,.html,.css,.py,.go,.rs,.java,.php,.sql,.csv,.png,.jpg,.jpeg,.gif,.webp"><span class="modalFileNames muted">No files</span></div><div class="actionCard"><button class="primary wide" type="button">Send</button></div></div>`;
    document.body.appendChild(wrap); wrap.hidden = false;
    const input = wrap.querySelector('textarea'); const fileInput = wrap.querySelector('.modalFiles'); const names = wrap.querySelector('.modalFileNames');
    input.value = initial;
    const close = () => { wrap.remove(); resolve(null); };
    wrap.querySelector('.iconBtn').onclick = close;
    wrap.querySelector('.modalAttach').onclick = () => fileInput.click();
    fileInput.onchange = () => { const files = Array.from(fileInput.files || []); names.textContent = files.length ? files.map(f => `📎 ${f.name}`).join(' · ') : 'No files'; };
    wrap.querySelector('.primary').onclick = () => { const textValue = input.value.trim(); const files = Array.from(fileInput.files || []); if (!textValue && !files.length) { input.focus(); return; } wrap.remove(); resolve({ text: textValue || 'Inspect the attached files and apply the requested safe change.', files }); };
    input.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') wrap.querySelector('.primary').click(); });
    input.focus();
  });
}

async function watch(jobId) {
  state.jobId = jobId; state.seenEvents = 0;
  clearInterval(state.poll);
  state.poll = setInterval(async () => {
    try {
      const job = await api(`/api/jobs/${jobId}`);
      const events = job.events || [];
      for (let i = state.seenEvents; i < events.length; i++) event(events[i].stage, events[i].status, events[i].message);
      state.seenEvents = events.length;
      if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
        clearInterval(state.poll); state.poll = null; setBusy(false);
        const result = job.result || {};
        if (job.status === 'failed') {
          const failure = String(job.error || 'The action failed.');
          add('ai', failure);
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
        if (result.projectId && result.projectId !== state.projectId) { state.projectId = result.projectId; await loadProjects(); await openProject(result.projectId, false); }
        else if (state.projectId) { await loadProjects(); }
        summarizeResult(result, job.status);
        if (result.guide) renderGuide(result.guide);
        const live = extractRuntime(result);
        if (live?.status === 'passed') setLive(true);
        if (live?.status === 'stopped' || result.status === 'released') setLive(Boolean(live?.status === 'passed'));
        maybeJump();
      }
    } catch (e) { clearInterval(state.poll); state.poll = null; setBusy(false); add('ai', `Connection lost while checking the job: ${e.message}`); }
  }, 700);
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
      const request = await askSafeAction('SAFE REPAIR', isSecurity ? 'Fix the reported security issue.' : 'Fix the reported problem.');
      if (!request) { setBusy(false); return; }
      const form = new FormData();
      form.append('feedback', `SAFE REPAIR\nUSER REQUEST: ${request.text}\n\nEVIDENCE REPORT:\n${errorText}`);
      for (const f of request.files || []) form.append('files', f);
      const response = await fetch(`/api/projects/${state.projectId}/improve`, { method: 'POST', body: form });
      const r = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(r.error || 'Repair could not start.');
      watch(r.jobId);
    } catch (e) { setBusy(false); add('ai', e.message); }
  };
  row.appendChild(b); box.appendChild(row);
  $('chat').appendChild(box); $('chat').scrollTop = $('chat').scrollHeight;
}

function summarizeResult(result, status) {
  const runtime = extractRuntime(result);
  if (status === 'failed' && !result.brief) {
    add('ai', result.error || 'RESULT: Not ready.\nNEXT: Use Diagnose & Fix above, or tell me what you want changed.');
    return;
  }
  if (runtime?.status === 'passed' && (runtime.previewPath || runtime.url || runtime.publicUiUrl)) {
    addLink('Open the test UI', runtime.publicUiUrl || runtime.previewPath || runtime.url, runtime.publicUiUrl || runtime.previewPath || runtime.url);
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
      } catch (e) { setBusy(false); add('ai', e.message); }
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
  } catch (e) { setBusy(false); add('ai', e.message); }
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
async function loadSettings() {
  try {
    state.settings = await api('/api/settings');
    $('setProvider').value = state.settings.ai?.mode === 'council' ? 'council' : (state.settings.ai?.provider || 'deepseek');
    $('setGhOwner').value = state.settings.github?.owner || '';
    $('settingsState').textContent = '';
  } catch {}
}
async function saveSettings() {
  try {
    const raw = $('setProvider').value;
    const body = { AI_PROVIDER: raw === 'council' ? 'deepseek' : raw, AI_MODE: raw === 'council' ? 'council' : 'single', DEEPSEEK_API_KEY: $('setDeepseek').value, GEMINI_API_KEY: $('setGemini').value, GITHUB_TOKEN: $('setGhToken').value, GITHUB_OWNER: $('setGhOwner').value, setupComplete: true };
    const r = await api('/api/settings', { method: 'POST', body: JSON.stringify(body) });
    $('setDeepseek').value = ''; $('setGemini').value = ''; $('setGhToken').value = ''; $('settingsState').textContent = 'Saved. Builder will use the new provider/model on the next task.'; await loadStatus();
    add('system', r.discovery?.model ? `Gemini ready: ${r.discovery.model}` : 'Settings saved.');
    setTimeout(() => { $('settings').hidden = true; }, 350);
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
async function applyAiNow(value) {
  if (state.busy) { await loadStatus(); return; }
  const council = value === 'council';
  const provider = council ? 'deepseek' : value;
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify({ AI_PROVIDER: provider, AI_MODE: council ? 'council' : 'single' }) });
    add('system', council ? 'Council selected. The next task will use both configured models.' : `AI selected: ${provider}. The next task will use an available supported model automatically.`);
    await loadStatus();
  } catch (e) { add('system', e.message); await loadSettings(); }
}
function renderWelcome() {
  $('chat').innerHTML = '';
  add('ai', 'I will take you to a published SoloHost app in three taps:\n1) Tell me the idea\n2) I Build + Run and give you a test link\n3) You tap Publish');
  renderGuide({ step: 1, title: 'Send your idea', action: null, label: '', detail: 'Example: “Build a snake game that saves high scores.”' });
}
$('sendBtn').onclick = () => { if (state.busy) return cancelCurrentJob(); return handleTextCommand($('message').value.trim()); };
$('message').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleTextCommand($('message').value.trim()); } });
document.querySelectorAll('[data-action]').forEach((b) => b.onclick = () => quick(b.dataset.action));
if ($('liveBtn')) $('liveBtn').onclick = () => stopLive();
$('attachBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = () => { state.files.push(...Array.from($('fileInput').files || [])); renderFiles(); $('fileInput').value = ''; };
$('attachments').onclick = (e) => { const b = e.target.closest('[data-remove]'); if (b) { state.files.splice(Number(b.dataset.remove),1); renderFiles(); } };
$('settingsBtn').onclick = () => { loadSettings(); $('settings').hidden = false; };
$('closeSettings').onclick = () => $('settings').hidden = true;
$('saveSettings').onclick = saveSettings;
if ($('aiSelect')) $('aiSelect').onchange = () => applyAiNow($('aiSelect').value);
if ($('setProvider')) $('setProvider').onchange = () => applyAiNow($('setProvider').value);
$('projectSelect').onchange = async () => { if (state.busy) return; state.projectId = $('projectSelect').value || null; if (state.projectId) await openProject(state.projectId); else { rememberProject(null); renderWelcome(); } };
$('jumpDown').onclick = () => { $('chat').scrollTop = $('chat').scrollHeight; $('jumpDown').hidden = true; };
$('chat').addEventListener('scroll', maybeJump);
setBusy(false, 'Ready');
$('chat').addEventListener('click', (e) => { const b = e.target.closest('[data-container]'); if (b) inspectNamedContainer(b.dataset.container); });

function openSupport() {
  $('supportModal').hidden = false;
  add('ai', 'Thank you for supporting App Builder — Pi SoloHost. Choose Pi Wallet or MB Bank, copy the details, and send what you can.');
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
bindSupport();

Promise.all([loadStatus(), loadProjects(), loadSettings()]).then(async () => {
  const id = savedProjectId();
  if (id && state.projects.some((p) => p.id === id)) await openProject(id, false);
  else if (state.projects[0]?.id) await openProject(state.projects[0].id, false);
  else renderWelcome();
}).catch(() => renderWelcome());
