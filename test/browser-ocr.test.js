// Drives the real dashboard in headless Chromium: upload a poster, let the
// in-browser Tesseract.js OCR fill the editor, save, and download the PNG.
// Also checks the fallback when the Hindi language data cannot be loaded.
import './env.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { openDb } from '../src/db.js';
import { GraphClient } from '../src/facebook/graph.js';
import { claimNext } from '../src/jobs.js';
import { closeRenderer } from '../src/pipeline/render.js';
import { createApp } from '../src/server.js';
import { runJob } from '../src/worker.js';

const REF = path.resolve('templates/ibn7bharat/reference/01-bihar-weather.jpg');
openDb();
const graph = new GraphClient({ graphBase: 'https://graph.invalid', userToken: '', pageTokens: {}, fetch: async () => { throw new Error('no network'); } });
let server, base, browser, loop;

before(async () => {
  server = createApp({ graph }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  // Minimal worker loop for render jobs.
  let busy = false;
  loop = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      let job;
      while ((job = claimNext())) await runJob(job, graph);
    } finally {
      busy = false;
    }
  }, 300);
  browser = await chromium.launch();
});
after(async () => {
  clearInterval(loop);
  await browser?.close();
  server.close();
  await closeRenderer();
});

async function importPoster(page, file) {
  await page.goto(base);
  await page.click('[data-tab=import]');
  await page.setInputFiles('#import-form input[name=image]', file);
  await page.click('#import-form button');
  await page.waitForSelector('#detail[open]');
}

test('browser OCR fills the editor and the poster renders to a 1080x1350 PNG', { timeout: 180000 }, async () => {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 1000 } });
  const page = await ctx.newPage();
  const external = [];
  page.on('request', (r) => { if (/^https?:/.test(r.url()) && !r.url().startsWith(base)) external.push(r.url()); });
  await importPoster(page, REF);
  await page.waitForFunction(() => /OCR done|could not run/.test(document.querySelector('#d-ocr-status').textContent), null, { timeout: 150000 });
  assert.match(await page.textContent('#d-ocr-status'), /OCR done/);
  const headline = await page.inputValue('[name=headline]');
  for (const w of ['बिहार', 'चक्रवात', 'अक्टूबर', 'अलर्ट']) assert.ok(headline.includes(w), `"${w}" not in OCR headline:\n${headline}`);
  assert.deepEqual(external, [], 'OCR must not call external services');
  assert.equal(await page.isVisible('#d-ocr-details'), true);

  await page.click('#d-form button:not([type])');
  await page.waitForFunction(() => document.querySelector('#d-version')?.textContent.startsWith('v1'), null, { timeout: 60000 });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#d-download')]);
  const meta = await sharp(await dl.path()).metadata();
  assert.deepEqual([meta.width, meta.height, meta.format], [1080, 1350, 'png']);
  await ctx.close();
});

test('if the Hindi language data cannot load, the editor falls back to manual typing', { timeout: 180000 }, async () => {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 1000 } });
  await ctx.route('**/vendor/tessdata/**', (r) => r.abort());
  const page = await ctx.newPage();
  await importPoster(page, REF);
  await page.waitForFunction(() => /OCR done|could not run/.test(document.querySelector('#d-ocr-status').textContent), null, { timeout: 150000 });
  assert.match(await page.textContent('#d-ocr-status'), /OCR could not run .*Type the poster text/);
  await page.fill('[name=headline]', 'बिहार में येलो अलर्ट जारी');
  await page.click('#d-form button:not([type])');
  await page.waitForFunction(() => document.querySelector('#d-version')?.textContent.startsWith('v1'), null, { timeout: 60000 });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#d-download')]);
  const meta = await sharp(await dl.path()).metadata();
  assert.deepEqual([meta.width, meta.height], [1080, 1350]);
  await ctx.close();
});
