/**
 * Plain-language preview messages (English + Vietnamese).
 * Short, no jargon, no container terms. One place so UI and API agree.
 */

export const PREVIEW_NOTICE = {
  en: "Preview runs your app live here. Docker isn't available in preview — Publish to run the Docker version.",
  vi: 'Xem thử chạy app trực tiếp tại đây. Preview không hỗ trợ Docker — hãy Xuất bản để chạy bản Docker.',
};

export const CONTAINER_ONLY = {
  en: "This app needs Docker, and preview doesn't support Docker. Publish it to run it for real.",
  vi: 'App này cần Docker, mà preview không hỗ trợ Docker. Hãy Xuất bản để chạy thật.',
};

const REASONS = {
  INVALID_PACKAGE_JSON: {
    en: 'package.json is broken, so the app cannot start.',
    vi: 'Tệp package.json bị lỗi nên ứng dụng không thể khởi động.',
  },
  MISSING_START_SCRIPT: {
    en: 'The app has no start command. Add a "start" script.',
    vi: 'Ứng dụng chưa có lệnh khởi động. Hãy thêm script "start".',
  },
  NO_ENTRY: {
    en: 'No page or start file was found. Build the app first.',
    vi: 'Không tìm thấy trang hoặc tệp khởi động. Hãy tạo ứng dụng trước.',
  },
  INSTALL_FAILED: {
    en: 'Installing the libraries failed.',
    vi: 'Cài thư viện thất bại.',
  },
  INSTALL_TIMEOUT: {
    en: 'Installing the libraries took too long.',
    vi: 'Cài thư viện quá lâu.',
  },
  MISSING_DEPENDENCY: {
    en: 'The app uses a library that is not listed in package.json.',
    vi: 'Ứng dụng dùng thư viện chưa được khai báo trong package.json.',
  },
  PORT_CONFLICT: {
    en: 'The app could not get a free port.',
    vi: 'Ứng dụng không lấy được cổng trống.',
  },
  STARTUP_TIMEOUT: {
    en: 'The app did not start in time.',
    vi: 'Ứng dụng không khởi động kịp thời gian.',
  },
  PROCESS_EXITED: {
    en: 'The app stopped right after starting.',
    vi: 'Ứng dụng tự dừng ngay sau khi khởi động.',
  },
  HEALTH_FAILED: {
    en: 'The app started but does not answer.',
    vi: 'Ứng dụng đã chạy nhưng không phản hồi.',
  },
  TOOLCHAIN_MISSING: {
    en: 'This kind of app needs a tool that is not installed here.',
    vi: 'Loại ứng dụng này cần công cụ chưa được cài ở đây.',
  },
  BROWSER_FAILED: {
    en: 'The page opened but a check failed.',
    vi: 'Trang đã mở nhưng một bước kiểm tra bị lỗi.',
  },
  CRASHED: {
    en: 'The app stopped unexpectedly.',
    vi: 'Ứng dụng đã dừng đột ngột.',
  },
  UNKNOWN: {
    en: 'Preview failed.',
    vi: 'Xem thử thất bại.',
  },
};

export function reasonMessage(code, lang = 'en') {
  const r = REASONS[code] || REASONS.UNKNOWN;
  return r[lang] || r.en;
}

export function reasonMessages(code) {
  const r = REASONS[code] || REASONS.UNKNOWN;
  return { en: r.en, vi: r.vi };
}

export default { PREVIEW_NOTICE, CONTAINER_ONLY, reasonMessage, reasonMessages };
