export function validateConfig(cfg) {
  const warnings = [];
  if (!['native', 'auto', 'container'].includes(cfg.runtime?.mode)) warnings.push('PREVIEW_MODE must be native, auto, or container.');
  if (cfg.bind !== '0.0.0.0') warnings.push('FACTORY_BIND is not 0.0.0.0; SoloHost preview routing may be limited.');
  return { ok: true, warnings };
}
