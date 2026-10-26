import { getDb, now } from './db.js';

export const STATUSES = {
  queued: 'Waiting to be processed',
  processing: 'Downloading / extracting / rendering',
  needs_input: 'Text extraction unavailable - enter the poster text manually',
  ready: 'Generated - awaiting review',
  approved: 'Approved',
  duplicate: 'Duplicate of an earlier poster',
  skipped: 'Not an image news poster',
  baseline: 'Published before monitoring started',
  failed: 'Processing failed after retries',
};

const JSON_COLS = ['extraction_json', 'fields_json', 'fact_check_json'];

export function hydrate(row) {
  if (!row) return row;
  const out = { ...row };
  for (const c of JSON_COLS) {
    const key = c.replace(/_json$/, '');
    out[key] = row[c] ? JSON.parse(row[c]) : null;
    delete out[c];
  }
  return out;
}

export function getPost(id) {
  return hydrate(
    getDb()
      .prepare('SELECT posts.*, pages.name AS page_name, pages.url AS page_url FROM posts LEFT JOIN pages ON pages.id = posts.page_id WHERE posts.id = ?')
      .get(id),
  );
}

export function postBySourceKey(key) {
  return getDb().prepare('SELECT id, status FROM posts WHERE source_key = ?').get(key);
}

/** Insert a post unless its source_key already exists. Returns { id, created }. */
export function insertPost(p) {
  const d = getDb();
  const ts = now();
  const r = d
    .prepare(
      `INSERT INTO posts (page_id, source, fb_post_id, image_index, source_key, source_url, image_url, fb_photo_id,
         caption, posted_at, discovered_at, status, status_reason, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_key) DO NOTHING`,
    )
    .run(
      p.pageId ?? null, p.source || 'facebook', p.fbPostId ?? null, p.imageIndex ?? 0, p.sourceKey, p.sourceUrl ?? null,
      p.imageUrl ?? null, p.photoId ?? null, p.caption ?? null, p.postedAt ?? null, ts, p.status, p.statusReason ?? null, ts,
    );
  if (r.changes === 0) return { id: postBySourceKey(p.sourceKey).id, created: false };
  return { id: Number(r.lastInsertRowid), created: true };
}

const UPDATABLE = new Set([
  'status', 'status_reason', 'source_image_path', 'image_hash', 'duplicate_of', 'image_url',
  'extraction', 'fields', 'fact_check', 'approved_at', 'approved_by',
]);

export function updatePost(id, patch) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!UPDATABLE.has(k)) throw new Error(`cannot update post.${k}`);
    const col = ['extraction', 'fields', 'fact_check'].includes(k) ? `${k}_json` : k;
    sets.push(`${col} = ?`);
    vals.push(col.endsWith('_json') ? (v == null ? null : JSON.stringify(v)) : v);
  }
  sets.push('updated_at = ?');
  vals.push(now(), id);
  getDb().prepare(`UPDATE posts SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

export function listPosts({ status, pageId, limit = 60, offset = 0, q } = {}) {
  const where = [];
  const vals = [];
  if (status) {
    const list = String(status).split(',');
    where.push(`posts.status IN (${list.map(() => '?').join(',')})`);
    vals.push(...list);
  }
  if (pageId) {
    where.push('posts.page_id = ?');
    vals.push(pageId);
  }
  if (q) {
    where.push('(posts.caption LIKE ? OR posts.fields_json LIKE ?)');
    vals.push(`%${q}%`, `%${q}%`);
  }
  const sql = `SELECT posts.*, pages.name AS page_name,
      (SELECT path FROM renders WHERE renders.post_id = posts.id ORDER BY version DESC LIMIT 1) AS latest_render_path
    FROM posts LEFT JOIN pages ON pages.id = posts.page_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY COALESCE(posts.posted_at, posts.discovered_at) DESC, posts.id DESC LIMIT ? OFFSET ?`;
  const rows = getDb().prepare(sql).all(...vals, limit, offset).map(hydrate);
  const total = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM posts ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`)
    .get(...vals).n;
  return { rows, total };
}

export function rendersFor(postId) {
  return getDb().prepare('SELECT * FROM renders WHERE post_id = ? ORDER BY version DESC').all(postId);
}

export function latestRender(postId) {
  return getDb().prepare('SELECT * FROM renders WHERE post_id = ? ORDER BY version DESC LIMIT 1').get(postId);
}

export function addRender(postId, r) {
  const d = getDb();
  const v = (d.prepare('SELECT MAX(version) AS v FROM renders WHERE post_id = ?').get(postId).v || 0) + 1;
  d.prepare(
    'INSERT INTO renders (post_id, version, path, template_id, placeholder, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(postId, v, r.path, r.templateId, r.placeholder ? 1 : 0, r.width ?? null, r.height ?? null, now());
  return v;
}

/** Earlier non-duplicate post whose image hash is within `threshold` bits. */
export function findNearDuplicate(postId, hash, { threshold, windowDays, hamming }) {
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const rows = getDb()
    .prepare(
      `SELECT id, image_hash FROM posts WHERE id != ? AND image_hash IS NOT NULL AND discovered_at >= ?
         AND status NOT IN ('duplicate','failed') ORDER BY id`,
    )
    .all(postId, since);
  for (const r of rows) {
    if (r.id < postId && hamming(r.image_hash, hash) <= threshold) return r.id;
  }
  return null;
}
