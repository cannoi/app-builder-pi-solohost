/**
 * Classify verification failures so ENV issues do not trigger AI code repair.
 */
export const FAILURE_CLASS = Object.freeze({
  ENV_NETWORK: 'ENV_NETWORK',
  ENV_TIMEOUT: 'ENV_TIMEOUT',
  ENV_DISK: 'ENV_DISK',
  DEPENDENCY: 'DEPENDENCY',
  CODE_SYNTAX: 'CODE_SYNTAX',
  CODE_RUNTIME: 'CODE_RUNTIME',
  TEST_ASSERT: 'TEST_ASSERT',
  CONFIG: 'CONFIG',
  UNKNOWN: 'UNKNOWN',
});

export function classifyFailure(errOrText) {
  const msg = String(errOrText?.message || errOrText || '');
  const low = msg.toLowerCase();
  // Environment first: these are never the AI's fault and never fixed by editing project code.
  if (/\b(enotfound|enotcached|econnrefused|econnreset|eai_again|epipe)\b|getaddrinfo|fetch failed|socket hang up|network (?:error|request|is unreachable)|npm (?:err!|error) network|only-if-cached|registry\.npmjs\.org.*(?:fail|unreachable)|offline/i.test(msg)) {
    return { class: FAILURE_CLASS.ENV_NETWORK, aiRepair: false, userEn: 'Network or package registry unavailable.', userVi: 'Mạng hoặc kho gói (registry) không khả dụng.' };
  }
  if (/\b(etimedout|esockettimedout)\b|timed out|time limit|sigterm|killed/i.test(msg)) {
    return { class: FAILURE_CLASS.ENV_TIMEOUT, aiRepair: false, userEn: 'Operation timed out on this device.', userVi: 'Hết thời gian chờ trên thiết bị này.' };
  }
  if (/\b(eacces|eperm|enospc|erofs|enotempty|emfile)\b|permission denied|read-only file system|no space left/i.test(msg)) {
    return { class: FAILURE_CLASS.ENV_DISK, aiRepair: false, userEn: 'Disk or permission problem.', userVi: 'Lỗi đĩa hoặc quyền ghi.' };
  }
  // Code problems (the AI can legitimately fix these) — checked before generic dependency errors.
  if (/syntaxerror|unexpected token|unexpected identifier|unexpected end of input|parse error/i.test(msg)) {
    return { class: FAILURE_CLASS.CODE_SYNTAX, aiRepair: true, userEn: 'Syntax error in project code.', userVi: 'Lỗi cú pháp trong mã.' };
  }
  if (/cannot find module|err_module_not_found|module not found/i.test(msg)) {
    return { class: FAILURE_CLASS.DEPENDENCY, aiRepair: true, userEn: 'A required module is missing or misnamed.', userVi: 'Thiếu hoặc sai tên module cần dùng.' };
  }
  if (/npm (?:err!|error)|peer dep|eresolve|e404|notarget/i.test(msg)) {
    return { class: FAILURE_CLASS.DEPENDENCY, aiRepair: true, userEn: 'Dependency install/resolution failed (check package.json).', userVi: 'Cài đặt dependency thất bại (kiểm tra package.json).' };
  }
  if (/assertionerror|assertion|expect\(|test failed|\bnot ok\b/i.test(msg)) {
    return { class: FAILURE_CLASS.TEST_ASSERT, aiRepair: true, userEn: 'A test assertion failed.', userVi: 'Một kiểm thử không đạt.' };
  }
  if (/invalid yaml|docker-compose|dockerfile|config_options/i.test(low)) {
    return { class: FAILURE_CLASS.CONFIG, aiRepair: true, userEn: 'Configuration problem.', userVi: 'Lỗi cấu hình.' };
  }
  if (/error:|throw |referenceerror|typeerror|rangeerror|unhandled/i.test(msg)) {
    return { class: FAILURE_CLASS.CODE_RUNTIME, aiRepair: true, userEn: 'Runtime error in app code.', userVi: 'Lỗi runtime trong mã app.' };
  }
  return { class: FAILURE_CLASS.UNKNOWN, aiRepair: true, userEn: 'Unrecognized failure.', userVi: 'Lỗi chưa phân loại.' };
}

export function shouldTriggerAiRepair(classification) {
  return Boolean(classification?.aiRepair);
}
