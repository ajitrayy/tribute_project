import './env.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { factCheck, normalizeDigits, numbersIn } from '../src/pipeline/facts.js';

test('normalizes Devanagari digits and finds numbers', () => {
  assert.equal(normalizeDigits('२०२६'), '2026');
  assert.deepEqual(numbersIn('१२ लोग, 3.5 करोड़, 12/08/2026 को 10:30 बजे, 1,200 पद'), ['12', '3.5', '12/08/2026', '10:30', '1200']);
});

const extraction = {
  full_text: 'ब्रेकिंग न्यूज़\nलखनऊ में १२ लोग घायल\nमुख्यमंत्री योगी आदित्यनाथ ने 5 लाख मुआवजे का ऐलान किया\nXYZ News\n@xyznews',
  people: ['योगी आदित्यनाथ'],
  places: ['लखनऊ'],
  source_branding: ['XYZ News', '@xyznews'],
  uncertain: [],
};

test('faithful fields produce no warnings', () => {
  const fields = {
    category_label: 'ब्रेकिंग न्यूज़', headline: 'लखनऊ में १२ लोग घायल', subheadline: 'मुख्यमंत्री योगी आदित्यनाथ ने 5 लाख मुआवजे का ऐलान किया',
    body_lines: [], location: '', date_text: '',
  };
  assert.deepEqual(factCheck(extraction, fields).warnings, []);
});

test('flags changed numbers, dropped names and copied branding', () => {
  const fields = {
    category_label: '', headline: 'लखनऊ में 15 लोग घायल', subheadline: 'XYZ News', body_lines: [], location: '', date_text: '',
  };
  const msgs = factCheck(extraction, fields).warnings.map((w) => `${w.level}: ${w.message}`);
  assert.ok(msgs.some((m) => m.startsWith('error') && m.includes('"15"')), msgs.join('\n'));
  assert.ok(msgs.some((m) => m.includes('"12"') && m.startsWith('warn')));
  assert.ok(msgs.some((m) => m.includes('"5"')));
  assert.ok(msgs.some((m) => m.includes('योगी आदित्यनाथ')));
  assert.ok(msgs.some((m) => m.startsWith('error') && m.includes('XYZ News')));
});

test('no extraction means manual verification notice', () => {
  const r = factCheck(null, { headline: 'x' });
  assert.equal(r.checked, false);
});
