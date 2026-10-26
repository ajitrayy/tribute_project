// Turns Tesseract OCR lines into poster fields. Shared by the dashboard
// (browser) and the tests (Node), so it must stay dependency-free.
//
// Heuristics, tuned on Hindi news posters:
//  * the tallest lines are the headline (kept as separate lines, in order);
//  * a line starting with "-" / "–" is a quote attribution -> red box (subheadline);
//  * lines that look like handles, URLs or "follow us" text are the source
//    outlet's branding and are left off the poster;
//  * low-confidence lines without any Hindi are dropped as noise;
//  * everything else becomes body lines.
// OCR is never perfect: the editor always reviews these fields before rendering.

const BRANDING = /(@\w|www\.|https?:|\.com\b|\.in\b|\/\/|follow|subscribe|फ़?फॉलो|सब्सक्राइब|लाइक करें)/i;
const USEFUL = /[ऀ-ॿ0-9A-Za-z]/g;

export function cleanLine(text) {
  return String(text || '')
    .replace(/[|_~^`¦]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True if a line has enough real letters/digits to be text rather than noise. */
export function isText(text) {
  const t = cleanLine(text);
  const useful = (t.match(USEFUL) || []).length;
  return useful >= 2 && useful / Math.max(1, t.replace(/\s/g, '').length) >= 0.6;
}

/**
 * lines: [{ text, height, confidence }] in reading order (height in px of the
 * line's bounding box; confidence 0-100).
 */
export function ocrLinesToFields(lines, { minConfidence = 30, headlineRatio = 0.6 } = {}) {
  const kept = [];
  const branding = [];
  for (const l of lines || []) {
    const text = cleanLine(l.text);
    if (!text || !isText(text)) continue;
    if (BRANDING.test(text)) {
      branding.push(text);
      continue;
    }
    if ((l.confidence ?? 100) < minConfidence) continue;
    // Lines with no Hindi at all are usually noise read off photos or app chrome;
    // keep them only when OCR is confident (e.g. a genuine English line).
    if (!/[\u0900-\u097F]/.test(text) && (l.confidence ?? 100) < 70) continue;
    kept.push({ text, height: Number(l.height) || 0, confidence: l.confidence ?? 100 });
  }
  // Quote attribution: of the lines starting with a dash, the most confident one
  // that contains Hindi (OCR noise also produces short dash lines).
  const quote = kept
    .filter((l) => /^[-–—]\s*\S/.test(l.text) && /[\u0900-\u097F]{3}/.test(l.text))
    .sort((a, b) => b.confidence - a.confidence || b.text.length - a.text.length)[0];
  const rest = kept.filter((l) => l !== quote);
  const maxH = Math.max(0, ...rest.map((l) => l.height));
  const headline = [];
  const body = [];
  const subheadline = quote ? quote.text.replace(/^[–—]/, '-') : '';
  for (const l of rest) {
    if (maxH && l.height >= maxH * headlineRatio) headline.push(l.text);
    else body.push(l.text);
  }
  // Nothing tall enough (e.g. all lines similar): use the first line as headline.
  if (!headline.length && body.length) headline.push(body.shift());
  return {
    fields: { headline: headline.join('\n'), subheadline, body_lines: body },
    branding,
    fullText: (lines || []).map((l) => cleanLine(l.text)).filter(Boolean).join('\n'),
  };
}

// Two pixel transforms for two OCR passes. Tesseract.js reads colour posters
// poorly when given the RGB image directly, so both passes get greyscale:
//  * greyscale (luminance) suits white text on red boxes and dark text;
//  * "colour as ink" (darkest of R/G/B per pixel) turns red and blue headline
//    text into near-black ink on white.
// Both work in place on ImageData-like { data: RGBA array }.
export function toGreyscale(imageData) {
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v;
  }
  return imageData;
}

export function colourAsInk(imageData) {
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.min(d[i], d[i + 1], d[i + 2]);
    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v;
  }
  return imageData;
}

/** Of several tesseract results, keep the one with the highest mean confidence. */
export function bestResult(results) {
  return results.filter(Boolean).reduce((a, b) => ((b.confidence ?? 0) > (a?.confidence ?? -1) ? b : a), null);
}

/** Flatten tesseract.js `data.blocks` into [{ text, height, confidence }]. */
export function linesFromTesseract(data) {
  const out = [];
  for (const b of data?.blocks || []) {
    for (const p of b.paragraphs || []) {
      for (const l of p.lines || []) {
        out.push({ text: l.text, height: (l.bbox?.y1 ?? 0) - (l.bbox?.y0 ?? 0), confidence: l.confidence });
      }
    }
  }
  return out;
}

/**
 * Combine the two OCR passes: the more confident pass supplies the fields, and
 * if it found no quote line ("- name, post") the other pass may supply it -
 * the greyscale pass reads white-on-red boxes that the ink pass often misses.
 * Returns { fields, branding, text, confidence }.
 */
export function fieldsFromPasses(passes) {
  const results = (passes || []).filter(Boolean);
  const best = bestResult(results);
  if (!best) return { fields: { headline: '', subheadline: '', body_lines: [] }, branding: [], text: '', confidence: 0 };
  const main = ocrLinesToFields(linesFromTesseract(best));
  let text = String(best.text || '');
  if (!main.fields.subheadline) {
    for (const r of results) {
      if (r === best) continue;
      const sub = ocrLinesToFields(linesFromTesseract(r)).fields.subheadline;
      if (sub) {
        main.fields.subheadline = sub;
        text = `${text.trimEnd()}\n${sub}`;
        break;
      }
    }
  }
  return { fields: main.fields, branding: main.branding, text, confidence: best.confidence };
}
