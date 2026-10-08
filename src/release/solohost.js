import { writeSafeFile, ensureDir } from '../utils/fsx.js';
import path from 'node:path';
import fs from 'node:fs/promises';

const COMPOSE_CANDIDATES = [
  'docker-compose.yml',
  'compose.yml',
  'compose.yaml',
  'docker-compose.yaml',
  'solohost/docker-compose.yml',
];

const CONFIG_CANDIDATES = [
  'config_options.yml',
  'solohost/config_options.yml',
];

export async function writeSoloHostPackage({
  project, sourceDir, image, hostPort = 18080, containerPort = null, description = '',
}) {
  const out = path.join(sourceDir, 'solohost');
  const contract = await discoverRuntimeContract(sourceDir, image, containerPort);
  const detectedPort = contract.containerPort || 8080;
  await ensureDir(out);

  const compose = buildSoloHostCompose({
    sourceCompose: contract.composeText,
    image: contract.image,
    hostPort,
    containerPort: detectedPort,
    envVars: contract.envVars,
  });

  const existingConfig = await readFirst(sourceDir, CONFIG_CANDIDATES);
  const existingNamesBefore = new Set(extractConfigFieldNames(existingConfig?.text || ''));
  const missingVars = contract.envVars.filter((v) => !existingNamesBefore.has(v) && v !== 'PORT');
  const config = reconcileConfigOptions({
    existing: existingConfig?.text || '',
    project,
    usedVars: contract.envVars,
  });

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

  return {
    directory: out,
    files: ['docker-compose.yml', 'config_options.yml', 'APP_INFO.md', 'LOGO_PROMPT.txt', 'INSTALL.md', 'README.md'],
    image: contract.image,
    hostPort,
    containerPort: detectedPort,
    description: blurb,
    synchronization: {
      sourceCompose: contract.sourceCompose,
      envVars: contract.envVars,
      configFields: extractConfigFieldNames(config),
      unusedExistingFields: extractConfigFieldNames(existingConfig?.text || '').filter((name) => !contract.envVars.includes(name)),
      synchronized: true,
    },
  };
}

async function discoverRuntimeContract(sourceDir, image, containerPort = null) {
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

  return {
    sourceCompose: composeFile?.path || null,
    composeText,
    envVars: [...envVars].filter((x) => x !== 'PORT' || /\$\{PORT\}/.test(composeText)).sort(),
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

function canonicalCompose({ image, hostPort, containerPort, envVars }) {
  const env = envVars.length
    ? envVars.map((v) => `      ${v}: \${${v}}`).join('\n')
    : `      PORT: ${containerPort}`;
  return `services:
  app:
    image: ${image}
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
    if (!/\bfields:\s*$/.test(base)) base += '\nfields:\n';
    base = `${base.trimEnd()}\n${additions.join('\n')}\n`;
  }
  return base.endsWith('\n') ? base : `${base}\n`;
}

function extractConfigFieldNames(text) {
  return [...String(text || '').matchAll(/^\s{2}-\s+name:\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/gm)].map((m) => m[1]);
}

function fieldYaml(name) {
  const upper = name.toUpperCase();
  if (/KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL|PRIVATE/i.test(upper)) {
    return `  - name: ${name}\n    label: ${humanize(name)}\n    type: password\n    preserve_if_blank: true\n    help: "Required by the application."`;
  }
  if (/^(ENABLE|DISABLE)_/i.test(upper)) {
    return `  - name: ${name}\n    label: ${humanize(name)}\n    type: select\n    default: "false"\n    options:\n      - value: "true"\n        label: "Enabled"\n      - value: "false"\n        label: "Disabled"\n    help: "Application setting."`;
  }
  if (upper.endsWith('_PORT') || upper === 'PORT' || /_TIMEOUT$/.test(upper)) {
    return `  - name: ${name}\n    label: ${humanize(name)}\n    type: number\n    help: "Application runtime setting."`;
  }
  return `  - name: ${name}\n    label: ${humanize(name)}\n    type: text\n    preserve_if_blank: true\n    help: "Application setting."`;
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
