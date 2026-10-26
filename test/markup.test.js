import './env.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { headlineWithMarkup, photoBox } from '../src/pipeline/extract.js';
import { factCheck, posterText } from '../src/pipeline/facts.js';
import { markupToHtml, stripMarkup } from '../src/pipeline/template.js';

test('markup becomes coloured spans; text is escaped; bad tags are dropped', () => {
  assert.equal(markupToHtml('[b]बिहार[/b] में [r]चक्रवात[/r]'), '<span class="b">बिहार</span> में <span class="r">चक्रवात</span>');
  assert.equal(markupToHtml('<script>x</script> [r]a'), '&lt;script&gt;x&lt;&#x2F;script&gt; <span class="r">a</span>');
  assert.equal(markupToHtml('[r]a[b]b[/b]c[/r]'), '<span class="r">abc</span>');
  assert.equal(markupToHtml('one\ntwo'), 'one<br>two');
  assert.equal(stripMarkup('[r]a[/r] [b]b[/b]'), 'a b');
});

test('model markup is only used when it leaves the words unchanged', () => {
  assert.equal(headlineWithMarkup({ headline: 'बिहार में आग', headline_markup: '[b]बिहार[/b] में [r]आग[/r]' }), '[b]बिहार[/b] में [r]आग[/r]');
  assert.equal(headlineWithMarkup({ headline: 'बिहार में आग', headline_markup: '[b]पटना[/b] में [r]आग[/r]' }), 'बिहार में आग');
  assert.equal(headlineWithMarkup({ headline: '7 दुकानें', headline_markup: '[r]8 दुकानें[/r]' }), '7 दुकानें');
});

test('photo box is clamped and tiny boxes are ignored', () => {
  assert.deepEqual(photoBox({ photo_box: { x: 0, y: 0.5, width: 1.2, height: 0.6, has_overlaid_branding: false } }), { x: 0, y: 0.5, width: 1, height: 0.5, hasBranding: false });
  assert.equal(photoBox({ photo_box: { x: 0, y: 0, width: 0, height: 0 } }), null);
  assert.equal(photoBox(null), null);
});

test('fact check ignores markup and only counts printed fields', () => {
  const extraction = { full_text: 'पटना में 7 दुकानें जलीं\n26 अक्टूबर', people: [], places: [], source_branding: [], uncertain: [] };
  const fields = { headline: '[b]पटना[/b] में [r]7 दुकानें जलीं[/r]', subheadline: '', body_lines: [], location: '', date_text: '26 अक्टूबर', category_label: '' };
  assert.equal(posterText(fields, ['headline']), 'पटना में 7 दुकानें जलीं');
  const msgs = factCheck(extraction, fields, { usedFields: ['headline', 'subheadline', 'body_lines'] }).warnings.map((w) => w.message);
  assert.ok(msgs.some((m) => m.includes('"26"')), 'date dropped by template is reported');
  assert.ok(msgs.some((m) => m.includes('date_text')));
  assert.ok(!msgs.some((m) => m.includes('"7"')));
});
