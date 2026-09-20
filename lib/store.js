'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.SOLOHOST_DATA_DIR || path.join(__dirname, '..', 'data');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function jsonStore(filename) {
  ensureDir(DATA_DIR);
  const file = path.join(DATA_DIR, filename);
  const read = () => {
    try {
      if (!fs.existsSync(file)) return [];
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  const write = (rows) => {
    ensureDir(DATA_DIR);
    fs.writeFileSync(file, JSON.stringify(rows, null, 2));
  };
  return { file, read, write };
}

let sqliteDb = null;

function trySqlite() {
  if (sqliteDb !== null) return sqliteDb;
  try {
    const sqlite3 = require('sqlite3').verbose();
    ensureDir(DATA_DIR);
    const dbPath = path.join(DATA_DIR, 'solohost.db');
    const db = new sqlite3.Database(dbPath);
    db.serialize(() => {
      db.run(`CREATE TABLE IF NOT EXISTS bookmarks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )`);
      db.run(`CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        visited_at TEXT DEFAULT CURRENT_TIMESTAMP
      )`);
    });
    sqliteDb = db;
    return db;
  } catch (err) {
    console.warn('SQLite unavailable, using JSON store:', err.message);
    sqliteDb = false;
    return false;
  }
}

function promisifyDb(db, method, sql, params = []) {
  return new Promise((resolve, reject) => {
    db[method](sql, params, function onDone(err, rows) {
      if (err) reject(err);
      else resolve({ rows, lastID: this.lastID, changes: this.changes });
    });
  });
}

const bookmarksFile = jsonStore('bookmarks.json');
const historyFile = jsonStore('history.json');

async function listBookmarks() {
  const db = trySqlite();
  if (db) {
    const { rows } = await promisifyDb(db, 'all', 'SELECT id, title, url, created_at FROM bookmarks ORDER BY id DESC LIMIT 80');
    return rows || [];
  }
  return bookmarksFile.read().slice().reverse().slice(0, 80);
}

async function addBookmark(title, url) {
  const db = trySqlite();
  if (db) {
    const existing = await promisifyDb(db, 'get', 'SELECT id FROM bookmarks WHERE url = ?', [url]);
    if (existing.rows) return existing.rows;
    const result = await promisifyDb(db, 'run', 'INSERT INTO bookmarks (title, url) VALUES (?, ?)', [title, url]);
    return { id: result.lastID, title, url };
  }
  const rows = bookmarksFile.read();
  if (rows.some((r) => r.url === url)) return rows.find((r) => r.url === url);
  const row = { id: Date.now(), title, url, created_at: new Date().toISOString() };
  rows.push(row);
  bookmarksFile.write(rows);
  return row;
}

async function removeBookmark(id) {
  const db = trySqlite();
  if (db) {
    await promisifyDb(db, 'run', 'DELETE FROM bookmarks WHERE id = ?', [id]);
    return true;
  }
  bookmarksFile.write(bookmarksFile.read().filter((r) => String(r.id) !== String(id)));
  return true;
}

async function listHistory() {
  const db = trySqlite();
  if (db) {
    const { rows } = await promisifyDb(db, 'all', 'SELECT id, title, url, visited_at FROM history ORDER BY id DESC LIMIT 60');
    return rows || [];
  }
  return historyFile.read().slice().reverse().slice(0, 60);
}

async function addHistory(title, url) {
  const db = trySqlite();
  if (db) {
    await promisifyDb(db, 'run', 'INSERT INTO history (title, url) VALUES (?, ?)', [title, url]);
    await promisifyDb(db, 'run', `DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY id DESC LIMIT 200)`);
    return true;
  }
  const rows = historyFile.read();
  rows.push({ id: Date.now(), title, url, visited_at: new Date().toISOString() });
  historyFile.write(rows.slice(-200));
  return true;
}

module.exports = {
  listBookmarks,
  addBookmark,
  removeBookmark,
  listHistory,
  addHistory
};
