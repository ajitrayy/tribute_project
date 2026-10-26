// Free, offline Hindi OCR check from the terminal - the same Tesseract.js engine,
// language data and two-pass preparation the dashboard uses in the browser:
//   npm run ocr:check -- path/to/poster.jpg
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import { ROOT } from '../src/config.js';
import { colourAsInk, fieldsFromPasses, toGreyscale } from '../public/ocr-map.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: npm run ocr:check -- <poster image>');
  process.exit(2);
}
const D = path.join(ROOT, 'node_modules/@tesseract.js-data');
const { width } = await sharp(file).metadata();
const { data, info } = await sharp(file).resize(width < 1200 ? width * 2 : width).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const variant = (transform) => sharp(Buffer.from(transform({ data: Uint8ClampedArray.from(data) }).data), { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();

const started = Date.now();
// Tesseract reads every language from one folder, but the Hindi and English
// packages install into separate folders, so link both into a temp folder.
const langDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessdata-'));
for (const lang of ['hin', 'eng']) {
  const src = path.join(D, lang, '4.0.0_best_int', `${lang}.traineddata.gz`);
  if (fs.existsSync(src)) fs.symlinkSync(src, path.join(langDir, `${lang}.traineddata.gz`));
}
if (!fs.existsSync(path.join(langDir, 'hin.traineddata.gz'))) {
  console.error('Hindi language data is missing - run npm install.');
  process.exit(1);
}
const langs = fs.existsSync(path.join(langDir, 'eng.traineddata.gz')) ? 'hin+eng' : 'hin';
const worker = await createWorker(langs, 1, { langPath: langDir, cacheMethod: 'none', gzip: true });
const passes = [];
for (const t of [toGreyscale, colourAsInk]) passes.push((await worker.recognize(await variant(t), {}, { text: true, blocks: true })).data);
await worker.terminate();
fs.rmSync(langDir, { recursive: true, force: true });
const r = fieldsFromPasses(passes);
console.log(`OCR (${langs}) took ${(Date.now() - started) / 1000}s, confidence ${Math.round(r.confidence)}%\n`);
console.log(`Headline:\n${r.fields.headline || '(none found)'}\n`);
console.log(`Red box line: ${r.fields.subheadline || '(none)'}`);
console.log(`Other lines: ${r.fields.body_lines.join(' / ') || '(none)'}`);
console.log(`Left off as source branding: ${r.branding.join(' / ') || '(none)'}`);
