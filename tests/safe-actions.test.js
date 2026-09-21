import test from 'node:test';
import assert from 'node:assert/strict';

test('AI gateway appends the short Safe Edit Rule to every request', async () => {
  const { SAFE_CHANGE_RULES } = await import('../src/ai/gateway.js');
  assert.match(SAFE_CHANGE_RULES.DEBUGGING, /Inspect evidence/);
  assert.match(SAFE_CHANGE_RULES.DEBUGGING, /only what is required|smallest/);
  assert.match(SAFE_CHANGE_RULES.DEBUGGING, /roll back/i);
  assert.ok(SAFE_CHANGE_RULES.DEBUGGING.length < 900);
});

test('gateway sends the rule to provider requests', async () => {
  const { AIGateway, SAFE_CHANGE_RULES } = await import('../src/ai/gateway.js');
  const db = { setting(){ return ''; }, setSetting(){}, run(){} };
  const cfg = { ai:{ provider:'deepseek', mode:'single', deepseekKey:'x', geminiKey:'', deepseekModel:'deepseek-chat', geminiModel:'gemini-2.5-flash' } };
  const ai = new AIGateway({cfg, db, log:{warn(){}}});
  let seen = null;
  ai.deepseek.complete = async (o) => { seen=o; return {provider:'deepseek',model:'deepseek-chat',text:'ok',durationMs:1,tokens:1}; };
  await ai.complete({task:'DEBUGGING', prompt:'repair bug', system:'system'});
  assert.match(seen.prompt, /\[ACTION: SAFE REPAIR — MANDATORY\]/);
  assert.match(seen.system, /\[ACTION: SAFE REPAIR — MANDATORY\]/);
  assert.equal(seen.prompt.includes(SAFE_CHANGE_RULES.DEBUGGING), true);
});

test('system prompt does not contain the old long safety contract', async () => {
  const { SYSTEM } = await import('../src/ai/prompts.js');
  assert.doesNotMatch(SYSTEM, /AI HARD SAFETY CONTRACT:/);
  assert.doesNotMatch(SYSTEM, /\[SAFE EDIT RULE\]/);
});

test('chat is not forced into a code-change safety mode', async () => {
  const { AIGateway } = await import('../src/ai/gateway.js');
  const db = { setting(){ return ''; }, setSetting(){}, run(){} };
  const cfg = { ai:{ provider:'deepseek', mode:'single', deepseekKey:'x', geminiKey:'', deepseekModel:'deepseek-chat', geminiModel:'gemini-2.5-flash' } };
  const ai = new AIGateway({cfg, db, log:{warn(){}}});
  let seen = null;
  ai.deepseek.complete = async (o) => { seen=o; return {provider:'deepseek',model:'deepseek-chat',text:'ok',durationMs:1,tokens:1}; };
  await ai.complete({task:'USER_CHAT', prompt:'hello', system:'system'});
  assert.doesNotMatch(seen.prompt, /SAFE REPAIR|SAFE BUILD|SAFE SECURITY CHANGE|INSPECT ONLY/);
});

test('natural edit/change requests route to the existing improve action', async () => {
  const { inferAction } = await import('../src/scripts/ops.js');
  assert.equal(inferAction('change the button label'), 'improve');
  assert.equal(inferAction('edit the login screen'), 'improve');
});

test('UI reuses compact Safe Actions for upgrade and edit', async () => {
  const fs = await import('node:fs/promises');
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const js = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /data-action="improve"/);
  assert.match(html, /data-action="edit"/);
  assert.match(js, /SAFE UPGRADE/);
  assert.match(js, /SAFE EDIT/);
  assert.match(js, /SAFE REPAIR/);
  assert.match(js, /What do you want to change\?/);
});

test('analyze path is inspect-only', async () => {
  const src = await import('node:fs/promises');
  const text = await src.readFile(new URL('../src/jobs/pipeline.js', import.meta.url), 'utf8');
  assert.match(text, /async function inspectOnly\(project, emit\)/);
  assert.match(text, /payload\.tested = await inspectOnly\(project, emit\)/);
  assert.match(text, /patchCheckpoint/);
});


test('canonical attachment storage keeps uploads in one project attachments directory', async () => {
  const { saveAttachment } = await import('../src/projects/attachments.js');
  const os = await import('node:os'); const fs = await import('node:fs/promises'); const path = await import('node:path');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-attachments-'));
  const result = await saveAttachment(root, { originalname: 'notes.txt', mimetype: 'text/plain', buffer: Buffer.from('hello') });
  assert.equal(path.dirname(result.path), path.join(root, 'attachments'));
  assert.equal((await fs.readFile(result.path, 'utf8')), 'hello');
  await fs.rm(root, { recursive: true, force: true });
});
