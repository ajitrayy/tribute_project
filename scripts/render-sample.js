// Renders sample Hindi text with a template, for building and checking templates:
//   npm run render:sample -- [template-id] [out.png] [logo-file]
import path from 'node:path';
import { closeRenderer, renderPoster } from '../src/pipeline/render.js';
import { loadTemplate } from '../src/pipeline/template.js';

const [id = 'ibn7bharat', out = 'sample.png', logo] = process.argv.slice(2);
const fields = {
  category_label: 'ब्रेकिंग न्यूज़',
  headline: '[b]प्रयागराज[/b] में [r]गंगा का जलस्तर खतरे के निशान के पार[/r],\n१२ गाँवों में [r]अलर्ट[/r]',
  subheadline: 'ज़िला प्रशासन ने निचले इलाकों को खाली कराने के निर्देश दिए',
  body_lines: ['एनडीआरएफ की 3 टीमें तैनात', 'स्कूल अगले 2 दिन बंद रहेंगे'],
  location: 'प्रयागराज',
  date_text: '26 अक्टूबर 2026',
};
const r = await renderPoster({ template: loadTemplate(id), fields, logoPath: logo ? path.resolve(logo) : null, outPath: path.resolve(out) });
console.log(`wrote ${out} (${r.width}x${r.height})${r.placeholder ? ` DRAFT: ${r.draftReasons.join('; ')}` : ''}${r.overflow.length ? ` overflow: ${r.overflow}` : ''}`);
await closeRenderer();
