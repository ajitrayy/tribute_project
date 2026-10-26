// Runs automatic text extraction on one poster image and prints the result,
// without touching the database:  npm run extract:check -- path/to/poster.jpg
// Needs ANTHROPIC_API_KEY (and EXTRACTION_PROVIDER unset or "anthropic").
import fs from 'node:fs';
import { config } from '../src/config.js';
import { extractPoster, fieldsFromExtraction, photoBox } from '../src/pipeline/extract.js';
import { factCheck } from '../src/pipeline/facts.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: npm run extract:check -- <poster image>');
  process.exit(2);
}
if (config.extraction.provider !== 'anthropic') {
  console.error('Automatic extraction is off: set ANTHROPIC_API_KEY (and leave EXTRACTION_PROVIDER unset or "anthropic").');
  process.exit(2);
}
const started = Date.now();
const x = await extractPoster(fs.readFileSync(file));
const fields = fieldsFromExtraction(x);
console.log(JSON.stringify({ model: x.model, seconds: (Date.now() - started) / 1000, is_news_poster: x.is_news_poster, fields, photo_box: photoBox(x), source_branding: x.source_branding, uncertain: x.uncertain }, null, 2));
console.log('\nFull transcription:\n' + x.full_text);
const check = factCheck(x, fields, { usedFields: ['headline', 'subheadline', 'body_lines'] });
console.log(`\nFact check: ${check.warnings.length ? check.warnings.map((w) => `${w.level}: ${w.message}`).join('\n') : 'no differences'}`);
