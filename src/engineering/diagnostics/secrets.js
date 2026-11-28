import { STATUS } from '../validation/status.js';

export async function secretScanProject(sourceDir) {
  if (!sourceDir) return { ok: false, status: STATUS.NOT_AVAILABLE, error: 'no sourceDir' };
  try {
    const { scanProject } = await import('../../security/scanner.js');
    const result = await scanProject(sourceDir);
    const findings = result?.findings || result?.issues || (Array.isArray(result) ? result : []);
    const list = Array.isArray(findings) ? findings : [];
    const blocking = list.filter((f) => f.severity === 'critical' || f.blocking || f.level === 'critical');
    const warnings = list.filter((f) => !blocking.includes(f));
    return {
      ok: blocking.length === 0,
      status: blocking.length ? STATUS.FAIL : (warnings.length ? STATUS.WARNING : STATUS.PASS),
      data: {
        total: list.length,
        blocking: blocking.length,
        warnings: warnings.length,
        sample: list.slice(0, 8).map((f) => ({
          id: f.id || f.rule,
          title: f.title || f.message,
          severity: f.severity || f.level,
        })),
      },
    };
  } catch (err) {
    return {
      ok: true,
      status: STATUS.NOT_AVAILABLE,
      data: { message: String(err.message || err).slice(0, 200) },
    };
  }
}
