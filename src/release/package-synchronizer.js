/**
 * SoloHost Package Synchronizer — deployment artifacts only (not application repair).
 * Uses existing release/solohost.js discovery + write.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeSoloHostPackage } from './solohost.js';

/**
 * Analyze USED_VARS vs config_options fields without writing.
 */
export async function analyzePackageDrift(sourceDir) {
  const composeCandidates = [
    'docker-compose.yml', 'compose.yml', 'compose.yaml', 'docker-compose.yaml', 'solohost/docker-compose.yml',
  ];
  const configCandidates = ['config_options.yml', 'solohost/config_options.yml'];

  let composeText = '';
  for (const rel of composeCandidates) {
    try {
      composeText = await fs.readFile(path.join(sourceDir, rel), 'utf8');
      break;
    } catch {}
  }
  let configText = '';
  for (const rel of configCandidates) {
    try {
      configText = await fs.readFile(path.join(sourceDir, rel), 'utf8');
      break;
    } catch {}
  }

  const used = new Set();
  for (const m of composeText.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g)) used.add(m[1]);
  // also process.env from source (lightweight)
  try {
    const server = await fs.readFile(path.join(sourceDir, 'server.js'), 'utf8');
    for (const m of server.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) used.add(m[1]);
  } catch {}

  const declared = new Set(
    [...String(configText).matchAll(/^\s{2}-\s+name:\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/gm)].map((m) => m[1]),
  );

  const usedArr = [...used].sort();
  const declaredArr = [...declared].sort();
  const missing = usedArr.filter((v) => !declared.has(v) && v !== 'PORT');
  const unused = declaredArr.filter((v) => !used.has(v));
  const neu = usedArr.filter((v) => !declared.has(v));

  return {
    usedVars: usedArr,
    declaredVars: declaredArr,
    missingVars: missing,
    unusedVars: unused,
    newVars: neu,
    needsSync: missing.length > 0,
  };
}

/**
 * Synchronize SoloHost package from current application contract.
 * Does NOT modify application source — only solohost/ deployment artifacts.
 */
export async function synchronizeSoloHostPackage(opts) {
  const before = await analyzePackageDrift(opts.sourceDir).catch(() => null);
  const result = await writeSoloHostPackage(opts);
  const after = await analyzePackageDrift(path.join(opts.sourceDir, 'solohost')).catch(() => null);
  return {
    ...result,
    driftBefore: before,
    driftAfter: after,
    message: 'SoloHost package synchronized with upgraded app.',
  };
}
