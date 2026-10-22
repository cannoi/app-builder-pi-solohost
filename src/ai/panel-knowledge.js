/**
 * Runtime-generated AI Panel knowledge — must match routing defaults.
 */
import { DEFAULT_PROVIDER_PRIORITY, ROUTING_MODE } from './hub/routing.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

function pkgVersion() {
  try {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
    return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

export function buildPanelKnowledge({
  lang = 'en',
  routingMode = ROUTING_MODE.AUTO,
  preferredModels = [],
  connections = [],
  orchestrator = true,
} = {}) {
  const ver = pkgVersion();
  const providers = (connections || []).map((c) => c.provider || c.id).filter(Boolean);
  const defaultProv = DEFAULT_PROVIDER_PRIORITY[0]; // gemini
  if (String(lang).toLowerCase().startsWith('vi')) {
    return [
      `App Builder — Pi SoloHost v${ver}.`,
      `AI mặc định: ${defaultProv} (Auto). Hỗ trợ đa provider: Gemini, DeepSeek, Custom, Personal AI Hub.`,
      routingMode === 'SELECTED' && preferredModels.length
        ? `Model đang chọn: ${preferredModels.join(', ')}.`
        : 'Chế độ Auto: ưu tiên Gemini, rồi Custom/Hub, DeepSeek.',
      providers.length ? `Provider đã cấu hình: ${providers.join(', ')}.` : 'Chưa có API key — mở ⚙ Settings để thêm.',
      orchestrator ? 'Yêu cầu phức tạp dùng Orchestrator (kế hoạch → sửa → kiểm).' : '',
      'Trả lời theo ngôn ngữ người dùng. SoloHost: một pi.ui.primary, cổng 127.0.0.1:HOST:CONTAINER.',
    ].filter(Boolean).join(' ');
  }
  return [
    `App Builder — Pi SoloHost v${ver}.`,
    `Default AI: ${defaultProv} (Auto mode). Multi-provider: Gemini, DeepSeek, Custom, Personal AI Hub.`,
    routingMode === 'SELECTED' && preferredModels.length
      ? `Selected model(s): ${preferredModels.join(', ')}.`
      : 'Auto mode: Gemini first, then Custom/Hub, then DeepSeek.',
    providers.length ? `Configured: ${providers.join(', ')}.` : 'No API key yet — open ⚙ Settings to add one.',
    orchestrator ? 'Complex requests use Orchestrator (plan → edit → verify).' : '',
    'Replies match the user language. SoloHost: one pi.ui.primary, 127.0.0.1:HOST:CONTAINER.',
  ].filter(Boolean).join(' ');
}
