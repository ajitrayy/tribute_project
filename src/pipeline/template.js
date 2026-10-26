import fs from 'node:fs';
import path from 'node:path';
import Mustache from 'mustache';
import { config } from '../config.js';

const MIME = {
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
};

export function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

export function dataUri(file) {
  return `data:${mimeFor(file)};base64,${fs.readFileSync(file).toString('base64')}`;
}

export const ALL_FIELDS = ['category_label', 'headline', 'subheadline', 'body_lines', 'location', 'date_text'];

// Headline colour markup: [r]…[/r] red, [b]…[/b] blue, everything else the
// template's default colour. Kept deliberately tiny so editors can type it.
const MARKUP_TAG = /\[(\/?)(r|b)\]/g;

export function stripMarkup(s) {
  return String(s ?? '').replace(MARKUP_TAG, '');
}

// Newlines become line breaks so editors can match the reference line breaks.
const escapeHtml = (s) => Mustache.escape(String(s)).replace(/\n/g, '<br>');

export function markupToHtml(s) {
  let out = '';
  let open = null;
  let last = 0;
  const text = String(s ?? '');
  for (const m of text.matchAll(MARKUP_TAG)) {
    out += escapeHtml(text.slice(last, m.index));
    last = m.index + m[0].length;
    const [, closing, color] = m;
    if (!closing && !open) {
      out += `<span class="${color}">`;
      open = color;
    } else if (closing && open === color) {
      out += '</span>';
      open = null;
    }
    // Unbalanced or nested tags are dropped rather than rendered.
  }
  out += escapeHtml(text.slice(last));
  if (open) out += '</span>';
  return out;
}

export function listTemplates() {
  if (!fs.existsSync(config.templatesDir)) return [];
  return fs
    .readdirSync(config.templatesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(config.templatesDir, d.name, 'template.json')))
    .map((d) => {
      const t = loadTemplate(d.name);
      return { id: t.id, name: t.name, placeholder: t.placeholder, width: t.width, height: t.height, references: t.references, fields: t.fields, fieldLabels: t.fieldLabels };
    });
}

export function loadTemplate(id) {
  if (!/^[a-z0-9_-]+$/i.test(id)) throw new Error(`invalid template id "${id}"`);
  const dir = path.join(config.templatesDir, id);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'template.json'), 'utf8'));
  for (const k of ['width', 'height']) {
    if (!Number.isInteger(meta[k]) || meta[k] <= 0) throw new Error(`template ${id}: "${k}" must be a positive integer`);
  }
  const refDir = path.join(dir, 'reference');
  const references = fs.existsSync(refDir)
    ? fs.readdirSync(refDir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort()
    : [];
  return {
    id,
    dir,
    name: meta.name || id,
    placeholder: meta.placeholder === true,
    width: meta.width,
    height: meta.height,
    scale: meta.scale || 1,
    requiresLogo: meta.requiresLogo !== false,
    limits: meta.limits || {},
    // Fields this layout actually prints; the editor hides the rest and the
    // fact check only counts text that ends up on the poster.
    fields: Array.isArray(meta.fields) ? meta.fields.filter((f) => ALL_FIELDS.includes(f)) : ALL_FIELDS,
    fieldLabels: meta.fieldLabels || {},
    html: fs.readFileSync(path.join(dir, meta.html || 'template.html'), 'utf8'),
    references,
  };
}

/**
 * Produce the final HTML for a poster. `{{asset:relative/path}}` references are
 * inlined as data URIs (fonts, frames, textures shipped with the template) so the
 * render needs no network or file access; all text fields are HTML-escaped by
 * Mustache.
 */
export function buildHtml(template, fields, { logoPath, photoPath } = {}) {
  const withAssets = template.html.replace(/\{\{\s*asset:([^}\s]+)\s*\}\}/g, (_, rel) => {
    const file = path.resolve(template.dir, rel);
    if (!file.startsWith(template.dir + path.sep)) throw new Error(`asset outside template dir: ${rel}`);
    if (!fs.existsSync(file)) throw new Error(`template ${template.id}: missing asset ${rel}`);
    return dataUri(file);
  });
  const body = (fields.body_lines || []).filter((l) => String(l).trim());
  const view = {
    ...fields,
    headline: stripMarkup(fields.headline),
    headline_html: markupToHtml(fields.headline),
    body_lines: body,
    has_body: body.length > 0,
    logo_src: logoPath ? dataUri(logoPath) : '',
    has_logo: Boolean(logoPath),
    photo_src: photoPath ? dataUri(photoPath) : '',
    has_photo: Boolean(photoPath),
    width: template.width,
    height: template.height,
  };
  return Mustache.render(withAssets, view);
}
