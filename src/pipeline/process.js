import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { config } from '../config.js';
import { getDb, getSetting } from '../db.js';
import { hamming, dHash } from '../imagehash.js';
import { log } from '../logger.js';
import { addRender, findNearDuplicate, getPost, updatePost } from '../posts.js';
import { EMPTY_FIELDS, ExtractionError, ExtractionUnavailable, extractPoster, fieldsFromExtraction } from './extract.js';
import { factCheck } from './facts.js';
import { renderPoster } from './render.js';
import { loadTemplate } from './template.js';

export class PermanentError extends Error {}

const sourceDir = () => path.join(config.mediaDir, 'source');
const outDir = () => path.join(config.mediaDir, 'generated');
const photoDir = () => path.join(config.mediaDir, 'photos');

export function absMedia(rel) {
  return rel ? path.join(config.mediaDir, rel) : null;
}

async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`image download failed: HTTP ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (!type.startsWith('image/')) throw new PermanentError(`source URL is not an image (${type || 'no content-type'})`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > config.maxImageBytes) throw new PermanentError('source image is too large');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > config.maxImageBytes) throw new PermanentError('source image is too large');
  return buf;
}

/** Store the source image as-is (no re-encoding) and return its relative path. */
export async function saveSourceImage(postId, buf) {
  const meta = await sharp(buf, { failOn: 'none' }).metadata().catch(() => null);
  if (!meta?.format) throw new PermanentError('source file is not a readable image');
  const ext = { jpeg: 'jpg', png: 'png', webp: 'webp', gif: 'gif' }[meta.format] || meta.format;
  fs.mkdirSync(sourceDir(), { recursive: true });
  const rel = path.join('source', `${postId}.${ext}`);
  fs.writeFileSync(absMedia(rel), buf);
  return rel;
}

export function photoPathFor(postId) {
  const dir = photoDir();
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).find((n) => n.startsWith(`${postId}.`));
  return f ? path.join(dir, f) : null;
}

export function activeLogoPath() {
  const p = getSetting('logo_path');
  return p && fs.existsSync(p) ? p : null;
}

/**
 * Full pipeline for one post: fetch image -> duplicate check -> extract text ->
 * render. `graph` is used to upgrade Facebook photos to their largest size.
 */
export async function processPost(postId, { graph, force = false, reextract = false } = {}) {
  const post = getPost(postId);
  if (!post) throw new PermanentError(`post ${postId} not found`);
  updatePost(postId, { status: 'processing', status_reason: null });

  // 1. Source image
  let rel = post.source_image_path;
  if (!rel || !fs.existsSync(absMedia(rel))) {
    if (!post.image_url) throw new PermanentError('post has no image');
    let url = post.image_url;
    const photoId = post.fb_photo_id;
    if (graph && photoId && post.page_id) {
      try {
        const page = getDb().prepare('SELECT identifier, fb_page_id FROM pages WHERE id = ?').get(post.page_id);
        const { token } = await graph.tokenFor(page.identifier, page.fb_page_id);
        url = (await graph.bestPhotoUrl(photoId, token)) || url;
      } catch (e) {
        log.warn('process', `could not fetch full-size photo, using attachment image: ${e.message}`, { postId });
      }
    }
    rel = await saveSourceImage(postId, await download(url));
    updatePost(postId, { source_image_path: rel });
  }
  const buf = fs.readFileSync(absMedia(rel));

  // 2. Duplicate detection (same poster reposted, or shared across monitored Pages)
  const hash = await dHash(buf);
  updatePost(postId, { image_hash: hash });
  if (!force) {
    const dup = findNearDuplicate(postId, hash, {
      threshold: config.worker.duplicateHammingThreshold,
      windowDays: config.worker.duplicateWindowDays,
      hamming,
    });
    if (dup) {
      updatePost(postId, { status: 'duplicate', duplicate_of: dup, status_reason: `Same image as post #${dup}` });
      log.info('process', `post ${postId} is a duplicate of ${dup}`, { postId });
      return { status: 'duplicate' };
    }
  }

  // 3. Text extraction
  let extraction = post.extraction;
  let fields = post.fields;
  if (!extraction || reextract) {
    try {
      extraction = await extractPoster(buf, { caption: post.caption || '' });
      updatePost(postId, { extraction });
      fields = fieldsFromExtraction(extraction);
    } catch (e) {
      if (e instanceof ExtractionUnavailable) {
        updatePost(postId, {
          status: 'needs_input',
          status_reason: e.message,
          fields: fields || EMPTY_FIELDS,
          fact_check: factCheck(null, fields || EMPTY_FIELDS),
        });
        return { status: 'needs_input' };
      }
      if (e instanceof ExtractionError && !e.retryable) throw new PermanentError(e.message);
      throw e;
    }
    if (!extraction.is_news_poster && !force) {
      updatePost(postId, { status: 'skipped', status_reason: `Not a news poster: ${extraction.not_news_reason || 'no reason given'}`, fields });
      return { status: 'skipped' };
    }
  }
  updatePost(postId, { fields });

  // 4. Render
  return renderStored(postId);
}

/** Render the post's current (possibly edited) fields with the active template. */
export async function renderStored(postId) {
  const post = getPost(postId);
  const fields = post.fields || EMPTY_FIELDS;
  if (!fields.headline?.trim()) {
    updatePost(postId, { status: 'needs_input', status_reason: 'Headline is empty - enter the poster text.' });
    return { status: 'needs_input' };
  }
  const template = loadTemplate(getSetting('active_template') || 'placeholder');
  fs.mkdirSync(outDir(), { recursive: true });
  const fileRel = path.join('generated', `${postId}-${Date.now()}.png`);
  const result = await renderPoster({
    template,
    fields,
    logoPath: activeLogoPath(),
    photoPath: photoPathFor(postId),
    outPath: absMedia(fileRel),
  });
  const version = addRender(postId, { path: fileRel, templateId: template.id, placeholder: result.placeholder, width: result.width, height: result.height });

  const check = factCheck(post.extraction, fields);
  for (const o of result.overflow) check.warnings.push({ level: 'error', message: `Text does not fit in the "${o}" area even at the minimum size - shorten it.` });
  for (const r of result.draftReasons) check.warnings.push({ level: 'info', message: `Draft: ${r}.` });
  updatePost(postId, { status: 'ready', status_reason: null, fact_check: check, approved_at: null, approved_by: null });
  log.info('render', `rendered post ${postId} v${version} with template "${template.id}"`, { postId });
  return { status: 'ready', version };
}
