import { writeSafeFile, ensureDir } from '../utils/fsx.js';
import path from 'node:path';

export async function writeSoloHostPackage({ project, sourceDir, image, hostPort = 18080, containerPort = null, description = '' }) {
  const resolvedContainerPort = Number(containerPort) || await inferServingPort(sourceDir);
  const out = path.join(sourceDir, 'solohost');
  await ensureDir(out);
  const yamlSafe = (value) => JSON.stringify(String(value || '').replace(/\r?\n/g, ' ').slice(0, 220));
  const compose = `services:\n  app:\n    image: ${image}\n    restart: unless-stopped\n    labels:\n      pi.ui.primary: "true"\n    ports:\n      - "127.0.0.1:${hostPort}:${resolvedContainerPort}"\n`;
  const config = `title: ${yamlSafe(project.name)}\neyebrow: SoloHost App\ndescription: ${yamlSafe(project.idea)}\nfooter_hint: Ready to run on Pi Desktop SoloHost.\noutput_file: .env\nafter_save: Saved. Start the app from SoloHost.\nfields: []\n`;
  const blurb = normalizeDescription(description) || professionalBlurb(project);
  const appInfo = `# ${project.name}\n\nSuggested app name: ${project.name}\nSuggested description: ${blurb}\n\nDocker image:\n${image}\n\nDo not install until this image address exists on GHCR.\n`;
  const logoPrompt = `Create a wide horizontal logo banner for "${project.name}".\nAspect ratio 16:5 or 3:1 rectangle, not square.\nLeft: a simple recognizable icon. Right: short English name.\nTransparent background, crisp edges, readable at 160x50px, no fake screenshot, no extra UI chrome.\n`;
  const install = `# Install on SoloHost\n\n1. Open SoloHost in Pi Desktop.\n2. Create/add an app using the two files in this folder:\n   - docker-compose.yml\n   - config_options.yml\n3. Save the configuration and start the app.\n4. If SoloHost reports an image or configuration error, return to App Builder and paste the error.\n\nThe Builder keeps the previous project context so it can continue troubleshooting without asking you to repeat the whole process.\n`;
  const readme = `# ${project.name} — SoloHost install kit\n\nUse the two install files:\n- docker-compose.yml\n- config_options.yml\n\nSuggested name: ${project.name}\nSuggested description: ${String(project.idea || 'SoloHost app').replace(/\r?\n/g, ' ').slice(0, 300)}\n\nImage:\n${image}\n\nIf something fails, paste the SoloHost error back into App Builder. It will use the saved project context to diagnose and repair the release.\n`;
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
    image,
    hostPort,
    containerPort: resolvedContainerPort,
    description: blurb,
  };
}


async function inferServingPort(sourceDir) {
  // SoloHost's CONTAINER side must be the port the image actually serves.
  // EXPOSE is only a hint and can be stale; prefer the app's effective PORT.
  const files = [
    'Dockerfile', 'server.js', 'src/server.js', 'app.js', 'src/app.js',
    'index.js', 'src/index.js', 'main.js', 'src/main.js',
  ];

  let dockerfile = '';
  try { dockerfile = await (await import('node:fs/promises')).readFile(path.join(sourceDir, 'Dockerfile'), 'utf8'); } catch {}
  const envPort = dockerfile.match(/^\s*ENV\s+PORT\s*=\s*['"]?(\d{2,5})['"]?\s*$/im)?.[1];
  if (validPort(envPort)) return Number(envPort);

  for (const rel of files.slice(1)) {
    let text = '';
    try { text = await (await import('node:fs/promises')).readFile(path.join(sourceDir, rel), 'utf8'); } catch { continue; }
    const matches = [
      text.match(/\b(?:PORT|port)\s*=\s*(?:process\.env\.PORT\s*\|\|\s*)?['"]?(\d{2,5})['"]?/),
      text.match(/\blisten\s*\(\s*['"]?(\d{2,5})['"]?\s*[,)]/),
      text.match(/\b(?:port|PORT)\s*[:=]\s*['"](\d{2,5})['"]/),
      text.match(/(?:--port|-p)\s+(\d{2,5})\b/),
    ];
    const found = matches.map((m) => m?.[1]).find(validPort);
    if (found) return Number(found);
  }

  const exposed = dockerfile.match(/^\s*EXPOSE\s+(\d{2,5})/im)?.[1];
  return validPort(exposed) ? Number(exposed) : 8080;
}

function validPort(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 65536;
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
