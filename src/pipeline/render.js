// Renders poster HTML to PNG in headless Chromium. Chromium shapes Devanagari
// with HarfBuzz (correct conjuncts and matras) and rasterizes glyphs from the
// font outlines at the output resolution, so Hindi text stays sharp; the logo
// is drawn with object-fit: contain so it is never stretched.

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { buildHtml } from './template.js';

let browserPromise;

async function browser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ args: ['--font-render-hinting=none'] }).catch((e) => {
      browserPromise = undefined;
      throw e;
    });
  }
  const b = await browserPromise;
  if (!b.isConnected()) {
    browserPromise = undefined;
    return browser();
  }
  return b;
}

export async function closeRenderer() {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    browserPromise = undefined;
    await b?.close();
  }
}

// Shrinks text in [data-fit] boxes until it fits, down to data-fit-min px.
const FIT_SCRIPT = `
  for (const el of document.querySelectorAll('[data-fit]')) {
    const min = Number(el.dataset.fitMin || 24);
    const cs = getComputedStyle(el);
    let size = parseFloat(cs.fontSize);
    // With a max-height, compare the laid-out height of the lines against it.
    // scrollHeight would also count Devanagari matras that rise above tight
    // line boxes and report overflow for text that fits.
    const maxH = cs.maxHeight === 'none' ? null : parseFloat(cs.maxHeight);
    if (maxH !== null) el.style.maxHeight = 'none';
    const tall = () => (maxH !== null ? el.offsetHeight > maxH + 1 : el.scrollHeight > el.clientHeight + 1);
    const over = () => tall() || el.scrollWidth > el.clientWidth + 1;
    while (over() && size > min) { size -= 1; el.style.fontSize = size + 'px'; }
    el.dataset.fitResult = over() ? 'overflow' : String(size);
    if (maxH !== null) el.style.maxHeight = '';
  }
`;

const DRAFT_OVERLAY = (reason) => `
  <div style="position:fixed;inset:0;pointer-events:none;z-index:2147483647;display:flex;align-items:center;justify-content:center;">
    <div style="transform:rotate(-30deg);font:700 46px/1.2 sans-serif;color:rgba(200,0,0,.55);border:6px solid rgba(200,0,0,.55);padding:16px 32px;text-align:center;background:rgba(255,255,255,.35)">
      DRAFT - NOT FOR PUBLICATION<br><span style="font-size:28px">${reason}</span>
    </div>
  </div>`;

/**
 * Render a poster. Returns { width, height, placeholder, overflow }.
 * `placeholder` is true when the output must not be approved: the template is a
 * stand-in, or the template requires the official logo and none is configured.
 */
export async function renderPoster({ template, fields, logoPath, photoPath, outPath }) {
  const reasons = [];
  if (template.placeholder) reasons.push('placeholder template - official IBN7 Bharat template not installed');
  if (template.requiresLogo && !logoPath) reasons.push('official logo not uploaded');

  let html = buildHtml(template, fields, { logoPath, photoPath });
  if (reasons.length) html = html.replace(/<\/body>/i, `${DRAFT_OVERLAY(reasons.join('; '))}</body>`);

  const b = await browser();
  const ctx = await b.newContext({
    viewport: { width: template.width, height: template.height },
    deviceScaleFactor: template.scale,
    javaScriptEnabled: true,
  });
  // Templates are self-contained; refuse any network fetch they might attempt.
  await ctx.route('**/*', (route) => (route.request().url().startsWith('data:') ? route.continue() : route.abort()));
  try {
    const page = await ctx.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(FIT_SCRIPT);
    const overflow = await page.evaluate(() =>
      [...document.querySelectorAll('[data-fit]')].filter((e) => e.dataset.fitResult === 'overflow').map((e) => e.dataset.fit || e.className),
    );
    const missingFonts = await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'error').map((f) => f.family));
    if (missingFonts.length) throw new Error(`template fonts failed to load: ${missingFonts.join(', ')}`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await page.screenshot({ path: outPath, type: 'png', fullPage: false, animations: 'disabled' });
    return {
      width: template.width * template.scale,
      height: template.height * template.scale,
      placeholder: reasons.length > 0,
      draftReasons: reasons,
      overflow,
    };
  } finally {
    await ctx.close();
  }
}
