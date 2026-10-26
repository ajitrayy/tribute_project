import { getDb, now } from './db.js';

const SECRET_PATTERN = /(access_token|appsecret_proof|client_secret)=([^&\s"]+)/gi;

/** Strip tokens from anything that might end up in logs or the dashboard. */
export function redact(text) {
  if (text == null) return text;
  return String(text).replace(SECRET_PATTERN, '$1=[redacted]');
}

function write(level, scope, message, { pageId = null, postId = null, detail = null } = {}) {
  const msg = redact(message);
  let det = detail;
  if (det instanceof Error) det = det.stack || det.message;
  else if (det && typeof det === 'object') det = JSON.stringify(det);
  if (det === '{}') det = null;
  det = redact(det);
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${scope}: ${msg}`;
  (level === 'error' ? console.error : console.log)(det && level !== 'info' ? `${line}\n  ${det}` : line);
  try {
    getDb()
      .prepare('INSERT INTO logs (ts, level, scope, page_id, post_id, message, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(now(), level, scope, pageId, postId, msg, det);
  } catch (e) {
    console.error('failed to persist log', e.message);
  }
}

export const log = {
  info: (scope, message, meta) => write('info', scope, message, meta),
  warn: (scope, message, meta) => write('warn', scope, message, meta),
  error: (scope, message, meta) => write('error', scope, message, meta),
};
