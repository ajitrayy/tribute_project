import './env.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bestResult, colourAsInk, fieldsFromPasses, isText, linesFromTesseract, ocrLinesToFields, toGreyscale } from '../public/ocr-map.js';

test('tallest lines become the headline, smaller ones body, "- name" the red box', () => {
  const r = ocrLinesToFields([
    { text: 'अरुणाचल में चीनी सेना के साथ', height: 70, confidence: 80 },
    { text: 'कई जगह फेस-ऑफ हुआ', height: 64, confidence: 85 },
    { text: '- शत्रुजीत कपूर, DG (ITBP)', height: 50, confidence: 75 },
    { text: 'सीमा पर तनाव जारी', height: 30, confidence: 70 },
  ]);
  assert.deepEqual(r.fields, {
    headline: 'अरुणाचल में चीनी सेना के साथ\nकई जगह फेस-ऑफ हुआ',
    subheadline: '- शत्रुजीत कपूर, DG (ITBP)',
    body_lines: ['सीमा पर तनाव जारी'],
  });
});

test('source branding, noise and low-confidence lines are left off the poster', () => {
  const r = ocrLinesToFields([
    { text: 'XYZ न्यूज़ @xyznews', height: 20, confidence: 90 },
    { text: 'www.xyznews.in', height: 20, confidence: 90 },
    { text: 'वाराणसी में भीषण आग', height: 60, confidence: 88 },
    { text: '| ~ _ |', height: 60, confidence: 90 },
    { text: 'Gm AA AY NA', height: 60, confidence: 40 },
    { text: 'के रे हु', height: 50, confidence: 12 },
  ]);
  assert.equal(r.fields.headline, 'वाराणसी में भीषण आग');
  assert.deepEqual(r.fields.body_lines, []);
  assert.deepEqual(r.branding, ['XYZ न्यूज़ @xyznews', 'www.xyznews.in']);
  assert.match(r.fullText, /वाराणसी में भीषण आग/);
});

test('empty OCR gives an empty headline (editor falls back to typing)', () => {
  assert.equal(ocrLinesToFields([]).fields.headline, '');
  assert.equal(ocrLinesToFields([{ text: '— —', height: 10, confidence: 90 }]).fields.headline, '');
  assert.equal(isText('ab'), true);
  assert.equal(isText('* ©'), false);
});

test('tesseract blocks are flattened with line heights', () => {
  const data = { blocks: [{ paragraphs: [{ lines: [{ text: 'क\n', bbox: { y0: 10, y1: 70 }, confidence: 91 }] }] }] };
  assert.deepEqual(linesFromTesseract(data), [{ text: 'क\n', height: 60, confidence: 91 }]);
  assert.deepEqual(linesFromTesseract(null), []);
});

test('pixel transforms: red text becomes dark ink; greyscale uses luminance', () => {
  const px = () => ({ data: new Uint8ClampedArray([224, 20, 27, 255, 255, 255, 255, 255]) });
  assert.deepEqual([...colourAsInk(px()).data], [20, 20, 20, 255, 255, 255, 255, 255]);
  assert.deepEqual([...toGreyscale(px()).data].slice(0, 3), [82, 82, 82]);
  assert.equal(bestResult([{ confidence: 40 }, { confidence: 77 }, null]).confidence, 77);
});

test('two OCR passes: best pass wins, quote box taken from the other pass if missing', () => {
  const pass = (confidence, lines) => ({
    confidence,
    text: lines.map((l) => l[0]).join('\n'),
    blocks: [{ paragraphs: [{ lines: lines.map(([text, h]) => ({ text, bbox: { y0: 0, y1: h }, confidence })) }] }],
  });
  const ink = pass(94, [['अरुणाचल में चीनी सेना के साथ', 60], ['कई जगह फेस-ऑफ हुआ', 60]]);
  const grey = pass(56, [['अरुणाचल में चीनी सेना', 60], ['- शत्रुजीत कपूर, DG (ITBP)', 40]]);
  const r = fieldsFromPasses([grey, ink]);
  assert.equal(r.confidence, 94);
  assert.equal(r.fields.headline, 'अरुणाचल में चीनी सेना के साथ\nकई जगह फेस-ऑफ हुआ');
  assert.equal(r.fields.subheadline, '- शत्रुजीत कपूर, DG (ITBP)');
  assert.match(r.text, /शत्रुजीत कपूर/);
  assert.equal(fieldsFromPasses([]).fields.headline, '');
});
