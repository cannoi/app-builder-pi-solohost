import fs from 'node:fs';

export function dockerStatus(mode) {
  const socket = '/var/run/docker.sock';
  const socketPresent = fs.existsSync(socket);
  return {
    mode: mode === 'power' ? 'power' : 'safe',
    socketPresent,
    usable: mode === 'power' && socketPresent,
    message: mode === 'power'
      ? (socketPresent
        ? 'POWER mode: Docker access is available on this host.'
        : 'POWER mode is set but the Docker socket is not available.')
      : 'SAFE mode: App Factory will not control the host Docker daemon.',
  };
}

export function powerWarning() {
  return 'Docker access allows Pi App Factory to build and test containers directly on this SoloHost. This gives the application additional system privileges. Enable it only if you trust the application.';
}
