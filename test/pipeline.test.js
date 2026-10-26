import './env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, test } from 'node:test';
import sharp from 'sharp';
import { openDb, setSetting } from '../src/db.js';
import { getPost, insertPost, latestRender, updatePost } from '../src/posts.js';
import { absMedia, processPost, renderStored, saveSourceImage } from '../src/pipeline/process.js';
import { closeRenderer } from '../src/pipeline/render.js';
import { TEST_DATA_DIR } from './env.js';

openDb();
after(closeRenderer);

const svgPoster = (text, bg) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800">
  <rect width="800" height="800" fill="${bg}"/><rect x="40" y="300" width="${text}" height="200" fill="#fff"/></svg>`);

async function importImage(buf) {
  const { id } = insertPost({ source: 'manual', sourceKey: `manual:${Math.random()}`, status: 'queued' });
  updatePost(id, { source_image_path: await saveSourceImage(id, await sharp(buf).png().toBuffer()) });
  return id;
}

test('manual extraction -> needs_input, then edit -> draft render', async () => {
  const id = await importImage(svgPoster(600, '#a00'));
  assert.equal((await processPost(id)).status, 'needs_input');

  updatePost(id, {
    fields: {
      category_label: 'ब्रेकिंग न्यूज़', headline: 'प्रयागराज में गंगा का जलस्तर बढ़ा, १२ गाँवों में अलर्ट जारी',
      subheadline: 'प्रशासन ने निचले इलाकों को खाली कराने के निर्देश दिए', body_lines: ['एनडीआरएफ की 3 टीमें तैनात', 'स्कूल 2 दिन बंद'],
      location: 'प्रयागराज', date_text: '26 अक्टूबर 2026',
    },
  });
  const r = await renderStored(id);
  assert.equal(r.status, 'ready');
  const render = latestRender(id);
  assert.equal(render.placeholder, 1); // placeholder template + no logo
  const meta = await sharp(absMedia(render.path)).metadata();
  assert.deepEqual([meta.width, meta.height, meta.format], [1080, 1080, 'png']);
  const post = getPost(id);
  assert.ok(post.fact_check.warnings.some((w) => /placeholder template/.test(w.message)));
  fs.copyFileSync(absMedia(render.path), `${TEST_DATA_DIR}/sample-render.png`);
});

test('logo is drawn without distortion', async () => {
  // A 4:1 logo in a 300x90 box must keep 4:1 (300x75), not stretch to fill.
  const logo = `${TEST_DATA_DIR}/logo.png`;
  await sharp({ create: { width: 400, height: 100, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 1 } } }).png().toFile(logo);
  setSetting('logo_path', logo);
  const id = await importImage(svgPoster(300, '#0a0'));
  updatePost(id, { fields: { category_label: '', headline: 'परीक्षण', subheadline: '', body_lines: [], location: '', date_text: '' } });
  await renderStored(id);
  const { data, info } = await sharp(absMedia(latestRender(id).path)).raw().toBuffer({ resolveWithObject: true });
  let minY = Infinity, maxY = -1, minX = Infinity, maxX = -1;
  for (let y = 0; y < 150; y++) for (let x = 0; x < 400; x++) {
    const i = (y * info.width + x) * info.channels;
    if (data[i] < 30 && data[i + 1] < 30 && data[i + 2] > 220) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
  }
  const w = maxX - minX + 1, h = maxY - minY + 1;
  assert.ok(Math.abs(w / h - 4) < 0.1, `logo rendered ${w}x${h}`);
  assert.equal(latestRender(id).placeholder, 1); // still a placeholder template
  setSetting('logo_path', '');
});

test('the same poster image is detected as a duplicate', async () => {
  const buf = svgPoster(500, '#00a');
  const first = await importImage(buf);
  await processPost(first);
  const second = await importImage(await sharp(buf).resize(640).jpeg({ quality: 70 }).toBuffer());
  const r = await processPost(second);
  assert.equal(r.status, 'duplicate');
  assert.equal(getPost(second).duplicate_of, first);
  // ...unless forced
  assert.equal((await processPost(second, { force: true })).status, 'needs_input');
});
