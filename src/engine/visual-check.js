/**
 * Optional Playwright visual advice — never sole reason for rollback.
 */
import path from 'node:path';
import fs from 'node:fs/promises';

export async function runVisualCheck({
  previewUrl,
  artifactsDir,
  playwrightModule = null,
  ai = null,
  checklist = [],
  timeoutMs = 45000,
  emit = () => {},
} = {}) {
  if (!previewUrl) {
    return { status: 'unverified', reason: 'no_preview_url' };
  }
  let pw = playwrightModule;
  if (!pw) {
    try {
      pw = await import('../testing/playwright.js').catch(() => null);
    } catch {
      pw = null;
    }
  }
  if (!pw || typeof pw.launchPreview !== 'function' && typeof pw.withPage !== 'function') {
    emit('visual', 'done', 'Playwright unavailable — visual check skipped');
    return { status: 'unverified', reason: 'no_playwright' };
  }

  const errors = [];
  const shots = [];
  try {
    const runner = pw.withPage || pw.launchPreview;
    await Promise.race([
      (async () => {
        // Best-effort API: if module exports capturePreviewScreens
        if (typeof pw.capturePreviewScreens === 'function') {
          const r = await pw.capturePreviewScreens({
            url: previewUrl,
            widths: [1280, 390],
            onConsole: (t) => errors.push(t),
            onPageError: (t) => errors.push(String(t)),
            onRequestFailed: (t) => errors.push(`request failed: ${t}`),
          });
          if (r?.shots) shots.push(...r.shots);
        } else {
          emit('visual', 'done', 'Playwright helper has no capturePreviewScreens — skipped');
          return;
        }
      })(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('visual timeout')), timeoutMs)),
    ]);
  } catch (err) {
    return { status: 'unverified', reason: String(err.message || err), errors };
  }

  if (artifactsDir && shots.length) {
    await fs.mkdir(artifactsDir, { recursive: true }).catch(() => {});
    for (const s of shots) {
      if (s?.buffer && s?.name) {
        await fs.writeFile(path.join(artifactsDir, s.name), s.buffer).catch(() => {});
      }
    }
  }

  let vision = null;
  if (ai?.completeJson && shots.some((s) => s.dataUrl || s.buffer)) {
    try {
      const images = shots
        .filter((s) => s.dataUrl || s.buffer)
        .slice(0, 2)
        .map((s) => ({ dataUrl: s.dataUrl || `data:image/png;base64,${Buffer.from(s.buffer).toString('base64')}` }));
      const r = await ai.completeJson({
        task: 'VISION_CHECK',
        system: 'Advise only. Return JSON {verdict:"ok"|"issue", notes:string}.',
        prompt: `Checklist: ${JSON.stringify(checklist).slice(0, 2000)}\nConsole issues: ${errors.slice(0, 10).join('; ')}`,
        images,
      });
      vision = r?.json || null;
    } catch {
      vision = null;
    }
  }

  return {
    status: 'done',
    errors,
    shots: shots.map((s) => s.name).filter(Boolean),
    vision,
    advisoryOnly: true,
  };
}

export default { runVisualCheck };
