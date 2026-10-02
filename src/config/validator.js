export function validateConfig(cfg) {
  const warnings = [];
  if (!['native', 'auto', 'container'].includes(cfg.runtime?.mode)) warnings.push('PREVIEW_MODE must be native, auto, or container.');
  if (cfg.bind !== '0.0.0.0') warnings.push('FACTORY_BIND is not 0.0.0.0; SoloHost preview routing may be limited.');
  if (String(cfg.security?.accessPassword || '').length < 16) warnings.push('BUILDER_ACCESS_PASSWORD must be set to at least 16 characters before API and project access is available.');
  return { ok: true, warnings };
}
