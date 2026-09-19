import fs from 'node:fs/promises';
import path from 'node:path';
import { writeSafeFile, listFiles } from '../utils/fsx.js';

const BADGE_CSS = `.paf-made-by{position:fixed;right:8px;bottom:8px;width:min(72px,12vw);max-width:12vw;height:auto;object-fit:contain;opacity:.5;background:transparent;padding:0;border:0;box-shadow:none;filter:none;pointer-events:none;z-index:30}`;

export async function stampMadeBy(sourceDir, cfg = {}) {
  const targets = [];
  for (const rel of await listFiles(sourceDir).catch(() => [])) {
    if (/\.html?$/i.test(rel) && !rel.includes('node_modules/')) targets.push(rel);
  }
  if (!targets.length) targets.push('public/index.html');

  const publicDir = path.join(sourceDir, 'public');
  await fs.mkdir(publicDir, { recursive: true }).catch(() => {});
  const from = [
    path.join(cfg.templatesDir || path.resolve(process.cwd(), 'templates'), 'assets', 'made-by.png'),
    path.join(process.cwd(), 'public', 'made-by.png'),
  ];
  let copied = false;
  for (const src of from) {
    try { await fs.copyFile(src, path.join(publicDir, 'made-by.png')); copied = true; break; } catch {}
  }

  let stamped = 0;
  for (const rel of targets) {
    const htmlPath = path.join(sourceDir, rel);
    let html = await fs.readFile(htmlPath, 'utf8').catch(() => '');
    if (!html) continue;
    html = html.replace(/<div class="paf-made-by"[\s\S]*?<\/div>/gi, '');
    html = html.replace(/<img[^>]*class="paf-made-by"[^>]*>/gi, '');
    html = html.replace(/<style>\.paf-made-by\{[^<]*<\/style>/gi, '');
    const badgeSrc = rel.startsWith('public/') ? '/made-by.png' : 'public/made-by.png';
    const mark = `<img class="paf-made-by" src="${badgeSrc}" alt="Made with App Builder — Pi SoloHost">`;
    if (/<\/body>/i.test(html)) html = html.replace(/<\/body>/i, `${mark}</body>`);
    else html += `\n${mark}`;
    if (/<\/head>/i.test(html)) html = html.replace(/<\/head>/i, `<style>${BADGE_CSS}</style></head>`);
    else html = `<style>${BADGE_CSS}</style>\n${html}`;
    await writeSafeFile(path.dirname(htmlPath), path.basename(htmlPath), html);
    stamped += 1;
  }
  return { stamped, copied, files: targets };
}

export async function verifyBadge(sourceDir) {
  const htmlPath = path.join(sourceDir, 'public', 'index.html');
  try {
    const html = await fs.readFile(htmlPath, 'utf8');
    return html.includes('paf-made-by') && html.includes('made-by.png');
  } catch { return false; }
}
