// Runs the real Tesseract.js engine with the Hindi + English language data that
// ships in node_modules (no network), on the committed IBN7 reference poster.
import './env.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, test } from 'node:test';
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import { colourAsInk, linesFromTesseract, ocrLinesToFields } from '../public/ocr-map.js';

const D = path.resolve('node_modules/@tesseract.js-data');
const REF = path.resolve('templates/ibn7bharat/reference/01-bihar-weather.jpg');
let worker;
after(() => worker?.terminate());

test('Hindi OCR reads the reference poster offline', { timeout: 120000 }, async () => {
  worker = await createWorker('hin', 1, { langPath: `${D}/hin/4.0.0_best_int`, cacheMethod: 'none', gzip: true });
  // Same preparation as the dashboard: images under 1200 px wide are enlarged 2x,
  // then the "colour as ink" pass.
  const { width } = await sharp(REF).metadata();
  const { data: raw, info } = await sharp(REF).resize(width < 1200 ? width * 2 : width).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const ink = colourAsInk({ data: raw }).data;
  const png = await sharp(Buffer.from(ink), { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
  const { data } = await worker.recognize(png, {}, { text: true, blocks: true });
  assert.ok(data.confidence > 60, `confidence ${data.confidence}`);
  for (const phrase of ['बिहार के मौसम', 'सकता है पानी', '27 और 28 अक्टूबर', 'अलर्ट जारी']) {
    assert.ok(data.text.includes(phrase), `missing "${phrase}" in:\n${data.text}`);
  }
  const { fields } = ocrLinesToFields(linesFromTesseract(data));
  assert.equal(fields.headline.split('\n').length, 3, fields.headline);
});
