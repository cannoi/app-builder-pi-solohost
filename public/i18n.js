(function (global) {
  const dict = {
    en: {
      'chat.placeholder': 'Describe your app idea, paste a GitHub link, or say what to change…',
      'chat.hint': '1 Idea → 2 Run → 3 Publish. I keep the next step visible.',
      'qa.run': '▶ Run',
      'qa.publish': '🚀 Publish',
      'qa.donate': '💛 Donate',
      'more.title': 'More',
      'more.zip': '⬇ Download ZIP',
      'more.import': '⬆ Import ZIP',
      'more.sandbox': '🧪 Sandbox',
      'more.scriptRun': '📦 Run script on PC',
      'more.scriptGithub': '⬆ GitHub push script',
      'more.rollback': '↩ Undo',
      'more.support': '💛 Support',
      'welcome.title': 'App Builder — Pi SoloHost',
      'welcome.body': 'Type an idea, paste a GitHub link to upgrade, attach a ZIP, or ask to change a feature. One chat — I route the rest.',
      'welcome.idea': '💡 Sample idea',
      'welcome.github': '🔗 Paste GitHub link',
      'welcome.settings': '⚙ Connect AI',
      'welcome.chip': '💡 Try: milk-tea shop app',
      'welcome.ideaText': 'Create a simple sales app for a small shop',
      'welcome.chipText': 'Create a milk-tea shop app with menu and cart',
      'msg.needApp': 'Open or create an app first.',
      'msg.startIdea': 'Start with your app idea in the chat. I will create the project first.',
      'remote.title': 'Remote access',
      'remote.hide': 'Hide',
      'remote.show': 'Show',
      'remote.save': 'Save URL',
      'remote.copy': 'Copy URL',
      'remote.genPass': 'Create password',
      'top.settings': 'Settings',
      'pill.ready': 'Ready',
    },
    vi: {
      'chat.placeholder': 'Mô tả ý tưởng app, dán link GitHub, hoặc nói cần đổi gì…',
      'chat.hint': '1 Ý tưởng → 2 Chạy thử → 3 Xuất bản. Tôi luôn hiện bước tiếp theo.',
      'qa.run': '▶ Chạy thử',
      'qa.publish': '🚀 Xuất bản',
      'qa.donate': '💛 Ủng hộ',
      'more.title': 'Thêm',
      'more.zip': '⬇ Tải ZIP',
      'more.import': '⬆ Nhập ZIP',
      'more.sandbox': '🧪 Sandbox',
      'more.scriptRun': '📦 Script chạy trên PC',
      'more.scriptGithub': '⬆ Script đẩy GitHub',
      'more.rollback': '↩ Hoàn tác',
      'more.support': '💛 Ủng hộ',
      'welcome.title': 'App Builder — Pi SoloHost',
      'welcome.body': 'Gõ ý tưởng, dán link GitHub để nâng cấp, đính kèm ZIP, hoặc nhờ đổi tính năng. Một ô chat — tôi tự phân loại và làm.',
      'welcome.idea': '💡 Ý tưởng mẫu',
      'welcome.github': '🔗 Dán link GitHub',
      'welcome.settings': '⚙ Kết nối AI',
      'welcome.chip': '💡 Thử: app bán trà sữa',
      'welcome.ideaText': 'Tạo app quản lý bán hàng đơn giản cho cửa hàng nhỏ',
      'welcome.chipText': 'Tạo app bán trà sữa với menu và giỏ hàng',
      'msg.needApp': 'Hãy mở hoặc tạo app trước.',
      'msg.startIdea': 'Hãy gõ ý tưởng app vào ô chat. Tôi sẽ tạo dự án trước.',
      'remote.title': 'Truy cập từ xa',
      'remote.hide': 'Ẩn',
      'remote.show': 'Hiện',
      'remote.save': 'Lưu URL',
      'remote.copy': 'Sao chép',
      'remote.genPass': 'Tạo mật khẩu',
      'top.settings': 'Cài đặt',
      'pill.ready': 'Sẵn sàng',
    },
  };

  let locale = 'en';
  try {
    const saved = localStorage.getItem('paf_locale');
    if (saved === 'vi' || saved === 'en') locale = saved;
    // Default remains English; user chooses VI via the language toggle
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
        'script-run': 'more.scriptRun',
        'script-github': 'more.scriptGithub',
        rollback: 'more.rollback',
        support: 'more.support',
      };
      more.querySelectorAll('[data-more]').forEach((b) => {
        const key = map[b.getAttribute('data-more')];
        if (key) b.textContent = t(key); // single label (icon already in dictionary string)
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
