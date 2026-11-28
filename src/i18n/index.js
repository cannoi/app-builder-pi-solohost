const en = {
  title: 'App Builder — Pi SoloHost',
  tagline: 'Tell me what you want to build. I will handle the technical work.',
  ideaPlaceholder: 'Tell me the app you want. I will lead the rest.',
  buildApp: 'Build app',
  tryDemo: 'Try demo',
  projects: 'Projects',
  ready: 'Ready',
  needsSetup: 'Setup needed',
  wizardTitle: 'Settings',
  wizardAi: 'AI provider',
  wizardKey: 'API key',
  wizardGithub: 'GitHub (optional)',
  wizardDocker: 'Docker mode',
  save: 'Save',
  skip: 'Skip for now',
  acceptPlan: 'Build app',
  changePlan: 'Change plan',
  askAi: 'Ask AI',
  advanced: 'Advanced',
  approveRelease: 'Approve release',
  rollback: 'Rollback',
  'solohost.kit.title': 'SoloHost install kit',
  'solohost.kit.guide': '1) SoloHost → Add app  2) Copy each file  3) Save → Start',
  'solohost.kit.copy': 'Copy',
  'solohost.kit.validate': 'Validate again',
  'solohost.kit.preview_env': 'Preview .env',
  'solohost.kit.status_ok': 'OK',
  'solohost.kit.status_fail': 'FAIL',
  'solohost.kit.status_unreachable': 'UNREACHABLE',
  'solohost.fields.title': 'Choose install fields',
  'solohost.fields.mode_full': 'Full form',
  'solohost.fields.mode_defaults': 'All defaults (no prompts)',
  'solohost.fields.mode_auth': 'Login password only',
  'solohost.fields.mode_custom': 'Custom per field',
  'solohost.fields.summary': 'The install form will have {n} questions',
  'solohost.fields.keep': 'Ask at start',
  'solohost.fields.fixed': 'Fixed value',
  'solohost.fields.omit': 'Omit',
  'solohost.lint.yaml_invalid': 'Invalid YAML: {detail}',
  'solohost.lint.no_services': 'Compose must declare at least one service.',
  'solohost.lint.no_image': 'Service {service} must use image: (SoloHost does not build from source).',
  'solohost.lint.build_forbidden': 'Service {service} must not use build:.',
  'solohost.lint.privileged': 'Service {service} must not use privileged mode.',
  'solohost.lint.blocked_key': 'Service {service} must not use {key}.',
  'solohost.lint.network_mode': 'Service {service} must not use network_mode host/container.',
  'solohost.lint.bind_mount': 'Bind mounts are not allowed ({volume}).',
  'solohost.lint.undeclared_var': 'Compose uses ${{{var}}} but config_options has no matching field.',
  'solohost.lint.fixed_secret': 'fixed_values must not store secrets ({name}).',
  'solohost.lint.omit_needs_volume': 'Omitting fields requires a named volume for app data.',
  'solohost.lint.primary_port': 'UI service should expose exactly one 127.0.0.1:HOST:CONTAINER port.',
  'solohost.lint.primary_count': 'Exactly one service should have pi.ui.primary.',
  'solohost.lint.password_preserve': 'Password field {name} should set preserve_if_blank: true.',
  'solohost.lint.unused_field': 'Field {name} is not used in the compose environment.',
  'solohost.lint.no_volume': 'Consider a named volume so app data survives restarts.',
  'solohost.lint.latest_tag': 'Prefer a pinned image tag over :latest.',
  'solohost.lint.compose_version': 'Top-level version: is obsolete; remove it.',
  'solohost.lint.config_unknown_key': 'Unknown config_options key: {key}',
  'solohost.lint.field_type': 'Field {name} has unsupported type {type}.',
};

const vi = {
  'solohost.kit.title': 'Bộ cài SoloHost',
  'solohost.kit.guide': '1) SoloHost → Thêm app  2) Copy từng file  3) Lưu → Start',
  'solohost.kit.copy': 'Sao chép',
  'solohost.fields.title': 'Chọn trường khai báo cho 2 file SoloHost',
  'solohost.fields.mode_full': 'Đầy đủ các trường',
  'solohost.fields.mode_defaults': 'Mặc định (không cần khai báo)',
  'solohost.fields.mode_auth': 'Tối thiểu mật khẩu đăng nhập',
  'solohost.fields.mode_custom': 'Tự chọn & gán cứng từng trường',
  'solohost.fields.keep': 'Khai báo khi chạy',
  'solohost.fields.fixed': 'Fix cứng giá trị',
  'solohost.fields.omit': 'Bỏ qua',
};

const zh = {
  'solohost.kit.title': 'SoloHost 安装套件',
  'solohost.kit.guide': '1) SoloHost → 添加应用  2) 复制两个文件  3) 保存 → 启动',
  'solohost.kit.copy': '复制',
  'solohost.fields.title': '选择安装配置字段',
  'solohost.fields.mode_full': '完整表单',
  'solohost.fields.mode_defaults': '全部默认（无需填写）',
  'solohost.fields.mode_auth': '仅登录密码',
  'solohost.fields.mode_custom': '自定义每个字段',
  'solohost.fields.keep': '启动时询问',
  'solohost.fields.fixed': '固定值',
  'solohost.fields.omit': '跳过',
};

const ja = {
  'solohost.kit.title': 'SoloHost インストールキット',
  'solohost.kit.guide': '1) SoloHost → アプリ追加  2) 2ファイルをコピー  3) 保存 → 起動',
  'solohost.kit.copy': 'コピー',
  'solohost.fields.title': 'インストール設定項目を選択',
  'solohost.fields.mode_full': 'すべて表示',
  'solohost.fields.mode_defaults': 'デフォルト（入力不要）',
  'solohost.fields.mode_auth': 'ログインパスワードのみ',
  'solohost.fields.mode_custom': '項目ごとに設定',
  'solohost.fields.keep': '起動時に入力',
  'solohost.fields.fixed': '固定値',
  'solohost.fields.omit': '省略',
};

const ko = {
  'solohost.kit.title': 'SoloHost 설치 키트',
  'solohost.kit.guide': '1) SoloHost → 앱 추가  2) 파일 복사  3) 저장 → 시작',
  'solohost.kit.copy': '복사',
  'solohost.fields.title': '설치 입력 필드 선택',
  'solohost.fields.mode_full': '전체 입력',
  'solohost.fields.mode_defaults': '기본값(입력 없음)',
  'solohost.fields.mode_auth': '로그인 비밀번호만',
  'solohost.fields.mode_custom': '필드별 사용자 지정',
  'solohost.fields.keep': '시작 시 입력',
  'solohost.fields.fixed': '고정값',
  'solohost.fields.omit': '제외',
};

const es = {
  'solohost.kit.title': 'Kit de instalación SoloHost',
  'solohost.kit.copy': 'Copiar',
  'solohost.fields.title': 'Elegir campos de instalación',
  'solohost.fields.mode_full': 'Formulario completo',
  'solohost.fields.mode_defaults': 'Valores por defecto (sin pedir)',
  'solohost.fields.mode_auth': 'Solo contraseña de acceso',
  'solohost.fields.mode_custom': 'Personalizado por campo',
};

const fr = {
  'solohost.kit.title': 'Kit d’installation SoloHost',
  'solohost.kit.copy': 'Copier',
  'solohost.fields.title': 'Choisir les champs d’installation',
  'solohost.fields.mode_full': 'Formulaire complet',
  'solohost.fields.mode_defaults': 'Valeurs par défaut (sans saisie)',
  'solohost.fields.mode_auth': 'Mot de passe uniquement',
  'solohost.fields.mode_custom': 'Personnalisé par champ',
};

const de = {
  'solohost.kit.title': 'SoloHost-Installationskit',
  'solohost.kit.copy': 'Kopieren',
  'solohost.fields.title': 'Installationsfelder wählen',
  'solohost.fields.mode_full': 'Vollständiges Formular',
  'solohost.fields.mode_defaults': 'Standardwerte (ohne Abfrage)',
  'solohost.fields.mode_auth': 'Nur Anmelde-Passwort',
  'solohost.fields.mode_custom': 'Pro Feld anpassen',
};

const pt = {
  'solohost.kit.title': 'Kit de instalação SoloHost',
  'solohost.kit.copy': 'Copiar',
  'solohost.fields.title': 'Escolher campos de instalação',
  'solohost.fields.mode_full': 'Formulário completo',
  'solohost.fields.mode_defaults': 'Padrões (sem perguntas)',
  'solohost.fields.mode_auth': 'Apenas senha de login',
  'solohost.fields.mode_custom': 'Personalizado por campo',
};

const id = { 'solohost.kit.title': 'Kit instalasi SoloHost', 'solohost.kit.copy': 'Salin' };

const catalogs = { en, vi, zh, ja, ko, es, fr, de, pt, id };

function format(str, params = {}) {
  return String(str).replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? String(params[k]) : `{${k}}`));
}

export function t(locale, key, params = {}) {
  const loc = String(locale || 'en').toLowerCase().slice(0, 2);
  const table = catalogs[loc] || en;
  const raw = table[key] || en[key] || key;
  return format(raw, params);
}

export function catalog(locale = 'en') {
  const loc = String(locale || 'en').toLowerCase().slice(0, 2);
  return { ...en, ...(catalogs[loc] || {}) };
}

export const locales = Object.keys(catalogs);
