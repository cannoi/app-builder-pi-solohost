/**
 * SoloHost package linter (offline, pure) — aligned with SOLOHOST.md v0.
 */
import YAML from 'yaml';

const ALLOWED_CONFIG_KEYS = new Set([
  'title', 'eyebrow', 'description', 'footer_hint', 'output_file', 'after_save', 'fixed_values', 'fields',
]);
const ALLOWED_FIELD_TYPES = new Set(['text', 'password', 'number', 'select', 'hidden']);
const ALLOWED_DETECT = new Set(['uid', 'gid', 'pi_username']);
const SECRET_NAME = /PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE|CREDENTIAL|MASTER_KEY/i;
const COMMON_HOST_PORTS = new Set([80, 443, 22, 3306, 5432, 6379, 27017, 8080, 3000, 5000, 8000]);

function issue(rule, severity, path, messageKey, params = {}, fix = null) {
  const item = { rule, severity, path, messageKey, params };
  if (fix) item.fix = fix;
  return item;
}

function parseYaml(text, pathLabel) {
  try {
    const doc = YAML.parseDocument(String(text || ''), { prettyErrors: true });
    if (doc.errors?.length) {
      return {
        ok: false,
        errors: doc.errors.map((e) => issue('E-YAML-INVALID', 'error', pathLabel, 'solohost.lint.yaml_invalid', {
          detail: String(e.message || e).slice(0, 200),
        })),
        data: null,
        doc: null,
      };
    }
    return { ok: true, errors: [], data: doc.toJS({ maxAliasCount: 100 }), doc };
  } catch (err) {
    return {
      ok: false,
      errors: [issue('E-YAML-INVALID', 'error', pathLabel, 'solohost.lint.yaml_invalid', {
        detail: String(err.message || err).slice(0, 200),
      })],
      data: null,
      doc: null,
    };
  }
}

/** Collect ${VAR} and ${VAR:-default} from parsed JS values only (not comments). */
function collectEnvVarsFromValue(value, into = new Set(), defaults = new Map()) {
  if (value == null) return into;
  if (typeof value === 'string') {
    for (const m of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g)) {
      into.add(m[1]);
      if (m[2] != null) defaults.set(m[1], m[2]);
    }
    return into;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectEnvVarsFromValue(v, into, defaults);
    return into;
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value)) collectEnvVarsFromValue(v, into, defaults);
  }
  return into;
}

/** Declared = field.name + fixed_values.name (NOT set: keys alone). */
function declaredNames(config) {
  const names = new Set();
  for (const f of (Array.isArray(config?.fields) ? config.fields : [])) {
    if (f?.name) names.add(String(f.name));
  }
  for (const fv of (Array.isArray(config?.fixed_values) ? config.fixed_values : [])) {
    if (fv?.name) names.add(String(fv.name));
  }
  return names;
}

/** Keys that appear only inside select option set: blocks. */
function setOnlyKeys(config) {
  const fieldNames = new Set(
    (Array.isArray(config?.fields) ? config.fields : []).map((f) => f?.name).filter(Boolean),
  );
  const setKeys = new Set();
  for (const f of (Array.isArray(config?.fields) ? config.fields : [])) {
    if (f?.type !== 'select' || !Array.isArray(f.options)) continue;
    for (const opt of f.options) {
      if (opt?.set && typeof opt.set === 'object') {
        for (const k of Object.keys(opt.set)) {
          if (!fieldNames.has(k)) setKeys.add(k);
        }
      }
    }
  }
  return setKeys;
}

export function lintPackage({ composeText, configText, policy = null } = {}) {
  const errors = [];
  const warnings = [];

  const composeParsed = parseYaml(composeText, 'docker-compose.yml');
  const configParsed = parseYaml(configText, 'config_options.yml');
  errors.push(...composeParsed.errors, ...configParsed.errors);
  if (!composeParsed.ok || !configParsed.ok) return { errors, warnings };

  const compose = composeParsed.data || {};
  const config = configParsed.data || {};

  if (compose.version != null) {
    warnings.push(issue('W-COMPOSE-VERSION', 'warning', 'docker-compose.yml', 'solohost.lint.compose_version', {}, {
      action: 'remove_key', key: 'version',
    }));
  }
  if (compose.include != null) {
    errors.push(issue('E-COMPOSE-INCLUDE', 'error', 'docker-compose.yml', 'solohost.lint.compose_include', {}));
  }

  const services = compose.services && typeof compose.services === 'object' ? compose.services : null;
  if (!services || !Object.keys(services).length) {
    errors.push(issue('E-NO-SERVICES', 'error', 'docker-compose.yml', 'solohost.lint.no_services', {}));
  } else {
    let primaryCount = 0;
    for (const [name, svc] of Object.entries(services)) {
      if (!svc || typeof svc !== 'object') continue;
      const path = `services.${name}`;

      if (!svc.image) {
        errors.push(issue('E-NO-IMAGE', 'error', path, 'solohost.lint.no_image', { service: name }, {
          action: 'set_image', service: name,
        }));
      }
      if (svc.build != null) {
        errors.push(issue('E-BUILD', 'error', `${path}.build`, 'solohost.lint.build_forbidden', { service: name }, {
          action: 'remove_build', service: name,
        }));
      }
      if (svc.privileged === true) {
        errors.push(issue('E-PRIVILEGED', 'error', `${path}.privileged`, 'solohost.lint.privileged', { service: name }));
      }
      for (const bad of ['cap_add', 'security_opt', 'extends', 'devices']) {
        if (svc[bad] != null) {
          errors.push(issue(`E-${bad.toUpperCase()}`, 'error', `${path}.${bad}`, 'solohost.lint.blocked_key', {
            service: name, key: bad,
          }));
        }
      }
      if (svc.network_mode === 'host' || String(svc.network_mode || '').startsWith('container:')) {
        errors.push(issue('E-NETWORK-MODE', 'error', `${path}.network_mode`, 'solohost.lint.network_mode', {
          service: name, value: svc.network_mode,
        }));
      }
      if (svc.userns_mode === 'host') {
        errors.push(issue('E-USERNS', 'error', `${path}.userns_mode`, 'solohost.lint.userns_mode', { service: name }));
      }
      for (const ns of ['pid', 'ipc', 'uts', 'cgroup']) {
        const key = `${ns}_mode`;
        if (svc[key] === 'host' || svc[ns] === 'host') {
          errors.push(issue('E-NS-HOST', 'error', `${path}.${key || ns}`, 'solohost.lint.ns_host', {
            service: name, namespace: ns,
          }));
        }
      }
      if (svc.container_name) {
        warnings.push(issue('W-CONTAINER-NAME', 'warning', `${path}.container_name`, 'solohost.lint.container_name', {
          service: name,
        }));
      }
      if (String(svc.image || '').endsWith(':latest')) {
        warnings.push(issue('W-LATEST', 'warning', `${path}.image`, 'solohost.lint.latest_tag', {
          service: name, image: svc.image,
        }));
      }

      const vols = Array.isArray(svc.volumes) ? svc.volumes : [];
      for (const v of vols) {
        if (typeof v === 'string') {
          const parts = v.split(':');
          if (parts.length >= 2 && (parts[0].startsWith('/') || parts[0].startsWith('.') || parts[0].startsWith('~'))) {
            errors.push(issue('E-BIND-MOUNT', 'error', `${path}.volumes`, 'solohost.lint.bind_mount', {
              service: name, volume: v,
            }));
          }
        } else if (v && typeof v === 'object' && (v.type === 'bind' || v.bind)) {
          errors.push(issue('E-BIND-MOUNT', 'error', `${path}.volumes`, 'solohost.lint.bind_mount', {
            service: name, volume: JSON.stringify(v).slice(0, 120),
          }));
        }
      }

      const labels = svc.labels || {};
      const isPrimary = labels['pi.ui.primary'] === true || labels['pi.ui.primary'] === 'true';
      if (isPrimary) primaryCount += 1;

      const ports = Array.isArray(svc.ports) ? svc.ports : [];
      if (isPrimary) {
        const loopback = [];
        for (const p of ports) {
          const s = typeof p === 'string' ? p : (p?.published != null ? `127.0.0.1:${p.published}:${p.target || ''}` : JSON.stringify(p));
          const m = String(s).match(/127\.0\.0\.1:(\d+):(\d+)/);
          if (m) loopback.push({ host: Number(m[1]), container: Number(m[2]), raw: s });
        }
        if (loopback.length !== 1 || ports.length !== 1) {
          warnings.push(issue('W-PRIMARY-PORT', 'warning', `${path}.ports`, 'solohost.lint.primary_port', {
            service: name, count: ports.length, loopback: loopback.length,
          }, { action: 'force_loopback_port', service: name }));
        } else {
          const { host, container } = loopback[0];
          // Official openclaw uses equal host/container — warning only, never error
          if (host === container || COMMON_HOST_PORTS.has(host)) {
            warnings.push(issue('W-PRIMARY-PORT-VALUE', 'warning', `${path}.ports`, 'solohost.lint.primary_port_value', {
              service: name, host, container,
            }));
          }
        }
      }

      const cmd = svc.command;
      if (typeof cmd === 'string' && /\$[A-Za-z_]/.test(cmd) && !/\$\$/.test(cmd) && !/\$\{/.test(cmd)) {
        warnings.push(issue('W-CMD-SHELL-VAR', 'warning', `${path}.command`, 'solohost.lint.cmd_shell_var', {
          service: name,
        }));
      }
    }
    if (primaryCount !== 1) {
      warnings.push(issue('W-PRIMARY-COUNT', 'warning', 'services', 'solohost.lint.primary_count', {
        count: primaryCount,
      }, { action: 'set_one_primary' }));
    }
  }

  if (compose.volumes && typeof compose.volumes === 'object') {
    for (const [vn, vdef] of Object.entries(compose.volumes)) {
      if (vdef && typeof vdef === 'object' && (vdef.driver_opts?.device || vdef.type === 'bind')) {
        errors.push(issue('E-VOLUME-BIND', 'error', `volumes.${vn}`, 'solohost.lint.volume_bind', { volume: vn }));
      }
    }
  }
  if (compose.networks && typeof compose.networks === 'object') {
    for (const [nn, ndef] of Object.entries(compose.networks)) {
      if (ndef && typeof ndef === 'object' && ndef.driver === 'host') {
        errors.push(issue('E-NET-HOST-DRIVER', 'error', `networks.${nn}`, 'solohost.lint.net_host_driver', { network: nn }));
      }
    }
  }
  for (const kind of ['secrets', 'configs']) {
    if (compose[kind] && typeof compose[kind] === 'object') {
      for (const [sn, sdef] of Object.entries(compose[kind])) {
        if (sdef && typeof sdef === 'object' && sdef.file) {
          errors.push(issue('E-FILE-SECRET', 'error', `${kind}.${sn}`, 'solohost.lint.file_secret', { kind, name: sn }));
        }
      }
    }
  }

  // --- config_options ---
  if (config && typeof config === 'object') {
    for (const k of Object.keys(config)) {
      if (!ALLOWED_CONFIG_KEYS.has(k)) {
        errors.push(issue('E-CONFIG-KEY', 'error', k, 'solohost.lint.config_unknown_key', { key: k }));
      }
    }

    const fields = Array.isArray(config.fields) ? config.fields : [];
    const fieldNameSet = new Set(fields.map((f) => f?.name).filter(Boolean));

    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      if (!f || typeof f !== 'object') continue;
      const path = `fields[${i}]`;
      if (f.type && !ALLOWED_FIELD_TYPES.has(f.type)) {
        errors.push(issue('E-FIELD-TYPE', 'error', path, 'solohost.lint.field_type', { name: f.name, type: f.type }));
      }
      if (f.placeholder != null) {
        errors.push(issue('E-FIELD-PLACEHOLDER', 'error', path, 'solohost.lint.field_placeholder', { name: f.name }));
      }
      if (f.min != null || f.max != null) {
        errors.push(issue('E-FIELD-MINMAX', 'error', path, 'solohost.lint.field_minmax', { name: f.name }));
      }
      if (f.default != null && typeof f.default !== 'string' && typeof f.default !== 'number') {
        // SoloHost wants string defaults; number type may still use string "30"
        if (typeof f.default !== 'string') {
          errors.push(issue('E-FIELD-DEFAULT-TYPE', 'error', path, 'solohost.lint.field_default_type', {
            name: f.name, type: typeof f.default,
          }));
        }
      }
      if (f.type === 'select' && !Array.isArray(f.options)) {
        errors.push(issue('E-SELECT-OPTIONS', 'error', path, 'solohost.lint.select_options', { name: f.name }));
      }
      if (f.type === 'password' && f.preserve_if_blank !== true) {
        warnings.push(issue('W-PASSWORD-PRESERVE', 'warning', path, 'solohost.lint.password_preserve', {
          name: f.name,
        }, { action: 'set_preserve_if_blank', name: f.name }));
      }

      // visible_if must be object { field, in: [...] }
      if (f.visible_if != null) {
        const vi = f.visible_if;
        if (typeof vi !== 'object' || Array.isArray(vi) || !vi.field) {
          errors.push(issue('E-VISIBLE-IF-SHAPE', 'error', path, 'solohost.lint.visible_if_shape', {
            name: f.name,
          }));
        } else {
          if (!fieldNameSet.has(String(vi.field))) {
            errors.push(issue('E-VISIBLE-IF', 'error', path, 'solohost.lint.visible_if_missing', {
              name: f.name, ref: vi.field,
            }));
          }
          if (!Array.isArray(vi.in) || vi.in.length === 0) {
            errors.push(issue('E-VISIBLE-IF-IN', 'error', path, 'solohost.lint.visible_if_in', {
              name: f.name,
            }));
          }
        }
      }
    }

    for (const fv of (Array.isArray(config.fixed_values) ? config.fixed_values : [])) {
      if (!fv?.name) continue;
      if (fv.detect != null && !ALLOWED_DETECT.has(fv.detect)) {
        errors.push(issue('E-FIXED-DETECT', 'error', `fixed_values.${fv.name}`, 'solohost.lint.fixed_detect', {
          name: fv.name, detect: fv.detect,
        }));
      }
      if (fv.detect == null && fv.value == null) {
        errors.push(issue('E-FIXED-EMPTY', 'error', `fixed_values.${fv.name}`, 'solohost.lint.fixed_empty', {
          name: fv.name,
        }));
      }
      if (SECRET_NAME.test(fv.name) && fv.value != null && String(fv.value).length > 0) {
        errors.push(issue('E-FIXED-SECRET', 'error', `fixed_values.${fv.name}`, 'solohost.lint.fixed_secret', {
          name: fv.name,
        }));
      }
    }
  }

  // Cross-file: ${VAR} from parsed compose only
  const defaultsMap = new Map();
  const composeVars = collectEnvVarsFromValue(compose, new Set(), defaultsMap);
  const declared = declaredNames(config);
  const setOnly = setOnlyKeys(config);

  for (const v of composeVars) {
    if (declared.has(v)) continue;
    if (setOnly.has(v)) {
      errors.push(issue('E-SET-ONLY-VAR-USED', 'error', 'docker-compose.yml', 'solohost.lint.set_only_var', {
        var: v,
      }, { action: 'add_hidden_field', name: v }));
      continue;
    }
    errors.push(issue('E-UNDECLARED-VAR', 'error', 'docker-compose.yml', 'solohost.lint.undeclared_var', {
      var: v,
    }, { action: 'add_field', name: v }));
  }

  for (const [vn, def] of defaultsMap) {
    if (String(def).includes(':')) {
      warnings.push(issue('W-DEFAULT-COLON', 'warning', 'docker-compose.yml', 'solohost.lint.default_colon', {
        var: vn, default: def,
      }));
    }
  }

  // Unused fields (not in compose) — warning only
  for (const name of declared) {
    if (!composeVars.has(name) && name !== 'SOLOHOST_PROFILE') {
      warnings.push(issue('W-UNUSED-FIELD', 'warning', `fields.${name}`, 'solohost.lint.unused_field', { name }));
    }
  }

  const hasNamedVolume = compose.volumes && typeof compose.volumes === 'object' && Object.keys(compose.volumes).length > 0;
  const omitsSomething = policy && (policy.mode === 'defaults' || policy.mode === 'auth'
    || (policy.fields && Object.values(policy.fields).includes('omit')));
  if (omitsSomething && !hasNamedVolume) {
    errors.push(issue('E-OMIT-NEEDS-VOLUME', 'error', 'volumes', 'solohost.lint.omit_needs_volume', {}));
  } else if (!hasNamedVolume && services) {
    warnings.push(issue('W-NO-VOLUME', 'warning', 'volumes', 'solohost.lint.no_volume', {}));
  }

  return { errors, warnings };
}

export function formatLintMessage(item, t = (k) => k) {
  try {
    return t(item.messageKey, item.params || {});
  } catch {
    return `${item.rule}: ${item.path}`;
  }
}

export default { lintPackage, formatLintMessage };
