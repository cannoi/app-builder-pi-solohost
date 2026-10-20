(function (global) {
  const dict = {
    en: {
      'chat.placeholder': 'Describe your app idea, paste a GitHub link, or say what to change…',
      'chat.hint': 'One chat — I route create, fix, publish, and upgrade.',
      'qa.run': '▶ Run',
      'qa.publish': '🚀 Publish',
      'qa.donate': '💛 Donate',
      'remote.title': 'Remote access',
      'remote.hide': 'Hide',
      'remote.show': 'Show',
      'remote.save': 'Save URL',
      'remote.copy': 'Copy URL',
      'remote.genPass': 'Create password',
      'more.title': 'More',
      'more.zip': 'Download ZIP',
      'more.import': 'Import ZIP',
      'more.sandbox': 'Sandbox',
      'more.support': 'Support',
      'top.settings': 'Settings',
      'pill.ready': 'Ready',
    },
    vi: {
      'chat.placeholder': 'Mô tả ý tưởng app, dán link GitHub, hoặc nói cần đổi gì…',
      'chat.hint': 'Một ô chat — tôi tự phân loại tạo, sửa, xuất bản, nâng cấp.',
      'qa.run': '▶ Chạy thử',
      'qa.publish': '🚀 Xuất bản',
      'qa.donate': '💛 Ủng hộ',
      'remote.title': 'Truy cập từ xa',
      'remote.hide': 'Ẩn',
      'remote.show': 'Hiện',
      'remote.save': 'Lưu URL',
      'remote.copy': 'Sao chép',
      'remote.genPass': 'Tạo mật khẩu',
      'more.title': 'Thêm',
      'more.zip': 'Tải ZIP',
      'more.import': 'Nhập ZIP',
      'more.sandbox': 'Sandbox',
      'more.support': 'Ủng hộ',
      'top.settings': 'Cài đặt',
      'pill.ready': 'Sẵn sàng',
    },
  };
  let locale = 'en';
  try {
    const saved = localStorage.getItem('paf_locale');
    if (saved === 'vi' || saved === 'en') locale = saved;
    else if (String(navigator.language || '').toLowerCase().startsWith('vi')) locale = 'vi';
  } catch {}

  function t(key) {
    return (dict[locale] && dict[locale][key]) || dict.en[key] || key;
  }
  function setLocale(l) {
    locale = l === 'vi' ? 'vi' : 'en';
    try { localStorage.setItem('paf_locale', locale); } catch {}
    apply();
    try {
      document.documentElement.lang = locale === 'vi' ? 'vi' : 'en';
      const btn = document.getElementById('langToggle');
      if (btn) btn.textContent = locale === 'vi' ? 'VI' : 'EN';
    } catch {}
    try {
      global.dispatchEvent(new CustomEvent('paf-locale', { detail: { locale } }));
    } catch {}
  }
  function apply() {
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const k = el.getAttribute('data-i18n');
      if (k) el.textContent = t(k);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      const k = el.getAttribute('data-i18n-placeholder');
      if (k) el.setAttribute('placeholder', t(k));
    });
    const btn = document.getElementById('langToggle');
    if (btn) btn.textContent = locale === 'vi' ? 'VI' : 'EN';
    const more = document.getElementById('moreMenu');
    if (more) {
      const map = {
        export: 'more.zip',
        import: 'more.import',
        sandbox: 'more.sandbox',
        support: 'more.support',
      };
      more.querySelectorAll('[data-more]').forEach((b) => {
        const key = map[b.getAttribute('data-more')];
        if (key) {
          const icon = (b.textContent || '').trim().slice(0, 2);
          b.textContent = (icon.match(/[⬇⬆🧪💛]/) ? icon + ' ' : '') + t(key);
        }
      });
    }
  }
  function toggle() {
    setLocale(locale === 'vi' ? 'en' : 'vi');
  }
  global.pafI18n = { t, setLocale, getLocale: () => locale, apply, toggle, dict };
  if (typeof document !== 'undefined') {
    const boot = () => {
      apply();
      document.getElementById('langToggle')?.addEventListener('click', (e) => {
        e.preventDefault();
        toggle();
      });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})(typeof window !== 'undefined' ? window : globalThis);
