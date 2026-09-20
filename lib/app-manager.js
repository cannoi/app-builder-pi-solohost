'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const REGISTRY_FILE =
  process.env.SOLOHOST_REGISTRY_FILE ||
  path.join(__dirname, '..', 'data', 'apps.json');

const DEMO_APPS = [
  {
    id: 'calculator',
    name: 'Calculator',
    icon: 'calculator',
    route: '/apps/calculator',
    target: 'local://calculator',
    status: 'online',
    description: 'Quick numbers'
  },
  {
    id: 'music',
    name: 'Music',
    icon: 'music',
    route: '/apps/music',
    target: 'local://music',
    status: 'online',
    description: 'Listening room'
  },
  {
    id: 'ai',
    name: 'AI',
    icon: 'ai',
    route: '/apps/ai',
    target: 'local://ai',
    status: 'online',
    description: 'Local assistant'
  },
  {
    id: 'node',
    name: 'Node',
    icon: 'node',
    route: '/apps/node',
    target: 'local://node',
    status: 'starting',
    description: 'SoloHost node'
  }
];

function publicApp(app) {
  return {
    id: app.id,
    name: app.name,
    icon: app.icon || 'app',
    route: app.route || `/apps/${app.id}`,
    status: app.status || 'online',
    description: app.description || ''
  };
}

function readFileRegistry() {
  try {
    if (!fs.existsSync(REGISTRY_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.apps || [];
    return list
      .filter((a) => a && a.id && a.name)
      .map((a) => ({
        id: String(a.id),
        name: a.name,
        icon: a.icon || 'app',
        route: a.route || `/apps/${a.id}`,
        target: a.target || null,
        status: a.status || 'online',
        description: a.description || ''
      }));
  } catch (err) {
    console.warn('Registry file unreadable:', err.message);
    return [];
  }
}

function fetchJson(url, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.on('error', reject);
  });
}

async function fromAppManager() {
  const base = process.env.SOLOHOST_APP_MANAGER_URL;
  if (!base) return null;
  try {
    const data = await fetchJson(`${base.replace(/\/$/, '')}/api/apps`);
    const list = Array.isArray(data) ? data : data.apps || [];
    return list
      .filter((a) => a && (a.id || a.name) && a['solohost.app'] !== false)
      .map((a) => ({
        id: String(a.id || a['solohost.app.id'] || a.name).toLowerCase().replace(/\s+/g, '-'),
        name: a.name || a['solohost.app.name'] || a.id,
        icon: a.icon || a['solohost.app.icon'] || 'app',
        route: a.route || a['solohost.app.route'] || `/apps/${a.id}`,
        target: a.target || a.url || null,
        status: a.status || 'online',
        description: a.description || ''
      }));
  } catch (err) {
    console.warn('App Manager unreachable:', err.message);
    return null;
  }
}

function mergeApps(sources) {
  const map = new Map();
  for (const list of sources) {
    for (const app of list || []) {
      if (!app || !app.id) continue;
      map.set(app.id, { ...map.get(app.id), ...app });
    }
  }
  return Array.from(map.values());
}

let cache = { at: 0, apps: [], source: 'none', ok: true, error: null };

async function discover() {
  const now = Date.now();
  if (now - cache.at < 4000 && cache.apps) return cache;

  let source = 'empty';
  let ok = true;
  let error = null;
  let apps = [];

  try {
    const manager = await fromAppManager();
    const fileApps = readFileRegistry();

    if (manager && manager.length) {
      apps = mergeApps([manager, fileApps]);
      source = 'app-manager';
    } else if (fileApps.length) {
      apps = mergeApps([fileApps]);
      source = 'registry';
    } else if (process.env.SOLOHOST_DEMO_APPS !== '0') {
      apps = DEMO_APPS;
      source = 'demo';
    } else {
      apps = [];
      source = 'empty';
    }
  } catch (err) {
    ok = false;
    error = err.message;
    apps = cache.apps && cache.apps.length ? cache.apps : [];
  }

  cache = { at: now, apps, source, ok, error };
  return cache;
}

function getInternal(id) {
  return (cache.apps || []).find((a) => a.id === id) || null;
}

module.exports = {
  discover,
  publicApp,
  getInternal,
  DEMO_APPS
};
