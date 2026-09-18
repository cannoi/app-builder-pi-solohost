export function validateConfig(cfg) {
  const warnings = [];
  if (cfg.docker?.mode === 'safe') warnings.push('DOCKER_MODE=safe blocks Build/Run until power mode is enabled.');
  if (cfg.bind !== '0.0.0.0') warnings.push('FACTORY_BIND is not 0.0.0.0; SoloHost preview routing may be limited.');
  return { ok: true, warnings };
}
