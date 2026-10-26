import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  url            TEXT NOT NULL UNIQUE,
  identifier     TEXT NOT NULL,          -- username or numeric id parsed from the URL
  fb_page_id     TEXT,                   -- resolved numeric Page id
  name           TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1,
  access_status  TEXT NOT NULL DEFAULT 'unchecked', -- unchecked | ok | no_access | token_error | error
  access_method  TEXT,                   -- page_token | user_token | app_token
  last_error     TEXT,
  monitor_since  TEXT NOT NULL,          -- ISO time; older posts are recorded as baseline, not processed
  last_polled_at TEXT,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id           INTEGER REFERENCES pages(id) ON DELETE SET NULL,
  source            TEXT NOT NULL DEFAULT 'facebook', -- facebook | manual
  fb_post_id        TEXT,
  image_index       INTEGER NOT NULL DEFAULT 0,
  source_key        TEXT NOT NULL UNIQUE,  -- dedupe key: "<fb_post_id>#<image_index>" or "manual:<uuid>"
  source_url        TEXT,
  image_url         TEXT,
  fb_photo_id       TEXT,
  caption           TEXT,
  posted_at         TEXT,
  discovered_at     TEXT NOT NULL,
  status            TEXT NOT NULL,         -- see STATUSES in posts.js
  status_reason     TEXT,
  source_image_path TEXT,
  image_hash        TEXT,
  duplicate_of      INTEGER REFERENCES posts(id) ON DELETE SET NULL,
  extraction_json   TEXT,
  fields_json       TEXT,
  fact_check_json   TEXT,
  approved_at       TEXT,
  approved_by       TEXT,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS posts_status ON posts(status);
CREATE INDEX IF NOT EXISTS posts_discovered ON posts(discovered_at);
CREATE INDEX IF NOT EXISTS posts_hash ON posts(image_hash);

CREATE TABLE IF NOT EXISTS renders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id     INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  path        TEXT NOT NULL,
  template_id TEXT NOT NULL,
  placeholder INTEGER NOT NULL,          -- 1 if rendered with a placeholder template or missing logo
  width       INTEGER,
  height      INTEGER,
  created_at  TEXT NOT NULL,
  UNIQUE (post_id, version)
);

CREATE TABLE IF NOT EXISTS jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  type         TEXT NOT NULL,            -- process | render
  post_id      INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  payload      TEXT,
  status       TEXT NOT NULL DEFAULT 'queued', -- queued | running | done | failed
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  run_after    TEXT NOT NULL,
  locked_at    TEXT,
  last_error   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(status, run_after);

CREATE TABLE IF NOT EXISTS logs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL,
  level   TEXT NOT NULL,
  scope   TEXT NOT NULL,
  page_id INTEGER,
  post_id INTEGER,
  message TEXT NOT NULL,
  detail  TEXT
);
CREATE INDEX IF NOT EXISTS logs_ts ON logs(ts);
`;

let db;

export function openDb(file = config.dbPath) {
  if (db) return db;
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export function getDb() {
  return db || openDb();
}

/** Test helper: drop the cached handle so a fresh database can be opened. */
export function closeDb() {
  if (db) db.close();
  db = undefined;
}

export const now = () => new Date().toISOString();

export function tx(fn) {
  const d = getDb();
  d.exec('BEGIN IMMEDIATE');
  try {
    const r = fn(d);
    d.exec('COMMIT');
    return r;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

// ---- settings ----

const SETTING_DEFAULTS = {
  poll_interval_minutes: String(config.defaults.pollIntervalMinutes),
  monitoring_paused: '0',
  poll_requested: '0',
  last_poll_at: '',
  active_template: 'placeholder',
  logo_path: '',
  logo_width: '',
  logo_height: '',
};

export function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : SETTING_DEFAULTS[key] ?? '';
}

export function setSetting(key, value) {
  getDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

export function allSettings() {
  const out = { ...SETTING_DEFAULTS };
  for (const r of getDb().prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}
