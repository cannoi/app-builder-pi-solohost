import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'factory.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return wrap(db);
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      idea TEXT NOT NULL,
      status TEXT NOT NULL,
      version TEXT NOT NULL DEFAULT '0.1.0',
      stack TEXT,
      manifest TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      stage TEXT,
      payload TEXT,
      result TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      stage TEXT,
      status TEXT,
      message TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      reason TEXT,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS builds (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      job_id TEXT,
      status TEXT NOT NULL,
      steps TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS test_results (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      job_id TEXT,
      status TEXT NOT NULL,
      report TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS releases (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      version TEXT NOT NULL,
      notes TEXT,
      github_url TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_requests (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      task TEXT,
      provider TEXT,
      model TEXT,
      success INTEGER,
      duration_ms INTEGER,
      tokens INTEGER,
      error TEXT,
      created_at TEXT NOT NULL
    );
  `);
}

function wrap(db) {
  const get = (sql, ...params) => db.prepare(sql).get(...params);
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const run = (sql, ...params) => db.prepare(sql).run(...params);

  return {
    raw: db,
    get,
    all,
    run,
    setting(key, fallback = null) {
      const row = get('SELECT value FROM settings WHERE key = ?', key);
      if (!row) return fallback;
      try { return JSON.parse(row.value); } catch { return row.value; }
    },
    setSetting(key, value) {
      run(
        'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        key,
        JSON.stringify(value),
      );
    },
    close() {
      db.close();
    },
  };
}
