import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { config } from '../config.js';
import { getDb, getSetting } from '../db.js';
import { hamming, dHash } from '../imagehash.js';
import { log } from '../logger.js';
import { addRender, findNearDuplicate, getPost, updatePost } from '../posts.js';
import { EMPTY_FIELDS, ExtractionError, ExtractionUnavailable, extractPoster, fieldsFromExtraction, photoBox } from './extract.js';
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

function clearPhoto(postId) {
  const dir = photoDir();
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir).filter((n) => n.startsWith(`${postId}.`))) fs.unlinkSync(path.join(dir, f));
}

/** Save an uploaded photo for the poster as-is. origin: 'upload'. */
export function savePhoto(postId, buffer, format) {
  fs.mkdirSync(photoDir(), { recursive: true });
  clearPhoto(postId);
  fs.writeFileSync(path.join(photoDir(), `${postId}.${format === 'jpeg' ? 'jpg' : format}`), buffer);
  updatePost(postId, { photo_origin: 'upload' });
}

export function removePhoto(postId) {
  clearPhoto(postId);
  updatePost(postId, { photo_origin: null });
}

/**
 * Cut the photograph out of the source poster. `box` is normalized (0-1);
 * origin is 'auto' (box from the extractor) or 'crop' (box drawn by an editor).
 */
export async function cropPhotoFromSource(postId, box, origin) {
  const post = getPost(postId);
  if (!post?.source_image_path) throw new PermanentError('no source image to crop from');
  const src = sharp(absMedia(post.source_image_path), { failOn: 'none' });
  const { width, height } = await src.metadata();
  const left = Math.round(box.x * width);
  const top = Math.round(box.y * height);
  const w = Math.max(1, Math.min(width - left, Math.round(box.width * width)));
  const h = Math.max(1, Math.min(height - top, Math.round(box.height * height)));
  const out = await src.extract({ left, top, width: w, height: h }).jpeg({ quality: 92 }).toBuffer();
  fs.mkdirSync(photoDir(), { recursive: true });
  clearPhoto(postId);
  fs.writeFileSync(path.join(photoDir(), `${postId}.jpg`), out);
  updatePost(postId, { photo_origin: origin });
  return { width: w, height: h };
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
    // Take the photograph from the source poster unless an editor chose one.
    const box = photoBox(extraction);
    const current = getPost(postId).photo_origin;
    if (box && (!current || current === 'auto')) await cropPhotoFromSource(postId, box, 'auto');
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

  const check = factCheck(post.extraction, fields, { usedFields: template.fields });
  if (post.photo_origin === 'auto') {
    check.warnings.push({
      level: post.extraction?.photo_box?.has_overlaid_branding ? 'error' : 'info',
      message: post.extraction?.photo_box?.has_overlaid_branding
        ? 'The photo was cut from the source poster and may still carry the source outlet\'s logo or handle - re-crop or upload another photo.'
        : 'The photo was cut automatically from the source poster - check the crop, and that you may reuse it.',
    });
  }
  for (const o of result.overflow) check.warnings.push({ level: 'error', message: `Text does not fit in the "${o}" area even at the minimum size - shorten it.` });
  for (const r of result.draftReasons) check.warnings.push({ level: 'info', message: `Draft: ${r}.` });
  updatePost(postId, { status: 'ready', status_reason: null, fact_check: check, approved_at: null, approved_by: null });
  log.info('render', `rendered post ${postId} v${version} with template "${template.id}"`, { postId });
  if (post.source === 'facebook' && post.page_id) markPageVerified(post.page_id, postId);
  return { status: 'ready', version };
}

/**
 * A Page counts as verified once a post detected on it by the monitor has gone
 * all the way to a generated poster. Until then the dashboard says monitoring
 * of that Page is unverified.
 */
function markPageVerified(pageId, postId) {
  const r = getDb()
    .prepare('UPDATE pages SET verified_at = ?, verified_post_id = ? WHERE id = ? AND verified_at IS NULL')
    .run(new Date().toISOString(), postId, pageId);
  if (r.changes) log.info('monitor', `first real post (#${postId}) detected and processed end to end - Page marked verified`, { pageId, postId });
}
