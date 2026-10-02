export function mergeVerificationState(previous = {}, verified = {}) {
  const value = (key) => Object.hasOwn(verified, key) ? verified[key] : (previous[key] ?? null);
  const preview = Object.hasOwn(verified, 'preview')
    ? verified.preview
    : Object.hasOwn(verified, 'dockerBuild')
      ? verified.dockerBuild
      : (previous.preview ?? null);
  return {
    ...previous,
    staticResult: value('staticResult'),
    nodeResult: value('nodeResult'),
    scan: value('scan'),
    preview,
    dockerBuild: value('dockerBuild'),
    e2e: value('e2e'),
    imageFile: value('imageFile'),
    securityRepair: value('securityRepair'),
    sourceHash: value('sourceHash'),
    previewSourceHash: value('previewSourceHash'),
    verifiedAt: verified.verifiedAt || new Date().toISOString(),
  };
}
