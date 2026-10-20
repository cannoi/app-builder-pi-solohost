/** CHANGE_ENGINE_V2 default OFF — identical to 1.8.2 when unset/false */
export function isChangeEngineV2Enabled(env = process.env) {
  const v = String(env.CHANGE_ENGINE_V2 || env.CHANGE_ENGINE || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export default { isChangeEngineV2Enabled };
