/**
 * Engineering Toolkit configuration & mode resolution (v1.11.0, N1).
 *
 * Precedence: env ENGINEERING_TOOLKIT > persisted Settings > shadow default (until Pi budget verified).
 * When configured as "auto", resolves to "on" only when Chromium is detected AND free RAM >= threshold
 * (default 1.5 GB) AND not ARM-with-low-RAM; otherwise resolves to "shadow".
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_MIN_FREE_MB = 1536; // 1.5 GB
export const DEFAULT_ARM_MIN_TOTAL_MB = 2048; // 2.0 GB

export const DEFAULT_ENGINEERING_FEATURES = Object.freeze({
  runtimeValidation: true,
  browserQa: true,
  evidenceToAi: true,
  regressionGate: true,
  autoRollback: true,
});

function fileExistsSync(p) {
  try {
    return Boolean(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function detectChromiumSync() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ];
  for (const p of candidates) {
    if (fileExistsSync(p)) return p;
  }
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), '.cache', 'ms-playwright'),
    '/ms-playwright',
    '/opt/ms-playwright',
  ].filter(Boolean);
  for (const root of roots) {
    let dirs = [];
    try {
      dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
    } catch {
      continue;
    }
    for (const d of dirs) {
      for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const p = path.join(root, d, rel);
        if (fileExistsSync(p)) return p;
      }
    }
  }
  return null;
}

export function normalizeConfiguredMode(raw) {
  const s = String(raw ?? '').toLowerCase().trim();
  if (!s) return '';
  if (s === 'off' || s === '0' || s === 'false') return 'off';
  if (s === 'on' || s === '1' || s === 'true') return 'on';
  if (s === 'auto') return 'auto';
  if (s === 'shadow') return 'shadow';
  return 'shadow';
}

export function normalizeEngineeringFeatures(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const key of Object.keys(DEFAULT_ENGINEERING_FEATURES)) {
    out[key] = src[key] === undefined ? true : Boolean(src[key]);
  }
  return out;
}

export function detectAutoEnvironment(detectors = {}, cfg = {}) {
  const minFreeMb = Number(
    detectors.minFreeMb
      ?? process.env.ENGINEERING_MIN_FREE_MB
      ?? cfg?.engineering?.minFreeMb
      ?? DEFAULT_MIN_FREE_MB,
  );
  const armMinTotalMb = Number(
    detectors.armMinTotalMb
      ?? process.env.ENGINEERING_ARM_MIN_TOTAL_MB
      ?? cfg?.engineering?.armMinTotalMb
      ?? DEFAULT_ARM_MIN_TOTAL_MB,
  );

  const arch = String(typeof detectors.arch === 'function' ? detectors.arch() : (detectors.arch ?? os.arch()));
  const freeBytes = Number(typeof detectors.freeMemBytes === 'function' ? detectors.freeMemBytes() : (detectors.freeMemBytes ?? os.freemem()));
  const totalBytes = Number(typeof detectors.totalMemBytes === 'function' ? detectors.totalMemBytes() : (detectors.totalMemBytes ?? os.totalmem()));
  const chromiumPath = typeof detectors.hasChromium === 'function'
    ? detectors.hasChromium()
    : (detectors.hasChromium !== undefined ? detectors.hasChromium : detectChromiumSync());
  const hasChromium = Boolean(chromiumPath);

  const freeMb = Math.round(freeBytes / 1048576);
  const totalMb = Math.round(totalBytes / 1048576);
  const isArm = /^arm|^aarch64/i.test(arch);
  const armLowRam = isArm && (totalMb < armMinTotalMb || freeMb < minFreeMb);

  const checks = { hasChromium, freeMb, totalMb, minFreeMb, armMinTotalMb, arch, isArm, armLowRam };

  if (!hasChromium) {
    return {
      mode: 'shadow',
      reason: `Auto → shadow: Chromium not detected (${arch}, ${freeMb} MB free RAM)`,
      reasonVi: `Tự động → shadow: chưa phát hiện Chromium (${arch}, còn ${freeMb} MB RAM trống)`,
      checks,
    };
  }
  if (armLowRam) {
    return {
      mode: 'shadow',
      reason: `Auto → shadow: ARM low-RAM host (${freeMb} MB free / ${totalMb} MB total < ${minFreeMb}/${armMinTotalMb} MB)`,
      reasonVi: `Tự động → shadow: thiết bị ARM ít RAM (${freeMb} MB trống / ${totalMb} MB tổng)`,
      checks,
    };
  }
  if (freeMb < minFreeMb) {
    return {
      mode: 'shadow',
      reason: `Auto → shadow: free RAM ${freeMb} MB < ${minFreeMb} MB threshold`,
      reasonVi: `Tự động → shadow: RAM trống ${freeMb} MB < ngưỡng ${minFreeMb} MB`,
      checks,
    };
  }
  return {
    mode: 'on',
    reason: `Auto → on: Chromium ready & ${freeMb} MB free RAM (>= ${minFreeMb} MB, ${arch})`,
    reasonVi: `Tự động → on: Chromium sẵn sàng & còn ${freeMb} MB RAM trống (>= ${minFreeMb} MB, ${arch})`,
    checks,
  };
}

let runtimeOverride = null;

export function setRuntimeEngineeringSettings(settings) {
  runtimeOverride = settings && typeof settings === 'object' ? { ...settings } : null;
}

export function resolveEngineeringState({ cfg = {}, db = null, detectors = {} } = {}) {
  const storedDb = db && typeof db.setting === 'function' ? db.setting('engineeringSettings', null) : null;
  const settingsObj = storedDb || cfg?.engineering || runtimeOverride || null;
  const features = normalizeEngineeringFeatures(settingsObj?.features || cfg?.engineering?.features);

  const envRaw = normalizeConfiguredMode(process.env.ENGINEERING_TOOLKIT);
  const envLocked = Boolean(envRaw);

  if (envRaw) {
    if (envRaw === 'auto') {
      const autoRes = detectAutoEnvironment(detectors, cfg);
      return {
        mode: autoRes.mode,
        configuredMode: 'auto',
        source: 'auto',
        envLocked: true,
        reason: autoRes.reason,
        reasonVi: autoRes.reasonVi,
        checks: autoRes.checks,
        features,
      };
    }
    return {
      mode: envRaw,
      configuredMode: envRaw,
      source: 'env',
      envLocked: true,
      reason: `Configured via ENGINEERING_TOOLKIT=${envRaw} environment variable`,
      reasonVi: `Cấu hình qua biến môi trường ENGINEERING_TOOLKIT=${envRaw}`,
      checks: null,
      features,
    };
  }

  const settingRaw = normalizeConfiguredMode(settingsObj?.mode ?? settingsObj?.toolkit);
  if (settingRaw) {
    if (settingRaw === 'auto') {
      const autoRes = detectAutoEnvironment(detectors, cfg);
      return {
        mode: autoRes.mode,
        configuredMode: 'auto',
        source: 'auto',
        envLocked: false,
        reason: autoRes.reason,
        reasonVi: autoRes.reasonVi,
        checks: autoRes.checks,
        features,
      };
    }
    return {
      mode: settingRaw,
      configuredMode: settingRaw,
      source: 'settings',
      envLocked: false,
      reason: `Configured via Settings (${settingRaw})`,
      reasonVi: `Cấu hình qua Cài đặt (${settingRaw})`,
      checks: null,
      features,
    };
  }

  // N1 decision gate: Pi budget not yet verified on real hardware → default stays shadow.
  return {
    mode: 'shadow',
    configuredMode: 'shadow',
    source: 'auto',
    envLocked: false,
    reason: 'Default is shadow until Raspberry Pi budget is verified (use Enable quality checks or Settings)',
    reasonVi: 'Mặc định là shadow cho tới khi xác minh ngân sách trên Raspberry Pi (nhấn Bật kiểm tra chất lượng hoặc chỉnh trong Cài đặt)',
    checks: null,
    features,
  };
}

/** ENGINEERING_TOOLKIT flag: off | shadow | on (default shadow when unset; supports auto). */
export function getEngineeringMode(cfg = {}, deps = {}) {
  return resolveEngineeringState({ cfg, ...deps }).mode;
}

export function isEngineeringEnabled(cfg, deps = {}) {
  return getEngineeringMode(cfg, deps) !== 'off';
}

export function isEngineeringActive(cfg, deps = {}) {
  return getEngineeringMode(cfg, deps) === 'on';
}
