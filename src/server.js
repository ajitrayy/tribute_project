import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { ROOT, config } from './config.js';
import { allSettings, getDb, getSetting, now, setSetting } from './db.js';
import { GraphClient } from './facebook/graph.js';
import { checkPageAccess } from './facebook/monitor.js';
import { PageUrlError, parsePageUrl } from './facebook/url.js';
import { enqueue, jobsForPost, queueStats } from './jobs.js';
import { log } from './logger.js';
import { STATUSES, getPost, insertPost, latestRender, listPosts, rendersFor, updatePost } from './posts.js';
import { EMPTY_FIELDS } from './pipeline/extract.js';
import { factCheck } from './pipeline/facts.js';
import { absMedia, cropPhotoFromSource, photoPathFor, removePhoto, savePhoto, saveSourceImage } from './pipeline/process.js';
import { listTemplates, loadTemplate } from './pipeline/template.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxImageBytes } });

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function basicAuth(req, res, next) {
  if (!config.admin.password) return next();
  const [scheme, value] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && value) {
    const [user, ...rest] = Buffer.from(value, 'base64').toString().split(':');
    const pass = rest.join(':');
    const eq = (a, b) => {
      const ha = crypto.createHash('sha256').update(a).digest();
      const hb = crypto.createHash('sha256').update(b).digest();
      return crypto.timingSafeEqual(ha, hb);
    };
    if (eq(user, config.admin.user) & eq(pass, config.admin.password)) {
      req.user = user;
      return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="IBN7 Poster Generator"').status(401).send('Authentication required');
}

function sanitizeFields(input) {
  const f = input || {};
  const s = (v, max) => String(v ?? '').replace(/\r/g, '').slice(0, max).trim();
  const lines = Array.isArray(f.body_lines) ? f.body_lines : String(f.body_lines || '').split('\n');
  return {
    category_label: s(f.category_label, 80),
    headline: s(f.headline, 400),
    subheadline: s(f.subheadline, 400),
    body_lines: lines.map((l) => s(l, 400)).filter(Boolean).slice(0, 12),
    location: s(f.location, 120),
    date_text: s(f.date_text, 120),
  };
}

function postDetail(id) {
  const post = getPost(id);
  if (!post) throw new HttpError(404, 'Post not found');
  const photo = photoPathFor(post.id);
  return {
    ...post,
    photo_url: photo ? `/media/${path.relative(config.mediaDir, photo)}?v=${fs.statSync(photo).mtimeMs}` : null,
    renders: rendersFor(id),
    jobs: jobsForPost(id),
  };
}

export function createApp({ graph = new GraphClient() } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.use(basicAuth);
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(ROOT, 'public')));
  app.use('/media', express.static(config.mediaDir, { fallthrough: false, dotfiles: 'deny' }));
  app.get('/templates/:id/reference/:file', (req, res, next) => {
    try {
      const t = loadTemplate(req.params.id);
      if (!t.references.includes(req.params.file)) throw new HttpError(404, 'Not found');
      res.sendFile(path.join(t.dir, 'reference', req.params.file));
    } catch (e) {
      next(e);
    }
  });

  // ---- status & monitoring controls ----
  app.get('/api/status', (_req, res) => {
    const s = allSettings();
    const fb = config.facebook;
    res.json({
      monitoring: {
        paused: s.monitoring_paused === '1',
        interval_minutes: Number(s.poll_interval_minutes),
        last_poll_at: s.last_poll_at || null,
        poll_requested: s.poll_requested === '1',
      },
      queue: queueStats(),
      counts: getDb().prepare('SELECT status, COUNT(*) AS n FROM posts GROUP BY status').all(),
      // Monitoring is only "verified" for a Page after a real post detected on it
      // was processed into a poster. Nothing else counts.
      verification: getDb()
        .prepare("SELECT COUNT(*) AS pages, SUM(verified_at IS NOT NULL) AS verified, SUM(access_status = 'ok') AS readable FROM pages WHERE enabled = 1")
        .get(),
      statuses: STATUSES,
      facebook: {
        graph_version: fb.graphVersion,
        has_app: Boolean(fb.appId && fb.appSecret),
        has_user_token: Boolean(fb.userToken),
        page_token_count: Object.keys(fb.pageTokens).length,
        ppca_enabled: fb.usePublicContentAccess,
      },
      extraction: { provider: config.extraction.provider, model: config.extraction.provider === 'anthropic' ? config.extraction.model : null },
      logo: s.logo_path ? { url: `/api/logo?v=${encodeURIComponent(s.logo_path)}`, width: Number(s.logo_width), height: Number(s.logo_height) } : null,
      active_template: s.active_template,
      templates: listTemplates(),
    });
  });

  app.post('/api/monitoring', (req, res) => {
    const { paused, interval_minutes: interval } = req.body || {};
    if (paused !== undefined) {
      setSetting('monitoring_paused', paused ? '1' : '0');
      log.info('monitor', paused ? 'monitoring paused' : 'monitoring resumed');
    }
    if (interval !== undefined) {
      const n = Number(interval);
      if (!Number.isFinite(n) || n < 1 || n > 1440) throw new HttpError(400, 'Interval must be between 1 and 1440 minutes.');
      setSetting('poll_interval_minutes', String(Math.round(n)));
    }
    res.json({ ok: true });
  });

  app.post('/api/monitoring/poll-now', (_req, res) => {
    setSetting('poll_requested', '1');
    res.json({ ok: true });
  });

  // ---- pages ----
  app.get('/api/pages', (_req, res) => {
    res.json(
      getDb()
        .prepare(
          `SELECT pages.*, (SELECT COUNT(*) FROM posts WHERE posts.page_id = pages.id AND posts.status NOT IN ('baseline','skipped')) AS poster_count
           FROM pages ORDER BY id`,
        )
        .all(),
    );
  });

  app.post('/api/pages', wrap(async (req, res) => {
    let parsed;
    try {
      parsed = parsePageUrl(req.body?.url);
    } catch (e) {
      if (e instanceof PageUrlError) throw new HttpError(400, e.message);
      throw e;
    }
    const backfillHours = Math.max(0, Math.min(72, Number(req.body?.backfill_hours) || 0));
    const monitorSince = new Date(Date.now() - backfillHours * 3600_000).toISOString();
    const d = getDb();
    if (d.prepare('SELECT id FROM pages WHERE url = ? OR identifier = ?').get(parsed.canonicalUrl, parsed.identifier)) {
      throw new HttpError(409, 'That Page is already configured.');
    }
    const r = d
      .prepare('INSERT INTO pages (url, identifier, monitor_since, created_at) VALUES (?, ?, ?, ?)')
      .run(parsed.canonicalUrl, parsed.identifier, monitorSince, now());
    const id = Number(r.lastInsertRowid);
    log.info('pages', `added ${parsed.canonicalUrl}`, { pageId: id });
    const page = d.prepare('SELECT * FROM pages WHERE id = ?').get(id);
    await checkPageAccess(graph, page).catch((e) => log.error('pages', `access check failed: ${e.message}`, { pageId: id, detail: e }));
    res.status(201).json(d.prepare('SELECT * FROM pages WHERE id = ?').get(id));
  }));

  app.post('/api/pages/:id/check', wrap(async (req, res) => {
    const d = getDb();
    const page = d.prepare('SELECT * FROM pages WHERE id = ?').get(req.params.id);
    if (!page) throw new HttpError(404, 'Page not found');
    graph.managedCache = null;
    await checkPageAccess(graph, page);
    res.json(d.prepare('SELECT * FROM pages WHERE id = ?').get(page.id));
  }));

  app.patch('/api/pages/:id', (req, res) => {
    const d = getDb();
    if (req.body?.enabled !== undefined) d.prepare('UPDATE pages SET enabled = ? WHERE id = ?').run(req.body.enabled ? 1 : 0, req.params.id);
    const page = d.prepare('SELECT * FROM pages WHERE id = ?').get(req.params.id);
    if (!page) throw new HttpError(404, 'Page not found');
    res.json(page);
  });

  app.delete('/api/pages/:id', (req, res) => {
    // Posts are kept for history; their page_id becomes NULL.
    getDb().prepare('DELETE FROM pages WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // ---- posts ----
  app.get('/api/posts', (req, res) => {
    const { status, page_id: pageId, q } = req.query;
    res.json(listPosts({
      status, pageId, q,
      limit: Math.min(200, Number(req.query.limit) || 60),
      offset: Number(req.query.offset) || 0,
    }));
  });

  app.get('/api/posts/:id', (req, res) => res.json(postDetail(req.params.id)));

  app.put('/api/posts/:id/fields', (req, res) => {
    const post = getPost(req.params.id);
    if (!post) throw new HttpError(404, 'Post not found');
    const fields = sanitizeFields(req.body?.fields);
    updatePost(post.id, { fields, fact_check: factCheck(post.extraction, fields), status: 'queued', status_reason: 'Re-rendering after edit', approved_at: null, approved_by: null });
    enqueue('render', post.id);
    log.info('editor', `fields edited by ${req.user || 'admin'}`, { postId: post.id });
    res.json(postDetail(post.id));
  });

  app.post('/api/posts/:id/regenerate', (req, res) => {
    const post = getPost(req.params.id);
    if (!post) throw new HttpError(404, 'Post not found');
    const reextract = req.body?.reextract !== false;
    const force = Boolean(req.body?.force);
    updatePost(post.id, { status: 'queued', status_reason: reextract ? 'Regenerating (re-reading source)' : 'Re-rendering', approved_at: null, approved_by: null, ...(force ? { duplicate_of: null } : {}) });
    enqueue('process', post.id, { payload: { reextract, force } });
    res.json(postDetail(post.id));
  });

  app.post('/api/posts/rerender', (req, res) => {
    const statuses = ['ready'];
    const rows = getDb().prepare(`SELECT id FROM posts WHERE status IN (${statuses.map(() => '?').join(',')})`).all(...statuses);
    for (const r of rows) {
      updatePost(r.id, { status: 'queued', status_reason: 'Re-rendering with current template/logo' });
      enqueue('render', r.id);
    }
    res.json({ queued: rows.length });
  });

  app.post('/api/posts/:id/approve', (req, res) => {
    const post = getPost(req.params.id);
    if (!post) throw new HttpError(404, 'Post not found');
    if (post.status !== 'ready') throw new HttpError(409, `Only generated posters awaiting review can be approved (status: ${post.status}).`);
    const r = latestRender(post.id);
    if (!r) throw new HttpError(409, 'No generated poster yet.');
    if (r.placeholder) {
      throw new HttpError(409, 'This poster was rendered as a draft (placeholder template or missing official logo) and cannot be approved. Install the official template and logo, then re-render.');
    }
    updatePost(post.id, { status: 'approved', approved_at: now(), approved_by: req.user || 'admin' });
    log.info('editor', `approved by ${req.user || 'admin'} (render v${r.version})`, { postId: post.id });
    res.json(postDetail(post.id));
  });

  app.post('/api/posts/:id/unapprove', (req, res) => {
    const post = getPost(req.params.id);
    if (!post) throw new HttpError(404, 'Post not found');
    if (post.status === 'approved') updatePost(post.id, { status: 'ready', approved_at: null, approved_by: null });
    res.json(postDetail(post.id));
  });

  app.get('/api/posts/:id/download', (req, res) => {
    const post = getPost(req.params.id);
    if (!post) throw new HttpError(404, 'Post not found');
    const r = req.query.version
      ? rendersFor(post.id).find((x) => x.version === Number(req.query.version))
      : latestRender(post.id);
    if (!r) throw new HttpError(404, 'No generated poster yet.');
    const suffix = r.placeholder ? '-DRAFT' : '';
    res.download(absMedia(r.path), `ibn7bharat-${post.id}-v${r.version}${suffix}.png`);
  });

  app.post('/api/posts/:id/photo', upload.single('photo'), wrap(async (req, res) => {
    const post = getPost(req.params.id);
    if (!post) throw new HttpError(404, 'Post not found');
    if (!req.file) throw new HttpError(400, 'No photo uploaded.');
    const meta = await sharp(req.file.buffer).metadata().catch(() => null);
    if (!meta || !['jpeg', 'png', 'webp'].includes(meta.format)) throw new HttpError(400, 'Photo must be JPEG, PNG or WebP.');
    savePhoto(post.id, req.file.buffer, meta.format);
    updatePost(post.id, { status: 'queued', status_reason: 'Re-rendering with new photo' });
    enqueue('render', post.id);
    res.json(postDetail(post.id));
  }));

  // Use a rectangle of the source poster (normalized 0-1 coordinates) as the photo.
  app.post('/api/posts/:id/photo-crop', wrap(async (req, res) => {
    const post = getPost(req.params.id);
    if (!post) throw new HttpError(404, 'Post not found');
    const b = req.body || {};
    const box = Object.fromEntries(['x', 'y', 'width', 'height'].map((k) => [k, Number(b[k])]));
    const ok = Object.values(box).every((v) => Number.isFinite(v) && v >= 0 && v <= 1) && box.width >= 0.05 && box.height >= 0.05
      && box.x + box.width <= 1.0001 && box.y + box.height <= 1.0001;
    if (!ok) throw new HttpError(400, 'Select a larger area inside the source image.');
    await cropPhotoFromSource(post.id, box, 'crop');
    updatePost(post.id, { status: 'queued', status_reason: 'Re-rendering with cropped photo' });
    enqueue('render', post.id);
    res.json(postDetail(post.id));
  }));

  app.delete('/api/posts/:id/photo', (req, res) => {
    const post = getPost(req.params.id);
    if (!post) throw new HttpError(404, 'Post not found');
    removePhoto(post.id);
    updatePost(post.id, { status: 'queued', status_reason: 'Re-rendering without photo' });
    enqueue('render', post.id);
    res.json(postDetail(post.id));
  });

  // ---- manual import (supported fallback for Pages the API cannot read) ----
  app.post('/api/import', upload.single('image'), wrap(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'Attach the poster image.');
    const sourceUrl = String(req.body?.source_url || '').trim();
    if (sourceUrl && !/^https?:\/\//i.test(sourceUrl)) throw new HttpError(400, 'Source link must be an http(s) URL.');
    const { id } = insertPost({
      source: 'manual',
      sourceKey: `manual:${crypto.randomUUID()}`,
      sourceUrl: sourceUrl || null,
      caption: String(req.body?.caption || '').slice(0, 8000),
      postedAt: now(),
      status: 'queued',
    });
    try {
      updatePost(id, { source_image_path: await saveSourceImage(id, req.file.buffer), fields: EMPTY_FIELDS });
    } catch (e) {
      getDb().prepare('DELETE FROM posts WHERE id = ?').run(id);
      throw new HttpError(400, e.message);
    }
    enqueue('process', id);
    log.info('import', `manual import by ${req.user || 'admin'}`, { postId: id });
    res.status(201).json(postDetail(id));
  }));

  // ---- branding assets ----
  app.get('/api/logo', (_req, res) => {
    const p = getSetting('logo_path');
    if (!p || !fs.existsSync(p)) throw new HttpError(404, 'No logo uploaded.');
    res.sendFile(p);
  });

  app.post('/api/logo', upload.single('logo'), wrap(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'No logo file uploaded.');
    const meta = await sharp(req.file.buffer).metadata().catch(() => null);
    if (!meta || !['png', 'svg', 'webp', 'jpeg'].includes(meta.format)) throw new HttpError(400, 'Logo must be PNG, SVG, WebP or JPEG (PNG with transparency or SVG preferred).');
    fs.mkdirSync(config.assetsDir, { recursive: true });
    for (const f of fs.readdirSync(config.assetsDir).filter((n) => n.startsWith('logo.'))) fs.unlinkSync(path.join(config.assetsDir, f));
    // Stored byte-for-byte; never resized or re-encoded.
    const file = path.join(config.assetsDir, `logo.${meta.format === 'jpeg' ? 'jpg' : meta.format}`);
    fs.writeFileSync(file, req.file.buffer);
    setSetting('logo_path', file);
    setSetting('logo_width', meta.width || '');
    setSetting('logo_height', meta.height || '');
    log.info('settings', `logo uploaded (${meta.format} ${meta.width}x${meta.height}, alpha: ${meta.hasAlpha})`);
    res.json({ ok: true, format: meta.format, width: meta.width, height: meta.height, has_alpha: meta.hasAlpha });
  }));

  app.post('/api/template', (req, res) => {
    const id = String(req.body?.id || '');
    loadTemplate(id); // validates
    setSetting('active_template', id);
    log.info('settings', `active template set to "${id}"`);
    res.json({ ok: true });
  });

  app.get('/api/logs', (req, res) => {
    const where = [];
    const vals = [];
    if (req.query.level) {
      where.push('level = ?');
      vals.push(req.query.level);
    }
    if (req.query.post_id) {
      where.push('post_id = ?');
      vals.push(req.query.post_id);
    }
    res.json(
      getDb()
        .prepare(`SELECT * FROM logs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`)
        .all(...vals, Math.min(500, Number(req.query.limit) || 200)),
    );
  });

  app.use((err, _req, res, _next) => {
    let status = err.status || err.statusCode || 500;
    if (err instanceof multer.MulterError) status = 400;
    if (/^invalid template id|ENOENT.*template\.json/.test(err.message)) status = 400;
    if (status >= 500) log.error('http', err.message, { detail: err });
    res.status(status).json({ error: status >= 500 ? 'Internal error - see logs.' : err.message });
  });

  return app;
}

export function startServer() {
  if (!config.admin.password) console.warn('WARNING: ADMIN_PASSWORD is not set - the dashboard is unprotected. Set it before exposing the app.');
  const app = createApp();
  return app.listen(config.port, () => log.info('http', `dashboard listening on http://localhost:${config.port}`));
}
