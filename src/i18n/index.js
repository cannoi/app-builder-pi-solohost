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
  // SoloHost kit card
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
  'solohost.fields.mode_defaults': 'All defaults',
  'solohost.fields.mode_auth': 'Login only',
  'solohost.fields.mode_custom': 'Custom',
  'solohost.fields.summary': 'The install form will have {n} questions',
  'solohost.fields.keep': 'Keep',
  'solohost.fields.fixed': 'Fixed',
  'solohost.fields.omit': 'Omit',
  // Lint messages
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
  'solohost.fields.title': 'Chọn trường cài đặt',
  'solohost.fields.mode_full': 'Đầy đủ',
  'solohost.fields.mode_defaults': 'Mặc định',
  'solohost.fields.mode_auth': 'Chỉ đăng nhập',
  'solohost.fields.mode_custom': 'Tùy chọn',
};


const catalogs = { en, vi };

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

// orch_planning / orch_task_done used by orchestrator emit messages (en/vi in pipeline emit)
