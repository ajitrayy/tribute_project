import './env.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import sharp from 'sharp';
import { getDb, now, openDb, setSetting } from '../src/db.js';
import { getPost, insertPost, latestRender, updatePost } from '../src/posts.js';
import { absMedia, cropPhotoFromSource, photoPathFor, processPost, renderStored, saveSourceImage } from '../src/pipeline/process.js';
import { closeRenderer } from '../src/pipeline/render.js';
import { TEST_DATA_DIR } from './env.js';

openDb();
after(closeRenderer);

const svgPoster = (text, bg) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800">
  <rect width="800" height="800" fill="${bg}"/><rect x="40" y="300" width="${text}" height="200" fill="#fff"/></svg>`);

async function importImage(buf, extra = {}) {
  const { id } = insertPost({ source: 'manual', sourceKey: `manual:${Math.random()}`, status: 'queued', ...extra });
  updatePost(id, { source_image_path: await saveSourceImage(id, await sharp(buf).png().toBuffer()) });
  return id;
}

const FIELDS = {
  category_label: '', headline: '[b]बिहार के मौसम[/b] में [r]चक्रवात[/r] का असर,\n[r]किसानों की मेहनत पर[/r] फिर सकता है पानी',
  subheadline: '', body_lines: [], location: '', date_text: '',
};

/** Bounding box of pixels matching `match` within the given region. */
async function bbox(file, match, region) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = region.top; y < region.top + region.height; y++) {
    for (let x = region.left; x < region.left + region.width; x++) {
      const i = (y * info.width + x) * info.channels;
      if (match(data[i], data[i + 1], data[i + 2])) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
  }
  return { w: maxX - minX + 1, h: maxY - minY + 1, minX, maxX };
}

test('placeholder template: manual import -> needs_input -> edit -> draft PNG', async () => {
  setSetting('active_template', 'placeholder');
  const id = await importImage(svgPoster(600, '#a00'));
  assert.equal((await processPost(id)).status, 'needs_input');
  updatePost(id, { fields: { ...FIELDS, body_lines: ['एनडीआरएफ की 3 टीमें तैनात'], location: 'पटना', date_text: '26 अक्टूबर 2026' } });
  assert.equal((await renderStored(id)).status, 'ready');
  const render = latestRender(id);
  assert.equal(render.placeholder, 1);
  const meta = await sharp(absMedia(render.path)).metadata();
  assert.deepEqual([meta.width, meta.height, meta.format], [1080, 1080, 'png']);
  assert.ok(getPost(id).fact_check.warnings.some((w) => /placeholder template/.test(w.message)));
});

test('ibn7bharat template: 1080x1350, coloured headline, draft only without logo', async () => {
  setSetting('active_template', 'ibn7bharat');
  setSetting('logo_path', '');
  const id = await importImage(svgPoster(600, '#0a0'));
  updatePost(id, { fields: FIELDS });
  await renderStored(id);
  let r = latestRender(id);
  assert.equal(r.placeholder, 1, 'missing logo must make it a draft');
  const file = absMedia(r.path);
  const meta = await sharp(file).metadata();
  assert.deepEqual([meta.width, meta.height], [1080, 1350]);
  const head = { left: 0, top: 130, width: 1080, height: 420 };
  const blue = await bbox(file, (R, G, B) => B > 140 && R < 40 && G < 80, head);
  const red = await bbox(file, (R, G, B) => R > 200 && G < 60 && B < 60, head);
  assert.ok(blue.w > 100 && red.w > 100, `blue ${blue.w}, red ${red.w}`);
  const out = getPost(id);
  assert.ok(!out.fact_check.warnings.some((w) => /\[r\]/.test(w.message)));

  // With a 4:1 logo the logo is drawn 224x56 (fixed height, natural width) and centred.
  const logo = `${TEST_DATA_DIR}/logo.png`;
  await sharp({ create: { width: 400, height: 100, channels: 4, background: { r: 0, g: 200, b: 0, alpha: 1 } } }).png().toFile(logo);
  setSetting('logo_path', logo);
  await renderStored(id);
  r = latestRender(id);
  assert.equal(r.placeholder, 0);
  const g = await bbox(absMedia(r.path), (R, G, B) => G > 180 && R < 40 && B < 40, { left: 0, top: 0, width: 1080, height: 130 });
  assert.ok(Math.abs(g.w / g.h - 4) < 0.1, `logo ${g.w}x${g.h}`);
  assert.ok(Math.abs(g.h - 56) <= 1, `logo height ${g.h}`);
  assert.ok(Math.abs((g.minX + g.maxX) / 2 - 540) <= 2, 'logo centred');
  setSetting('logo_path', '');
});

test('photo cropped from the source poster is used and fact check flags overlaid branding', async () => {
  setSetting('active_template', 'ibn7bharat');
  const id = await importImage(svgPoster(600, '#00f'));
  await cropPhotoFromSource(id, { x: 0, y: 0.5, width: 1, height: 0.5 }, 'auto');
  const photo = await sharp(photoPathFor(id)).metadata();
  assert.deepEqual([photo.width, photo.height], [800, 400]);
  updatePost(id, { fields: FIELDS, extraction: { full_text: FIELDS.headline.replace(/\[\/?[rb]\]/g, ''), photo_box: { has_overlaid_branding: true } } });
  await renderStored(id);
  const post = getPost(id);
  assert.equal(post.photo_origin, 'auto');
  assert.ok(post.fact_check.warnings.some((w) => w.level === 'error' && /source outlet's logo/.test(w.message)));
});

test('a Facebook Page is marked verified only after a detected post is rendered', async () => {
  const d = getDb();
  const pageId = Number(d.prepare("INSERT INTO pages (url, identifier, monitor_since, created_at) VALUES ('https://www.facebook.com/v','v',?,?)").run(now(), now()).lastInsertRowid);
  const manual = await importImage(svgPoster(100, '#333'));
  updatePost(manual, { fields: FIELDS });
  await renderStored(manual);
  assert.equal(d.prepare('SELECT verified_at FROM pages WHERE id = ?').get(pageId).verified_at, null, 'manual imports never verify a Page');

  const fb = await importImage(svgPoster(200, '#333'), { source: 'facebook', pageId, fbPostId: '1_2' });
  updatePost(fb, { fields: FIELDS });
  await renderStored(fb);
  const page = d.prepare('SELECT verified_at, verified_post_id FROM pages WHERE id = ?').get(pageId);
  assert.ok(page.verified_at);
  assert.equal(page.verified_post_id, fb);
});

test('the same poster image is detected as a duplicate', async () => {
  const buf = svgPoster(500, '#0aa');
  const first = await importImage(buf);
  await processPost(first);
  const second = await importImage(await sharp(buf).resize(640).jpeg({ quality: 70 }).toBuffer());
  const r = await processPost(second);
  assert.equal(r.status, 'duplicate');
  assert.equal(getPost(second).duplicate_of, first);
  assert.equal((await processPost(second, { force: true })).status, 'needs_input');
});
