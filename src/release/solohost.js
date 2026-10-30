import { hashPort } from './solohost-port.js';
import { writeSafeFile, ensureDir } from '../utils/fsx.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import { applyPolicyToVars, inventoryFields, suggestPolicy } from './solohost-fields.js';
import { lintPackage } from './solohost-lint.js';

// Prefer SoloHost kit / install folders, then project root (active app files).
const COMPOSE_CANDIDATES = [
  'solohost-kit/docker-compose.yml',
  'solohost-kit/compose.yml',
  'solohost-kit/compose.yaml',
  'solohost/docker-compose.yml',
  'solohost/compose.yml',
  'install/docker-compose.yml',
  'solohost-install/docker-compose.yml',
  'deploy/docker-compose.yml',
  'docker-compose.yml',
  'compose.yml',
  'compose.yaml',
  'docker-compose.yaml',
];

const CONFIG_CANDIDATES = [
  'solohost-kit/config_options.yml',
  'solohost/config_options.yml',
  'install/config_options.yml',
  'solohost-install/config_options.yml',
  'deploy/config_options.yml',
  'config_options.yml',
];

export async function writeSoloHostPackage({
  project, sourceDir, image, hostPort = null, containerPort = null, description = '',
  fieldPolicy = null,
  preferLatestImage = true,
  minimalInstallFields = true,
  ai = null,
}) {
  const resolvedPort = Number(hostPort) > 0 ? Number(hostPort) : hashPort(project?.slug || project?.name || 'app');
  hostPort = resolvedPort;
  const out = path.join(sourceDir, 'solohost');
  let resolvedImage = String(image || '').trim();
  if (preferLatestImage && resolvedImage) resolvedImage = forceLatestImageTag(resolvedImage);
  const contract = await discoverRuntimeContract(sourceDir, resolvedImage, containerPort);
  const detectedPort = contract.containerPort || 8080;
  await ensureDir(out);

  // Minimal install form by default: only secrets the user must set at install time.
  const policy = fieldPolicy && fieldPolicy.mode
    ? fieldPolicy
    : (minimalInstallFields
      ? { mode: 'custom', fields: {}, fixedValues: {}, minimal: true }
      : { mode: 'full', fields: {}, fixedValues: {} });
  let applied = applyPolicyToVars(contract.envVars, policy);
  if (minimalInstallFields && policy.minimal) {
    applied = minimalInstallSelection(contract.envVars, applied);
  }
  const envForCompose = [...new Set([...applied.keep, ...applied.fixed])];

  let compose = buildSoloHostCompose({
    sourceCompose: contract.composeText,
    image: forceLatestImageTag(contract.image || resolvedImage),
    hostPort,
    containerPort: detectedPort,
    envVars: envForCompose,
  });
  compose = sanitizeComposeForSoloHost(compose, {
    image: forceLatestImageTag(contract.image || resolvedImage),
    hostPort,
    containerPort: detectedPort,
  });

  // Ensure named volume when omitting anything
  if (applied.omit.length && !/^volumes\s*:/m.test(compose)) {
    compose = compose.trimEnd() + '\n\nvolumes:\n  app_data:\n';
  }

  const existingConfig = await readFirst(sourceDir, CONFIG_CANDIDATES);
  // Prefer password names from kit / minimal selection; declare ALL compose ${VAR}s so lint never hits E-UNDECLARED-VAR.
  const preferPasswords = minimalInstallFields
    ? (applied.keep || [])
    : (applied.keep || []).filter((n) => isSecretVarName(n));
  // Cap install form at 2 password fields; drop extra secret interpolations from SoloHost compose only.
  const secretCandidates = [
    ...preferPasswords,
    ...collectComposeVarNames(compose).filter((n) => isSecretVarName(n)),
  ];
  const allowedSecrets = [...new Set(secretCandidates)].slice(0, 2);
  compose = stripUndeclaredSecretsFromCompose(compose, allowedSecrets);
  let config = buildDeclaredConfigOptions({
    project,
    description,
    composeText: compose,
    hostPort,
    containerPort: detectedPort,
    preferPasswordFields: allowedSecrets,
    maxFormFields: 2,
  });
  // Optional AI polish when more than 2 form fields would appear (safe: lint must still pass).
  if (ai && typeof ai.completeJson === 'function' && countVisibleInstallFields(config) > 2) {
    try {
      const r = await ai.completeJson({
        task: 'SOLOHOST_OPTIMIZE',
        system: 'You optimize SoloHost install packages. Return JSON only: { "compose": "...", "config": "..." }. At most 2 password fields in config_options.yml. Other vars use fixed_values with non-empty string values. No security_opt, no host network, ports must be 127.0.0.1:HOST:CONTAINER, one pi.ui.primary true service.',
        prompt: `Optimize these SoloHost files. Max 2 user fields.\n\n# docker-compose.yml\n${compose}\n\n# config_options.yml\n${config}`,
        temperature: 0.1,
      });
      const c = String(r?.json?.compose || r?.json?.docker_compose || '').trim();
      const k = String(r?.json?.config || r?.json?.config_options || '').trim();
      if (c && k) {
        const tryLint = lintPackage({ composeText: c, configText: k, policy });
        if (!tryLint.errors.length) {
          compose = c;
          config = k;
        }
      }
    } catch { /* keep deterministic package */ }
  }

  // If compose has no interpolations, keep a tiny valid form (optional kit passwords only).
  if (!collectComposeVarNames(compose).length && existingConfig?.text) {
    config = buildMinimalConfigOptions({
      project,
      description,
      keepVars: preferPasswords,
      existing: existingConfig.text,
    });
  }

  const blurb = normalizeDescription(description) || professionalBlurb(project);
  const appInfo = `# ${project.name}\n\nSuggested app name: ${project.name}\nSuggested description: ${blurb}\n\nDocker image:\n${contract.image}\n\nDo not install until this image address exists on GHCR.\n`;
  const logoPrompt = `Create a wide horizontal logo banner for "${project.name}".\nAspect ratio 16:5 or 3:1 rectangle, not square.\nLeft: a simple recognizable icon. Right: short English name.\nTransparent background, crisp edges, readable at 160x50px, no fake screenshot, no extra UI chrome.\n`;
  const install = `# Install on SoloHost\n\n1. Open SoloHost in Pi Desktop.\n2. Create/add an app using the two files in this folder:\n   - docker-compose.yml\n   - config_options.yml\n3. Save the configuration and start the app.\n4. If SoloHost reports an image or configuration error, return to App Builder and paste the error.\n\nThe Builder keeps the previous project context so it can continue troubleshooting without asking you to repeat the whole process.\n`;
  const readme = `# ${project.name} — SoloHost install kit\n\nUse the two install files:\n- docker-compose.yml\n- config_options.yml\n\nSuggested name: ${project.name}\nSuggested description: ${String(project.idea || 'SoloHost app').replace(/\r?\n/g, ' ').slice(0, 300)}\n\nImage:\n${contract.image}\n\nThe package was synchronized from the current application/runtime contract before publication.\nIf something fails, paste the SoloHost error back into App Builder. It will diagnose the correct layer instead of blindly rewriting the app.\n`;

  await writeSafeFile(out, 'docker-compose.yml', compose);
  await writeSafeFile(out, 'config_options.yml', config);
  await writeSafeFile(out, 'APP_INFO.md', appInfo);
  await writeSafeFile(out, 'LOGO_PROMPT.txt', logoPrompt);
  await writeSafeFile(out, 'INSTALL.md', install);
  await writeSafeFile(out, 'README.md', readme);
  await writeSafeFile(sourceDir, 'docker-compose.yml', compose);
  await writeSafeFile(sourceDir, 'config_options.yml', config);

  let lint = lintPackage({ composeText: compose, configText: config, policy });
  let fallbackUsed = false;
  // Always heal undeclared ${VAR} — common when compose is rich and the form is minimal.
  if (lint.errors.some((item) => item.rule === 'E-UNDECLARED-VAR' || item.rule === 'E-SET-ONLY-VAR-USED')) {
    config = buildDeclaredConfigOptions({
      project,
      description,
      composeText: compose,
      hostPort,
      containerPort: detectedPort,
      preferPasswordFields: (applied.keep || []).filter((n) => isSecretVarName(n)),
    });
    await writeSafeFile(out, 'config_options.yml', config);
    await writeSafeFile(sourceDir, 'config_options.yml', config);
    lint = lintPackage({ composeText: compose, configText: config, policy });
  }
  // Recovery: invalid YAML or remaining structural lint → canonical compose + full declare
  if (lint.errors.length) {
    fallbackUsed = true;
    const img = forceLatestImageTag(String(contract.image || image || '').trim());
    compose = sanitizeComposeForSoloHost(
      canonicalCompose({ image: img, hostPort, containerPort: detectedPort, envVars: [] }),
      { image: img, hostPort, containerPort: detectedPort },
    );
    config = buildDeclaredConfigOptions({
      project,
      description,
      composeText: compose,
      hostPort,
      containerPort: detectedPort,
    });
    await writeSafeFile(out, 'docker-compose.yml', compose);
    await writeSafeFile(out, 'config_options.yml', config);
    await writeSafeFile(sourceDir, 'docker-compose.yml', compose);
    await writeSafeFile(sourceDir, 'config_options.yml', config);
    lint = lintPackage({ composeText: compose, configText: config, policy });
  }
  // After GHCR image is confirmed, package step must still finish: drop only non-blocking noise.
  // If anything critical remains, last resort — compose with no interpolations + empty fields.
  if (lint.errors.length) {
    fallbackUsed = true;
    const img = forceLatestImageTag(String(contract.image || image || 'ghcr.io/owner/app:latest').trim());
    compose = canonicalCompose({ image: img, hostPort, containerPort: detectedPort, envVars: [] });
    config = buildDeclaredConfigOptions({ project, description, composeText: compose, hostPort, containerPort: detectedPort });
    await writeSafeFile(out, 'docker-compose.yml', compose);
    await writeSafeFile(out, 'config_options.yml', config);
    await writeSafeFile(sourceDir, 'docker-compose.yml', compose);
    await writeSafeFile(sourceDir, 'config_options.yml', config);
    lint = lintPackage({ composeText: compose, configText: config, policy });
  }
  const ok = !lint.errors.length;
  return {
    ok,
    directory: out,
    files: ['docker-compose.yml', 'config_options.yml', 'APP_INFO.md', 'LOGO_PROMPT.txt', 'INSTALL.md', 'README.md'],
    image: contract.image,
    hostPort,
    containerPort: detectedPort,
    description: blurb,
    fieldPolicy: policy,
    lint,
    fallbackUsed,
    synchronization: {
      sourceCompose: contract.sourceCompose,
      envVars: envForCompose,
      omittedVars: applied.omit,
      configFields: extractConfigFieldNames(config),
      unusedExistingFields: extractConfigFieldNames(existingConfig?.text || '').filter((name) => !envForCompose.includes(name)),
      synchronized: true,
    },
  };
}


/** Force ghcr.io/owner/name:tag → :latest (default SoloHost install image). */
export function forceLatestImageTag(image) {
  const s = String(image || '').trim();
  if (!s) return s;
  if (!s.includes('/')) return s.endsWith(':latest') ? s : `${s}:latest`;
  // path with optional digest ignored; replace trailing tag
  if (s.includes('@')) return s.split('@')[0].replace(/:[^:/]+$/, '') + ':latest';
  if (/:[A-Za-z0-9._-][A-Za-z0-9._-]*$/.test(s)) return s.replace(/:[^:/]+$/, ':latest');
  return `${s}:latest`;
}

/**
 * Strip SoloHost-forbidden keys (security_opt, cap_add, devices, privileged, host nets).
 * Keep a valid primary service with loopback publish + image.
 */
export function sanitizeComposeForSoloHost(composeText, { image, hostPort, containerPort } = {}) {
  let text = String(composeText || '');
  if (!text.trim()) {
    return canonicalCompose({ image, hostPort, containerPort, envVars: [] });
  }
  // Drop forbidden service options (whole keys / short blocks)
  const banLine = /^\s{2,}(security_opt|cap_add|cap_drop|privileged|devices|sysctls|ulimits)\s*:/;
  const lines = text.split(/\r?\n/);
  const out = [];
  let skipIndent = null;
  for (const line of lines) {
    if (skipIndent != null) {
      const m = line.match(/^(\s*)/);
      const ind = m ? m[1].length : 0;
      if (line.trim() && ind > skipIndent) continue;
      skipIndent = null;
    }
    if (banLine.test(line)) {
      const m = line.match(/^(\s*)/);
      skipIndent = m ? m[1].length : 4;
      continue;
    }
    if (/^\s{2,}network_mode\s*:\s*["']?host["']?/.test(line)) continue;
    if (/^\s{2,}pid\s*:\s*["']?host["']?/.test(line)) continue;
    if (/^\s{2,}ipc\s*:\s*["']?host["']?/.test(line)) continue;
    if (/^\s{2,}userns_mode\s*:\s*["']?host["']?/.test(line)) continue;
    out.push(line);
  }
  text = out.join('\n');
  // Force image on primary service if provided
  if (image && /^\s{4}image\s*:/m.test(text)) {
    text = text.replace(/^\s{4}image\s*:.*$/m, `    image: ${yamlImage(image)}`);
  }
  // Re-lint forbidden residual: if still present, fall back to canonical
  if (/\bsecurity_opt\s*:/i.test(text) || /\bcap_add\s*:/i.test(text) || /\bdevices\s*:/i.test(text)) {
    return canonicalCompose({ image, hostPort, containerPort, envVars: [] });
  }
  return text.endsWith('\n') ? text : `${text}\n`;
}

/** Only keep install-time secrets (and optional host port) for SoloHost form. */
export function minimalInstallSelection(envVars = [], applied = { keep: [], fixed: [], omit: [] }) {
  const all = [...new Set([...(envVars || []), ...(applied.keep || [])])];
  const keep = [];
  for (const name of all) {
    const u = String(name).toUpperCase();
    // Admin / access password only when clearly required at install
    if (/(ADMIN|ACCESS|BUILDER|HUB|APP).*PASSWORD|(PASSWORD|SECRET).*(ADMIN|ACCESS|ROOT)/i.test(u)
      || u === 'ADMIN_PASSWORD' || u === 'BUILDER_ACCESS_PASSWORD' || u === 'AI_HUB_ADMIN_PASSWORD') {
      keep.push(name);
    }
  }
  // Prefer a single password field
  const uniq = [...new Set(keep)].slice(0, 2);
  const omit = all.filter((n) => !uniq.includes(n));
  return { keep: uniq, fixed: [], omit };
}

export function buildMinimalConfigOptions({ project, description = '', keepVars = [], existing = '' } = {}) {
  const title = yamlSafe(project?.name || 'SoloHost App');
  const desc = yamlSafe(description || project?.idea || 'SoloHost application');
  const lines = [
    `title: ${title}`,
    'eyebrow: SoloHost App',
    `description: ${desc}`,
    'footer_hint: "Only enter required secrets. Other settings use app defaults."',
    'output_file: .env',
    'after_save: "Settings saved. Start the app from SoloHost."',
  ];
  // Try to recover password field names from existing kit config
  const names = new Set(keepVars || []);
  for (const m of String(existing).matchAll(/name:\s*([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const n = m[1];
    if (/PASSWORD|SECRET/i.test(n) && /ADMIN|ACCESS|HUB|BUILDER|ROOT/i.test(n)) names.add(n);
  }
  const fields = [...names].filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n));
  if (!fields.length) {
    lines.push('fields: []');
  } else {
    lines.push('fields:');
    for (const name of fields.slice(0, 3)) {
      lines.push(`  - name: ${name}`);
      lines.push(`    label: ${humanize(name)}`);
      lines.push('    type: password');
      lines.push('    preserve_if_blank: true');
      lines.push('    help: "Required only if this app uses an admin login. Leave blank to use the app default."');
    }
  }
  return `${lines.join('\n')}\n`;
}



/** ${VAR} names referenced in compose (with optional :-defaults ignored for the name). */
export function collectComposeVarNames(composeText = '') {
  const names = new Set();
  for (const m of String(composeText).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g)) {
    names.add(m[1]);
  }
  return [...names].sort();
}

function isSecretVarName(name) {
  return /PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE|CREDENTIAL|MASTER_KEY/i.test(String(name || ''));
}

function defaultFixedValue(name, { hostPort, containerPort } = {}) {
  const u = String(name || '').toUpperCase();
  if (u === 'HOST_PORT' || u === 'SOLOHOST_HOST_PORT') return String(hostPort || 30000);
  if (u === 'PORT') return String(containerPort || 8080);
  if (/(_MS|TIMEOUT|INTERVAL|TTL)$/.test(u)) return '30000';
  if (/(LIMIT|CONCURRENT|PARALLEL|PER_MIN|TOKENS|CTX|PREDICT|MAX_)/.test(u)) return '10';
  if (/^(ENABLE|DISABLE)|TRUST|ALLOW|DEBUG|MODE$|_MODE$/.test(u)) return 'false';
  if (/URL|ORIGIN|HOST$|SERVICE$/.test(u)) return 'http://127.0.0.1';
  if (/VERSION/.test(u)) return '1.0.0';
  if (/NAME|ID|APP_/.test(u)) return 'app';
  if (/PROVIDER|MODEL/.test(u)) return 'auto';
  return 'default';
}

/**
 * SoloHost requires every ${VAR} in compose to appear in fields or fixed_values.
 * Secrets → password fields (user may leave blank via preserve_if_blank).
 * Everything else → fixed_values with a non-empty default (not shown as form clutter).
 */
export function buildDeclaredConfigOptions({
  project,
  description = '',
  composeText = '',
  hostPort = 30000,
  containerPort = 8080,
  preferPasswordFields = null,
  maxFormFields = 2,
} = {}) {
  const title = yamlSafe(project?.name || 'SoloHost App');
  const desc = yamlSafe(description || project?.idea || 'SoloHost application');
  const vars = collectComposeVarNames(composeText);
  const passwordPreferred = new Set(preferPasswordFields || []);
  const secretNames = [];
  const fixed = [];
  for (const name of vars) {
    if (isSecretVarName(name) || passwordPreferred.has(name)) secretNames.push(name);
    else fixed.push({ name, value: defaultFixedValue(name, { hostPort, containerPort }) });
  }
  // Install form: at most maxFormFields password prompts (default 2). Extra secrets stay out of the form.
  const fieldNames = secretNames.slice(0, Math.max(0, Number(maxFormFields) || 2));
  const lines = [
    `title: ${title}`,
    'eyebrow: SoloHost App',
    `description: ${desc}`,
    'footer_hint: "Only enter required secrets (at most 2). Other settings use safe defaults."',
    'output_file: .env',
    'after_save: "Settings saved. Start the app from SoloHost."',
  ];
  if (!fieldNames.length) lines.push('fields: []');
  else {
    lines.push('fields:');
    for (const name of fieldNames) {
      lines.push(`  - name: ${name}`);
      lines.push(`    label: ${humanize(name)}`);
      lines.push('    type: password');
      lines.push('    preserve_if_blank: true');
      lines.push('    help: "Required only if this app uses an admin login. Leave blank to use the app default."');
    }
  }
  if (fixed.length) {
    lines.push('fixed_values:');
    for (const item of fixed) {
      lines.push(`  - name: ${item.name}`);
      lines.push(`    value: ${JSON.stringify(String(item.value))}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Remove env interpolations for secrets not kept as form fields (SoloHost kit only). */
export function stripUndeclaredSecretsFromCompose(composeText, allowedSecretNames = []) {
  const allow = new Set(allowedSecretNames || []);
  let text = String(composeText || '');
  const vars = collectComposeVarNames(text);
  for (const name of vars) {
    if (!isSecretVarName(name)) continue;
    if (allow.has(name)) continue;
    // Replace ${SECRET} and ${SECRET:-x} with empty quoted value in env assignments is hard;
    // drop whole environment lines that only reference this secret.
    const reLine = new RegExp(String.raw`^\s*[A-Za-z_][A-Za-z0-9_]*:\s*\$\{` + name + String.raw`(?::-[^}]*)?\}\s*$`, 'gm');
    text = text.replace(reLine, '');
    // Also bare list form - NAME=${SECRET}
    const reList = new RegExp(String.raw`^\s*-\s*[A-Za-z_][A-Za-z0-9_]*=\$\{` + name + String.raw`(?::-[^}]*)?\}\s*$`, 'gm');
    text = text.replace(reList, '');
  }
  return text;
}

export function countVisibleInstallFields(configText = '') {
  const fields = [...String(configText).matchAll(/^\s{2}-\s+name:\s*([A-Za-z_][A-Za-z0-9_]*)/gm)].map((m) => m[1]);
  // hidden fields still count as "name" lines under fields - approximate: password/text/number/select
  const types = [...String(configText).matchAll(/^\s{4}type:\s*(\w+)/gm)].map((m) => m[1]);
  const visible = types.filter((t) => t !== 'hidden');
  return Math.max(fields.length, visible.length) && types.length ? visible.length : fields.length;
}


export async function discoverRuntimeContract(sourceDir, image, containerPort = null) {
  const composeFile = await readFirst(sourceDir, COMPOSE_CANDIDATES);
  const composeText = composeFile?.text || '';
  const envVars = new Set();

  for (const match of composeText.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g)) envVars.add(match[1]);
  for (const match of composeText.matchAll(/(?:^|\s)-\s*([A-Za-z_][A-Za-z0-9_]*)=\$\{?/gm)) envVars.add(match[1]);

  const files = await listSourceFiles(sourceDir);
  for (const rel of files) {
    if (!/\.(js|mjs|cjs|ts|tsx|py|rb|go|php|json|yml|yaml|env\.example|sh)$/i.test(rel)) continue;
    const text = await fs.readFile(path.join(sourceDir, rel), 'utf8').catch(() => '');
    for (const match of text.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) envVars.add(match[1]);
    for (const match of text.matchAll(/process\.env\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g)) envVars.add(match[1]);
    for (const match of text.matchAll(/\bos\.environ(?:\.get)?\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g)) envVars.add(match[1]);
  }

  const envExample = await readFirst(sourceDir, ['.env.example', '.env.template']);
  if (envExample?.text) {
    for (const line of envExample.text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (m) envVars.add(m[1]);
    }
  }

  const detectedPort = containerPort || await detectContainerPort(sourceDir);
  const rawImage = String(image || '').trim();
  const safeImage = rawImage.startsWith('ghcr.io/')
    ? rawImage
    : `ghcr.io/OWNER/${String(sourceDir).split(path.sep).pop() || 'app'}:latest`;

  // Only user-facing / compose-declared vars — not process noise (HOME, npm_*, etc.)
  const NOISE = new Set([
    'HOME', 'HOSTNAME', 'HOST', 'PATH', 'PWD', 'USER', 'SHELL', 'LANG', 'TERM', 'SHLVL',
    'NODE_ENV', 'NODE_OPTIONS', 'npm_package_version', 'npm_package_name', 'npm_config_user_agent',
    'OLDPWD', 'TMPDIR', 'TMP', 'TEMP', '_',
  ]);
  const fromCompose = new Set();
  for (const match of composeText.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g)) fromCompose.add(match[1]);
  for (const match of composeText.matchAll(/(?:^|\s)-\s*([A-Za-z_][A-Za-z0-9_]*)=\$\{?/gm)) fromCompose.add(match[1]);

  const filtered = [...envVars].filter((name) => {
    if (!name || NOISE.has(name)) return false;
    if (/^(npm_|NODE_|_)/.test(name)) return false;
    // Prefer compose / .env.example declarations; allow clear app settings from source
    if (fromCompose.has(name)) return true;
    if (/^(AI_|OLLAMA_|SHFH_|PUBLIC_|SOLOHOST_|DATA_DIR|SERVICE_NAME|HOST_PORT|PORT$)/i.test(name)) return true;
    if (/_(KEY|TOKEN|PASSWORD|SECRET|URL|MODEL|PROVIDER|MODE)$/i.test(name)) return true;
    return false;
  }).sort();

  return {
    sourceCompose: composeFile?.path || null,
    composeText,
    envVars: filtered.filter((x) => x !== 'PORT' || /\$\{PORT\}/.test(composeText)),
    containerPort: detectedPort || 8080,
    image: safeImage,
  };
}

async function listSourceFiles(sourceDir) {
  const out = [];
  async function walk(dir, prefix = '') {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'vendor', 'artifacts', 'snapshots'].includes(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, rel);
      else out.push(rel);
    }
  }
  await walk(sourceDir);
  return out;
}

async function readFirst(sourceDir, candidates) {
  for (const rel of candidates) {
    const text = await fs.readFile(path.join(sourceDir, rel), 'utf8').catch(() => '');
    if (text.trim()) return { path: rel, text };
  }
  return null;
}

function buildSoloHostCompose({ sourceCompose = '', image, hostPort, containerPort, envVars = [] }) {
  const lines = String(sourceCompose || '').split(/\r?\n/);
  const hasServices = /^\s*services\s*:/m.test(sourceCompose);
  if (!hasServices) return canonicalCompose({ image, hostPort, containerPort, envVars });

  // Preserve the upgraded service graph when it is readable, while making the
  // primary UI service SoloHost-compatible. This is deployment synchronization,
  // not application repair.
  const serviceStarts = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^  [A-Za-z0-9_.-]+:\s*$/.test(lines[i])) serviceStarts.push(i);
  }
  if (!serviceStarts.length) return canonicalCompose({ image, hostPort, containerPort, envVars });

  let primary = serviceStarts[0];
  for (const start of serviceStarts) {
    const end = serviceStarts[serviceStarts.indexOf(start) + 1] ?? lines.length;
    const block = lines.slice(start, end).join('\n');
    if (/pi\.ui\.primary\s*:\s*["']?true["']?/i.test(block)) { primary = start; break; }
  }
  const end = serviceStarts[serviceStarts.indexOf(primary) + 1] ?? lines.length;
  let block = lines.slice(primary, end);

  // Remove build-only declarations from the UI service. Nested build maps are
  // uncommon in generated apps; if present, leave them for the authoritative
  // validator to reject rather than guessing a destructive transformation.
  block = block.filter((line) => !/^\s{4}build:\s*/.test(line));
  const imageIndex = block.findIndex((line) => /^\s{4}image:\s*/.test(line));
  if (imageIndex >= 0) block[imageIndex] = `    image: ${image}`;
  else block.splice(1, 0, `    image: ${image}`);

  // Replace the primary UI ports block with exactly one loopback port.
  const portsIndex = block.findIndex((line) => /^\s{4}ports:\s*$/.test(line));
  if (portsIndex >= 0) {
    let j = portsIndex + 1;
    while (j < block.length && (/^\s{6}-\s*/.test(block[j]) || /^\s{6}[A-Za-z0-9_.-]+:/.test(block[j]))) j += 1;
    block.splice(portsIndex, j - portsIndex, '    ports:', `      - "127.0.0.1:${hostPort}:${containerPort}"`);
  } else {
    const insertAt = Math.min(block.length, 3);
    block.splice(insertAt, 0, '    ports:', `      - "127.0.0.1:${hostPort}:${containerPort}"`);
  }

  if (!block.some((line) => /^\s{6}pi\.ui\.primary:\s*/.test(line))) {
    const labels = block.findIndex((line) => /^\s{4}labels:\s*$/.test(line));
    if (labels >= 0) block.splice(labels + 1, 0, '      pi.ui.primary: "true"');
    else {
      const img = block.findIndex((line) => /^\s{4}image:\s*/.test(line));
      block.splice(img + 1, 0, '    labels:', '      pi.ui.primary: "true"');
    }
  }

  // Preserve the current environment declarations and ensure every referenced
  // variable remains explicitly represented.
  let envIndex = block.findIndex((line) => /^\s{4}environment:\s*$/.test(line));
  if (envIndex < 0) {
    const portLine = block.findIndex((line) => /^\s{4}ports:\s*$/.test(line));
    block.splice(portLine >= 0 ? portLine + 2 : block.length, 0, '    environment:');
    envIndex = block.findIndex((line) => /^\s{4}environment:\s*$/.test(line));
  }
  const existingEnv = new Set(block.slice(envIndex + 1).map((line) => {
    const m = line.match(/^\s{6}(?:-\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*:/) || line.match(/^\s{6}-\s*([A-Za-z_][A-Za-z0-9_]*)=/);
    return m?.[1];
  }).filter(Boolean));
  let envEnd = envIndex + 1;
  while (envEnd < block.length && /^\s{6}/.test(block[envEnd])) envEnd += 1;
  const additions = envVars.filter((v) => !existingEnv.has(v)).map((v) => `      ${v}: \${${v}}`);
  if (additions.length) block.splice(envEnd, 0, ...additions);

  lines.splice(primary, end - primary, ...block);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

// 1.8.9: a plain docker reference is written unquoted (like the rest of the SoloHost package code paths), so
// regenerating an unchanged package is byte-for-byte idempotent. Anything unusual is still JSON-quoted.
function yamlImage(image) {
  const v = String(image || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._/@:-]*$/.test(v) ? v : JSON.stringify(v);
}

function canonicalCompose({ image, hostPort, containerPort, envVars }) {
  const env = envVars.length
    ? envVars.map((v) => `      ${v}: \${${v}}`).join('\n')
    : `      PORT: ${containerPort}`;
  return `services:
  app:
    image: ${yamlImage(image)}
    restart: unless-stopped
    labels:
      pi.ui.primary: "true"
    ports:
      - "127.0.0.1:${hostPort}:${containerPort}"
    environment:
${env}
`;
}

function reconcileConfigOptions({ existing = '', project, usedVars = [] }) {
  const text = String(existing || '').trim();
  const title = yamlSafe(project?.name || 'SoloHost App');
  const description = yamlSafe(project?.idea || 'SoloHost application');
  const used = new Set(usedVars);

  let base = text;
  if (!base || !/\bfields\s*:/.test(base)) {
    base = `title: ${title}
eyebrow: SoloHost App
description: ${description}
footer_hint: Ready to run on Pi Desktop SoloHost.
output_file: .env
after_save: Saved. Start the app from SoloHost.
fields:
`;
  }
  base = base.replace(/^\s*fields:\s*\[\]\s*$/m, 'fields:');

  const existingNames = new Set(extractConfigFieldNames(base));
  const additions = [];
  for (const name of [...used].sort()) {
    if (existingNames.has(name)) continue;
    additions.push(fieldYaml(name));
  }
  if (additions.length) {
    // Append under existing fields: — never start a second fields: key
    if (!/\bfields\s*:/.test(base)) {
      base = `${base.trimEnd()}\nfields:\n`;
    }
    base = `${base.trimEnd()}\n${additions.join('\n')}\n`;
  }
  return base.endsWith('\n') ? base : `${base}\n`;
}

function buildFallbackConfig({ project, usedVars = [], fixedValues = {}, fixedVars = [] } = {}) {
  const title = yamlSafe(project?.name || 'SoloHost App');
  const description = yamlSafe(project?.idea || 'SoloHost application');
  const lines = [
    `title: ${title}`,
    'eyebrow: SoloHost App',
    `description: ${description}`,
    'footer_hint: Ready to run on Pi Desktop SoloHost.',
    'output_file: .env',
    'after_save: Saved. Start the app from SoloHost.',
  ];
  const unique = [...new Set(usedVars)].filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)).sort();
  lines.push(unique.length ? 'fields:' : 'fields: []');
  for (const name of unique) {
    if ((fixedVars || []).includes(name)) continue;
    lines.push(...fieldYaml(name).split('\n'));
  }
  const values = [];
  for (const name of [...new Set(fixedVars || [])]) {
    const value = fixedValues?.[name];
    if (value == null || /PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE|CREDENTIAL/i.test(name)) continue;
    values.push({ name, value: String(value) });
  }
  if (values.length) {
    lines.push('fixed_values:');
    for (const item of values) lines.push(`  - name: ${item.name}`, `    value: ${JSON.stringify(item.value)}`);
  }
  return `${lines.join('\n')}\n`;
}

function extractConfigFieldNames(text) {
  return [...String(text || '').matchAll(/^\s{2}-\s+name:\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/gm)].map((m) => m[1]);
}

function fieldYaml(name) {
  const upper = name.toUpperCase();
  if (/KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL|PRIVATE/i.test(upper)) {
    return `  - name: ${name}\n    label: ${humanize(name)}\n    type: password\n    preserve_if_blank: true\n    help: "Required to run this app. Keep it private."`;
  }
  if (/^(ENABLE|DISABLE)_/i.test(upper)) {
    return `  - name: ${name}\n    label: ${humanize(name)}\n    type: select\n    default: "false"\n    options:\n      - value: "true"\n        label: "Enabled"\n      - value: "false"\n        label: "Disabled"\n    help: "Optional setting. Leave blank to use the app default."`;
  }
  if (upper.endsWith('_PORT') || upper === 'PORT' || /_TIMEOUT$/.test(upper)) {
    return `  - name: ${name}\n    label: ${humanize(name)}\n    type: number\n    help: "Runtime value. Leave blank to use the app default."`;
  }
  return `  - name: ${name}\n    label: ${humanize(name)}\n    type: text\n    preserve_if_blank: true\n    help: "Optional setting. Leave blank to use the app default."`;
}

function humanize(name) {
  return String(name).toLowerCase().split('_').map((x) => x ? x[0].toUpperCase() + x.slice(1) : x).join(' ');
}

function yamlSafe(value) {
  return JSON.stringify(String(value || '').replace(/\r?\n/g, ' ').slice(0, 220));
}

function normalizeDescription(value) {
  const lines = String(value || '').split(/\r?\n/).map((x) => x.replace(/^[-*•]\s*/, '').trim()).filter(Boolean).slice(0, 5);
  return lines.length >= 3 ? lines.join('\n') : '';
}

function professionalBlurb(project) {
  const idea = String(project.idea || project.name || 'SoloHost app').replace(/\r?\n/g, ' ').trim();
  const short = idea.slice(0, 140);
  return `${project.name}: ${short}${idea.length > 140 ? '…' : ''}`;
}

export async function detectContainerPort(sourceDir) {
  const files = [];
  const add = async (name) => { const text = await fs.readFile(path.join(sourceDir, name), 'utf8').catch(() => ''); if (text) files.push({ name, text }); };
  await add('docker-compose.yml');
  await add('compose.yml');
  await add('compose.yaml');
  await add('solohost/docker-compose.yml');
  await add('Dockerfile');
  await add('package.json');
  for (const name of ['server.js', 'src/server.js', 'app.js', 'index.js']) await add(name);
  const blob = files.map((x) => x.text).join('\n');
  const composeText = files.filter((x) => /compose/i.test(x.name)).map((x) => x.text).join('\n');
  const composePort = composeText.match(/(?:127\.0\.0\.1:)?\d{2,5}:(\d{2,5})/);
  if (composePort && Number(composePort[1])) return Number(composePort[1]);
  const exposed = [...blob.matchAll(/EXPOSE\s+(\d{2,5})/gi)].map((m) => Number(m[1])).filter(Boolean);
  if (exposed.length) return exposed[0];
  const envPort = blob.match(/process\.env\.PORT\s*\|\|\s*(\d{2,5})/i)?.[1];
  if (envPort) return Number(envPort);
  const listen = blob.match(/(?:listen|PORT)\s*\(?\s*(\d{2,5})/i)?.[1];
  if (listen && Number(listen) !== 3000) return Number(listen);
  const compose = blob.match(/127\.0\.0\.1:\d{2,5}:(\d{2,5})/);
  if (compose) return Number(compose[1]);
  return null;
}


/** Shared inventory for generator + routes. */
export async function inventoryFromSource(sourceDir) {
  const contract = await discoverRuntimeContract(sourceDir, 'placeholder:image');
  const defaults = {};
  const descriptions = {};
  // Defaults from ${VAR:-x} in source compose text
  for (const m of String(contract.composeText || '').matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*):-([^}]*)\}/g)) {
    defaults[m[1]] = m[2];
  }
  // .env.example
  try {
    const envEx = await fs.readFile(path.join(sourceDir, '.env.example'), 'utf8');
    for (const line of envEx.split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && defaults[m[1]] == null) defaults[m[1]] = m[2].replace(/^["']|["']$/g, '');
      const cm = line.match(/^#\s*([A-Za-z_][A-Za-z0-9_]*)\s*[-:]\s*(.+)$/);
      if (cm) descriptions[cm[1]] = cm[2].trim();
    }
  } catch { /* optional */ }
  return inventoryFields(contract.envVars, { defaults, descriptions });
}


function mergeFixedValues(configText, fixedMap = {}, fixedNames = []) {
  const lines = String(configText || '').split(/\r?\n/);
  const existing = new Set();
  for (const m of String(configText).matchAll(/name:\s*([A-Za-z_][A-Za-z0-9_]*)/g)) existing.add(m[1]);
  const entries = [];
  for (const name of fixedNames) {
    if (existing.has(name)) continue;
    const val = fixedMap[name];
    if (val == null || /PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE/i.test(name)) continue;
    entries.push(`  - name: ${name}\n    value: ${JSON.stringify(String(val))}`);
  }
  for (const [name, val] of Object.entries(fixedMap)) {
    if (existing.has(name) || fixedNames.includes(name)) continue;
    if (val == null || /PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE/i.test(name)) continue;
    entries.push(`  - name: ${name}\n    value: ${JSON.stringify(String(val))}`);
  }
  if (!entries.length) return configText;
  if (/^fixed_values\s*:/m.test(configText)) {
    return configText.trimEnd() + '\n' + entries.join('\n') + '\n';
  }
  return configText.trimEnd() + '\nfixed_values:\n' + entries.join('\n') + '\n';
}

function ensureEnvInCompose(composeText, varName) {
  if (composeText.includes('${' + varName + '}')) return composeText;
  // inject under first environment: block or create one after image
  if (/^\s{4}environment:\s*$/m.test(composeText)) {
    return composeText.replace(/^(\s{4}environment:\s*)$/m, `$1\n      ${varName}: \${${varName}}`);
  }
  return composeText.replace(/^(\s{4}image:\s*.+)$/m, `$1\n    environment:\n      ${varName}: \${${varName}}`);
}

function ensureHiddenProfileField(configText) {
  if (/name:\s*SOLOHOST_PROFILE/.test(configText)) return configText;
  const field = `  - name: SOLOHOST_PROFILE\n    type: hidden\n    default: "defaults"\n    help: "Install profile selected in App Builder."\n`;
  if (/^fields:\s*$/m.test(configText) || /^fields:\s*\[\]/m.test(configText)) {
    return configText.replace(/^fields:\s*(\[\])?$/m, 'fields:\n' + field);
  }
  if (/^fields:\s*$/m.test(configText) === false && /fields:/.test(configText)) {
    return configText.replace(/(fields:\s*\n)/, `$1${field}`);
  }
  return configText.trimEnd() + '\nfields:\n' + field;
}
