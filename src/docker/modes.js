export function runtimeStatus(cfg = {}) {
  const mode = cfg.runtime?.mode || process.env.PREVIEW_MODE || 'native';
  return {
    engine: 'native-preview',
    mode,
    usable: mode === 'native',
    socket: false,
    message: 'Native preview mode is enabled. No host Docker daemon access is used.',
  };
}

export function dockerStatus() {
  return runtimeStatus();
}

export function powerWarning() {
  return 'App Builder runs previews without host Docker access. No Docker socket is required.';
}
