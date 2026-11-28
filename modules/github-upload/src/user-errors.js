/**
 * Map raw GitHub/git failures → short title + detail + single action (en).
 * Never expose the token.
 */
export function explainGitHubError(err, { locale = 'en' } = {}) {
  const raw = String(err?.message || err || '');
  const status = Number(err?.status || err?.code === 'workflow_scope' ? 403 : 0) || 0;
  const code = String(err?.code || '');
  const vi = String(locale).toLowerCase().startsWith('vi');

  const pack = (key, en, viText) => (vi ? viText : en);

  if (/without ['`]?workflow['`]? scope|update workflow|create or update workflow/i.test(raw) || code === 'workflow_scope') {
    return {
      code: 'TOKEN_WORKFLOW',
      who: 'token',
      userTitle: pack('t', 'GitHub token is missing the Workflow permission', 'Token GitHub thiếu quyền Workflow'),
      userDetail: pack('d',
        'Publishing needs to upload .github/workflows (Actions). Your token cannot change workflow files.',
        'Publish cần tải file .github/workflows (Actions). Token hiện tại không được phép sửa workflow.'),
      userAction: pack('a',
        'Open https://github.com/settings/tokens/new → classic token → enable repo, workflow, write:packages → paste in Settings → Save → Publish again.',
        'Mở https://github.com/settings/tokens/new → token classic → bật repo, workflow, write:packages → dán vào Settings → Lưu → Publish lại.'),
    };
  }

  if (status === 401 || /bad credentials|requires authentication|GITHUB_NOT_CONFIGURED|authorization is required/i.test(raw) || code === 'auth') {
    return {
      code: 'TOKEN_AUTH',
      who: 'token',
      userTitle: pack('t', 'GitHub sign-in failed', 'Không đăng nhập được GitHub'),
      userDetail: pack('d', 'The token is missing, expired, or invalid.', 'Token thiếu, hết hạn hoặc không hợp lệ.'),
      userAction: pack('a',
        'Settings → GitHub token → paste a new classic token (repo + workflow + write:packages) → Save → Publish.',
        'Settings → GitHub token → dán token classic mới (repo + workflow + write:packages) → Lưu → Publish.'),
    };
  }

  if (status === 403 || /permission|resource not accessible|protected branch/i.test(raw) || code === 'permission') {
    return {
      code: 'TOKEN_PERMISSION',
      who: 'token',
      userTitle: pack('t', 'GitHub refused this write', 'GitHub từ chối ghi'),
      userDetail: pack('d', 'The account signed in, but cannot write this repository (token scopes or org policy).', 'Đã đăng nhập nhưng không ghi được repo (thiếu quyền token hoặc chính sách org).'),
      userAction: pack('a',
        'Use a classic token with repo + workflow + write:packages, and confirm you can push to this repo on github.com.',
        'Dùng token classic đủ repo + workflow + write:packages, và kiểm tra bạn push được repo này trên github.com.'),
    };
  }

  if (/fetch first|non-fast-forward|\[rejected\].*HEAD|updates were rejected/i.test(raw) || code === 'remote_ahead') {
    return {
      code: 'REMOTE_AHEAD',
      who: 'github',
      userTitle: pack('t', 'GitHub already has different commits on this branch', 'Nhánh GitHub đã có commit khác'),
      userDetail: pack('d', 'Remote main is not empty / has history this publish did not start from.', 'Nhánh main trên GitHub không trống hoặc khác bản đang Publish.'),
      userAction: pack('a',
        'Publish again and choose Overwrite, or delete the GitHub repo and Publish to a new empty name.',
        'Publish lại và chọn Ghi đè (Overwrite), hoặc xóa repo trên GitHub rồi Publish tên mới.'),
    };
  }

  if (/file too large|file_too_large/i.test(raw) || code === 'file_too_large') {
    return {
      code: 'FILE_TOO_LARGE',
      who: 'project',
      userTitle: pack('t', 'A file is too large to upload', 'Có file quá lớn để tải lên'),
      userDetail: pack('d', 'GitHub rejected a large file in the project source.', 'GitHub từ chối một file lớn trong source.'),
      userAction: pack('a',
        'Remove large ZIP/video files from the project, then Publish again.',
        'Xóa file ZIP/video lớn khỏi project rồi Publish lại.'),
    };
  }

  if (/could not resolve|enotfound|network|timed out|econnreset|fetch failed/i.test(raw) || code === 'network') {
    return {
      code: 'NETWORK',
      who: 'network',
      userTitle: pack('t', 'Network problem reaching GitHub', 'Lỗi mạng tới GitHub'),
      userDetail: pack('d', 'The connection dropped or timed out.', 'Kết nối đứt hoặc hết thời gian chờ.'),
      userAction: pack('a', 'Check Internet on this machine, then tap Publish once more.', 'Kiểm tra mạng máy này, rồi bấm Publish thêm một lần.'),
    };
  }

  if (/git not found|ENOENT.*git|spawn git/i.test(raw)) {
    return {
      code: 'GIT_MISSING',
      who: 'builder',
      userTitle: pack('t', 'Git is not available in this environment', 'Môi trường không có lệnh git'),
      userDetail: pack('d', 'Builder tried local git upload but git is not installed.', 'Builder cần git nhưng máy/container chưa cài git.'),
      userAction: pack('a', 'Install git on the host/image, or Download Project and upload files on github.com.', 'Cài git trên máy/image, hoặc Download Project và tải tay lên github.com.'),
    };
  }

  return {
    code: 'UNKNOWN',
    who: 'unknown',
    userTitle: pack('t', 'GitHub upload did not finish', 'Tải lên GitHub chưa xong'),
    userDetail: pack('d', raw.slice(0, 280) || 'Unexpected error.', (raw.slice(0, 280) || 'Lỗi không xác định.')),
    userAction: pack('a',
      'Download Project as backup. Check token (repo + workflow + write:packages), then Publish again.',
      'Download Project để giữ bản sao. Kiểm tra token (repo + workflow + write:packages), rồi Publish lại.'),
  };
}

export function formatUserFacingError(explained) {
  const e = explained || {};
  return [e.userTitle, e.userDetail, e.userAction ? `→ ${e.userAction}` : ''].filter(Boolean).join('\n');
}
