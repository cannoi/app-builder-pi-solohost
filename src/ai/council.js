export function trustTable(db) {
  return db.setting('aiTrust', { deepseek: { wins: 1, fails: 0, ms: 8000 }, gemini: { wins: 1, fails: 0, ms: 8000 } });
}

export function scoreOf(row) {
  const wins = Number(row?.wins || 0);
  const fails = Number(row?.fails || 0);
  const ms = Number(row?.ms || 8000);
  const total = Math.max(1, wins + fails);
  const success = wins / total;
  const speed = Math.max(0.2, Math.min(1, 12000 / Math.max(800, ms)));
  return Math.round((success * 70 + speed * 30) * 10) / 10;
}

export function pickRoles(cfg, db) {
  const trust = trustTable(db);
  const ds = cfg.ai.deepseekKey;
  const gm = cfg.ai.geminiKey;
  if (ds && gm) {
    const selected = cfg.ai.provider === 'gemini' ? 'gemini' : 'deepseek';
    const other = selected === 'gemini' ? 'deepseek' : 'gemini';
    const preferOther = scoreOf(trust[other]) > scoreOf(trust[selected]) + 8;
    if (preferOther) return { builder: other, reviewer: selected, trust };
    return { builder: selected, reviewer: other, trust };
  }
  if (ds) return { builder: 'deepseek', reviewer: null, trust };
  if (gm) return { builder: 'gemini', reviewer: null, trust };
  return { builder: null, reviewer: null, trust };
}

export function recordTrust(db, name, { ok, ms }) {
  const trust = trustTable(db);
  const row = trust[name] || { wins: 0, fails: 0, ms: 8000 };
  if (ok) row.wins += 1; else row.fails += 1;
  row.ms = Math.round(((row.ms || 8000) * 0.7) + (Number(ms || 8000) * 0.3));
  trust[name] = row;
  db.setSetting('aiTrust', trust);
  return trust;
}

export function reviewPrompt(task, draft) {
  return `You are the Reviewer in App Builder council mode.
Task: ${task}
Draft JSON from the Builder:
${JSON.stringify(draft).slice(0, 12000)}

Return ONLY JSON:
{"accept":true,"score":0,"issues":["short issue"],"reason":"one sentence"}
Reject only if the draft would break the app, drop required files, or ignore SoloHost rules.`;
}
