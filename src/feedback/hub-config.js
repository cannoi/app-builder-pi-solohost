/**
 * SoloHost Feedback Hub — server-side only. Never expose ingestToken to the browser.
 * Env overrides: SHFH_HUB_ID, SHFH_HUB_URL, SHFH_INGEST_TOKEN
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function packageMeta() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf8'));
    return { version: pkg.version || '0.0.0', name: pkg.name || 'app-builder' };
  } catch {
    return { version: '0.0.0', name: 'app-builder' };
  }
}

const meta = packageMeta();

export const hubId = process.env.SHFH_HUB_ID || 'SHFH-CANNOI-0905428801';
export const baseUrl = process.env.SHFH_HUB_URL || 'http://14.176.78.46:8090';
/** App-client ingest token — rotate via SHFH_INGEST_TOKEN without rebuild. */
export const ingestToken = process.env.SHFH_INGEST_TOKEN || 'cannoi_7Kp9xV2mQ8rN4tY6cL3wA5zD1eF0uH9';
export const appId = process.env.FEEDBACK_APP_ID || 'app-builder-pi-solohost';
export const appName = process.env.FEEDBACK_APP_NAME || 'App Builder — Pi SoloHost';
export const version = meta.version;

export function publicFeedbackConfig() {
  return { hubId, appId, appName, version, baseUrl: undefined };
}

export default { hubId, baseUrl, ingestToken, appId, appName, version, publicFeedbackConfig };
