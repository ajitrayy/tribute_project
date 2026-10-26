import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

function int(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be an integer, got "${v}"`);
  return n;
}

function json(name, fallback) {
  const v = process.env[name];
  if (!v) return fallback;
  try {
    return JSON.parse(v);
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
}

const dataDir = path.resolve(ROOT, process.env.DATA_DIR || 'data');

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: int('PORT', 3000),
  dataDir,
  dbPath: path.join(dataDir, 'app.db'),
  mediaDir: path.join(dataDir, 'media'),
  assetsDir: path.join(dataDir, 'assets'),
  templatesDir: path.resolve(ROOT, process.env.TEMPLATES_DIR || 'templates'),

  admin: {
    user: process.env.ADMIN_USER || 'admin',
    password: process.env.ADMIN_PASSWORD || '',
  },

  facebook: {
    graphVersion: process.env.FB_GRAPH_VERSION || 'v23.0',
    graphBase: process.env.FB_GRAPH_BASE || 'https://graph.facebook.com',
    appId: process.env.FB_APP_ID || '',
    appSecret: process.env.FB_APP_SECRET || '',
    // System-user or long-lived user token. Used to list the Pages this
    // business manages (/me/accounts) and, with PPCA, to read public Pages.
    userToken: process.env.FB_USER_ACCESS_TOKEN || '',
    // Optional explicit map of { "<page id or username>": "<page access token>" }.
    pageTokens: json('FB_PAGE_ACCESS_TOKENS', {}),
    // Set to true only once the app has been approved for Page Public Content Access.
    usePublicContentAccess: process.env.FB_PPCA_APPROVED === 'true',
    postsPerPoll: int('FB_POSTS_PER_POLL', 25),
  },

  extraction: {
    // "anthropic" (vision model) or "manual" (editor fills in the text).
    provider: process.env.EXTRACTION_PROVIDER || (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'manual'),
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-5-5',
    effort: process.env.EXTRACTION_EFFORT || 'medium',
  },

  worker: {
    tickMs: int('WORKER_TICK_MS', 5000),
    jobMaxAttempts: int('JOB_MAX_ATTEMPTS', 5),
    jobBackoffBaseSec: int('JOB_BACKOFF_BASE_SEC', 30),
    staleLockMin: int('JOB_STALE_LOCK_MIN', 10),
    duplicateHammingThreshold: int('DUPLICATE_HAMMING_THRESHOLD', 6),
    duplicateWindowDays: int('DUPLICATE_WINDOW_DAYS', 14),
  },

  defaults: {
    pollIntervalMinutes: int('DEFAULT_POLL_INTERVAL_MINUTES', 10),
  },

  maxImageBytes: int('MAX_IMAGE_BYTES', 15 * 1024 * 1024),
};

export function assertProductionConfig() {
  if (config.env === 'production' && !config.admin.password) {
    throw new Error('ADMIN_PASSWORD must be set in production.');
  }
}
