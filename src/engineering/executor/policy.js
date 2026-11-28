/**
 * Engineering Toolkit executor policy (v1.10.0, D-02).
 *
 * Structured NAMED commands replace the old string-token filter:
 *   npm.ci · npm.install · npm.lockfile · npm.test · npm.build · npm.run(script) · npm.start
 *   node.check(<file>) · node.test(<files>) · node.start(<file>)
 * Everything else is rejected: node -e/-p/--eval/--print/-r/--require/--import/--input-type/
 * --experimental-*, absolute or ".." file arguments, --prefix/-g/--global/--userconfig,
 * package specs on npm install, and unknown binaries. Models never execute anything; this
 * module only decides whether a host-owned workflow may run a command.
 */
import fs from 'node:fs';
import path from 'node:path';

export const NAMED_COMMANDS = Object.freeze({
  'npm.ci': { network: true, nodeEnv: 'development', heavy: true },
  'npm.install': { network: true, nodeEnv: 'development', heavy: true },
  'npm.lockfile': { network: true, nodeEnv: 'development', heavy: true },
  'npm.test': { network: false, nodeEnv: 'development', heavy: true },
  'npm.build': { network: false, nodeEnv: 'development', heavy: true },
  'npm.run': { network: false, nodeEnv: 'development', heavy: true },
  'npm.start': { network: false, nodeEnv: 'production', heavy: false },
  'node.check': { network: false, nodeEnv: 'development', heavy: false },
  'node.test': { network: false, nodeEnv: 'development', heavy: true },
  'node.start': { network: false, nodeEnv: 'production', heavy: false },
});

/** Back-compat export (old shape); informational only. */
export const ALLOWED_COMMANDS = Object.freeze({
  npm: { subcommands: ['install', 'ci', 'test', 'run', 'start'], maxArgs: 12 },
  node: { subcommands: ['--check', '--test'], maxArgs: 12 },
});

const INSTALL_FLAGS = new Set(['--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', '--offline', '--omit=dev', '--include=dev', '--no-save', '--package-lock-only', '--legacy-peer-deps', '--no-package-lock']);
const FORCED_INSTALL_FLAGS = ['--ignore-scripts', '--no-audit', '--no-fund'];
const SAFE_PASSTHROUGH = /^--[a-z][a-z0-9-]*(=[A-Za-z0-9._:,-]+)?$/;
const FORBIDDEN_ARG = /^(-g|--global|--prefix(=.*)?|--userconfig(=.*)?|--globalconfig(=.*)?|--cache(=.*)?|--registry(=.*)?|--location(=.*)?|--workspaces?(=.*)?|-w|--script-shell(=.*)?|--node-options(=.*)?)$/i;
const NODE_FORBIDDEN = /^(-e|-p|--eval|--print|-r|--require|--import|--loader|--experimental-loader|--input-type|-i|--interactive|--inspect.*|--experimental-.*|--allow-.*|--no-experimental-.*|--env-file.*|-c)$/i;

/** Script bodies that may reach the network, escalate privileges, execute inline node, or leave the project. */
const SCRIPT_DENY = [
  /\b(curl|wget|nc|ncat|netcat|ssh|scp|rsync|ftp|telnet)\b/i,
  /\b(sudo|doas|su\s+-|chown|chmod\s+[0-7]*[67]|mkfs|mount|umount|reboot|shutdown|systemctl)\b/i,
  /\b(docker|podman|kubectl)\b/i,
  /\brm\s+-[a-z]*r[a-z]*f?\s+\/(\s|$)/i,
  /(^|[\s"'=])\/(?:etc|root|app|var|home|opt|usr|proc|sys|tmp)(?:\/|$|\s|["'])/i,
  /~\/\.ssh|\$HOME\/\.ssh|\/var\/run\/docker\.sock/i,
  /\beval\b|\bbase64\s+(-d|--decode)\b|\|\s*(sh|bash|zsh)\b|`[^`]*`|\$\(/i,
  /\bnpm\s+(publish|login|adduser|token|config\s+set)\b/i,
  /\bnpx\b/i,
  /(?:^|[\s;|&])node\s+(?:[^\n;|&]*\s)?(?:--eval\b|--print\b|--require\b|--import\b|--input-type\b|--loader\b|--experimental-loader\b|--inspect\S*|-[a-zA-Z]*[epr])/,
];

export function scriptBodyAllowed(body) {
  const s = String(body || '');
  if (!s.trim()) return { ok: false, reason: 'empty script' };
  for (const re of SCRIPT_DENY) if (re.test(s)) return { ok: false, reason: `script body denied by policy (${re.source.slice(0, 40)})` };
  return { ok: true };
}

function insideRoot(root, rel) {
  if (!rel || typeof rel !== 'string') return false;
  if (path.isAbsolute(rel) || rel.includes('\0')) return false;
  const norm = path.normalize(rel).replace(/\\/g, '/');
  if (norm === '..' || norm.startsWith('../') || norm.includes('/../')) return false;
  if (!root) return true;
  const abs = path.resolve(root, norm);
  const r = path.resolve(root);
  return abs === r || abs.startsWith(r + path.sep);
}

function readPkg(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { return null; }
}

function rejectBadArgs(args) {
  for (const a of args) {
    if (typeof a !== 'string') return 'non-string argument';
    if (FORBIDDEN_ARG.test(a)) return `argument not allowed: ${a}`;
    if (path.isAbsolute(a)) return `absolute path not allowed: ${a}`;
    if (/(^|[\\/])\.\.([\\/]|$)/.test(a)) return `parent path not allowed: ${a}`;
  }
  return null;
}

/**
 * Resolve a named command into a concrete argv. Returns { ok, argv, name, nodeEnv, network, reason }.
 * `projectRoot` is required for anything that reads package.json or files.
 */
export function resolveNamedCommand(name, args = [], { projectRoot } = {}) {
  const spec = NAMED_COMMANDS[name];
  if (!spec) return { ok: false, reason: `unknown named command: ${name}` };
  if (!Array.isArray(args)) return { ok: false, reason: 'args must be an array' };
  const bad = rejectBadArgs(args);
  if (bad) return { ok: false, reason: bad };
  const out = (argv) => ({ ok: true, name, argv, nodeEnv: spec.nodeEnv, network: spec.network, heavy: spec.heavy });
  const pkg = projectRoot ? readPkg(projectRoot) : null;
  const scriptCheck = (script) => {
    if (!pkg) return { ok: false, reason: 'package.json missing or invalid' };
    const body = pkg.scripts?.[script];
    if (!body) return { ok: false, reason: `script "${script}" not defined in package.json` };
    return scriptBodyAllowed(body);
  };

  switch (name) {
    case 'npm.ci':
    case 'npm.install':
    case 'npm.lockfile': {
      for (const a of args) if (!INSTALL_FLAGS.has(a)) return { ok: false, reason: `install flag not allowed (package specs are forbidden): ${a}` };
      const flags = [...new Set([...FORCED_INSTALL_FLAGS, ...(name === 'npm.lockfile' ? ['--package-lock-only'] : []), ...args])];
      return out(['npm', name === 'npm.ci' ? 'ci' : 'install', ...flags]);
    }
    case 'npm.test': {
      for (const a of args) if (!SAFE_PASSTHROUGH.test(a)) return { ok: false, reason: `test argument not allowed: ${a}` };
      const c = scriptCheck('test');
      if (!c.ok) return c;
      return out(['npm', 'test', ...(args.length ? ['--', ...args] : [])]);
    }
    case 'npm.build': {
      if (args.length) return { ok: false, reason: 'npm.build takes no arguments' };
      const c = scriptCheck('build');
      if (!c.ok) return c;
      return out(['npm', 'run', 'build']);
    }
    case 'npm.start': {
      if (args.length) return { ok: false, reason: 'npm.start takes no arguments' };
      const c = scriptCheck('start');
      if (!c.ok) return c;
      return out(['npm', 'start']);
    }
    case 'npm.run': {
      const [script, ...rest] = args;
      if (!script || !/^[A-Za-z0-9:_.-]{1,64}$/.test(script)) return { ok: false, reason: 'invalid script name' };
      if (rest.length) return { ok: false, reason: 'npm.run passes no extra arguments' };
      const c = scriptCheck(script);
      if (!c.ok) return c;
      return out(['npm', 'run', script]);
    }
    case 'node.check':
    case 'node.start': {
      if (args.length !== 1) return { ok: false, reason: `${name} takes exactly one relative file` };
      const f = args[0];
      if (NODE_FORBIDDEN.test(f) || f.startsWith('-')) return { ok: false, reason: `node flag not allowed: ${f}` };
      if (!insideRoot(projectRoot, f)) return { ok: false, reason: `file outside project: ${f}` };
      if (!/\.(c|m)?js$/.test(f)) return { ok: false, reason: 'only .js/.mjs/.cjs files' };
      if (projectRoot && !fs.existsSync(path.join(projectRoot, f))) return { ok: false, reason: `file not found: ${f}` };
      return out(name === 'node.check' ? ['node', '--check', f] : ['node', f]);
    }
    case 'node.test': {
      if (!args.length || args.length > 40) return { ok: false, reason: 'node.test needs 1-40 relative files' };
      for (const f of args) {
        if (NODE_FORBIDDEN.test(f) || f.startsWith('-')) return { ok: false, reason: `node flag not allowed: ${f}` };
        if (!insideRoot(projectRoot, f)) return { ok: false, reason: `file outside project: ${f}` };
      }
      return out(['node', '--test', ...args]);
    }
    default:
      return { ok: false, reason: `unknown named command: ${name}` };
  }
}

/** Map a raw argv (legacy callers) onto a named command; anything unmapped is rejected. */
export function parseArgv(argv = []) {
  if (!Array.isArray(argv) || !argv.length) return { ok: false, reason: 'empty command' };
  if (argv.some((a) => typeof a !== 'string')) return { ok: false, reason: 'non-string argv' };
  const bin = argv[0].replace(/^.*[\\/]/, '');
  const [, sub, ...rest] = argv;
  if (bin === 'npm') {
    if (sub === 'ci') return { ok: true, name: 'npm.ci', args: rest };
    if (sub === 'install' || sub === 'i') {
      if (rest.includes('--package-lock-only')) return { ok: true, name: 'npm.lockfile', args: rest.filter((a) => a !== '--package-lock-only') };
      return { ok: true, name: 'npm.install', args: rest };
    }
    if (sub === 'test' || sub === 't') {
      const i = rest.indexOf('--');
      if (i > 0) return { ok: false, reason: 'npm test arguments must follow --' };
      return { ok: true, name: 'npm.test', args: i === 0 ? rest.slice(1) : rest };
    }
    if (sub === 'start') return { ok: true, name: 'npm.start', args: rest };
    if (sub === 'run' || sub === 'run-script') {
      if (rest[0] === 'build' && rest.length === 1) return { ok: true, name: 'npm.build', args: [] };
      return { ok: true, name: 'npm.run', args: rest };
    }
    return { ok: false, reason: `npm subcommand not allowed: ${sub || '(none)'}` };
  }
  if (bin === 'node' || argv[0] === process.execPath) {
    if (sub === '--check') return { ok: true, name: 'node.check', args: rest };
    if (sub === '--test') return { ok: true, name: 'node.test', args: rest };
    if (sub && !sub.startsWith('-') && !rest.length) return { ok: true, name: 'node.start', args: [sub] };
    return { ok: false, reason: `node invocation not allowed: ${[sub, ...rest].join(' ').slice(0, 80)}` };
  }
  return { ok: false, reason: `command not allowlisted: ${bin}` };
}

/** Back-compat validator used by older callers/tests. */
export function validateCommand(argv = [], { cwd, projectRoot } = {}) {
  const parsed = parseArgv(argv);
  if (!parsed.ok) return parsed;
  const root = projectRoot || cwd || null;
  if (projectRoot && cwd) {
    const resolved = path.resolve(cwd);
    const r = path.resolve(projectRoot);
    if (resolved !== r && !resolved.startsWith(r + path.sep)) return { ok: false, reason: 'cwd outside project root' };
  }
  // Without a project root we can only check structure (script existence is checked at run time).
  if (!root) {
    const bad = rejectBadArgs(parsed.args);
    if (bad) return { ok: false, reason: bad };
    if (parsed.name === 'npm.install' && parsed.args.some((a) => !a.startsWith('-'))) return { ok: false, reason: 'npm install of named packages is not allowed (install from package.json only)' };
    if ((parsed.name === 'node.check' || parsed.name === 'node.start' || parsed.name === 'node.test')) {
      for (const f of parsed.args) if (NODE_FORBIDDEN.test(f) || f.startsWith('-') || !insideRoot(null, f)) return { ok: false, reason: `node argument not allowed: ${f}` };
    }
    return { ok: true, name: parsed.name };
  }
  const r = resolveNamedCommand(parsed.name, parsed.args, { projectRoot: root });
  if (r.ok) return { ok: true, name: r.name, argv: r.argv };
  // No package.json yet: structure is valid; script existence/body is re-checked when the command runs.
  if (/package\.json missing/.test(r.reason || '') && !rejectBadArgs(parsed.args)) return { ok: true, name: parsed.name, deferred: true };
  return r;
}

const ENV_DENY = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|PAT|CREDENTIAL|AUTH|COOKIE|SESSION|DATABASE_URL|DSN|PRIVATE)/i;
const PASSTHROUGH_ENV = ['LANG', 'LC_ALL', 'TZ', 'npm_config_offline', 'npm_config_prefer_offline', 'npm_config_registry', 'NPM_CONFIG_REGISTRY', 'npm_config_strict_ssl', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];

export function extraEnvAllowed(key, value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(String(key))) return false;
  if (ENV_DENY.test(key)) return false;
  if (/^(PATH|HOME|NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|npm_config_.*)$/i.test(key)) return false;
  if (String(value ?? '').length > 4096) return false;
  return true;
}

/**
 * Build the child env from an EMPTY object + allowlist. Never copies the parent env.
 */
export function buildChildEnv({ nodeEnv = 'development', homeDir, cacheDir, port = null, extraEnv = {}, parentEnv = process.env } = {}) {
  const env = {
    PATH: parentEnv.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: homeDir || '/tmp',
    CI: '1',
    NODE_ENV: nodeEnv,
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
  };
  if (cacheDir) env.npm_config_cache = cacheDir;
  for (const k of PASSTHROUGH_ENV) {
    const v = parentEnv[k];
    if (v == null || v === '') continue;
    if (/proxy/i.test(k) && /@/.test(v)) continue; // proxy URL with credentials is never forwarded
    if (/registry/i.test(k) && /@|_auth|token/i.test(v)) continue;
    env[k] = v;
  }
  if (port != null) env.PORT = String(port);
  for (const [k, v] of Object.entries(extraEnv || {})) {
    if (extraEnvAllowed(k, v)) env[k] = String(v);
  }
  return env;
}

/** @deprecated kept for older imports — now delegates to the allowlist builder. */
/**
 * Legacy helper (v1.9.x contract): copy of an env object with secret-like and loader-hijacking keys removed.
 * The executor itself never uses this — it builds the child env from an empty object (buildChildEnv).
 */
export function sanitizeEnv(baseEnv = process.env, extra = {}) {
  const out = {};
  for (const [k, v] of Object.entries({ ...(baseEnv || {}), ...(extra || {}) })) {
    if (v == null) continue;
    if (ENV_DENY.test(k)) continue;
    if (/^(NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*)$/i.test(k)) continue;
    out[k] = String(v);
  }
  return out;
}
