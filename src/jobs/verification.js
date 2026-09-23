export function mergeVerificationState(previous = {}, verified = {}) {
  return {
    ...previous,
    staticResult: verified.staticResult || previous.staticResult || null,
    nodeResult: verified.nodeResult || previous.nodeResult || null,
    scan: verified.scan || previous.scan || null,
    preview: verified.dockerBuild || verified.preview || previous.preview || null,
    dockerBuild: verified.dockerBuild || previous.dockerBuild || null,
    e2e: verified.e2e || previous.e2e || null,
    imageFile: verified.imageFile || previous.imageFile || null,
    securityRepair: verified.securityRepair || previous.securityRepair || null,
    verifiedAt: new Date().toISOString(),
  };
}
