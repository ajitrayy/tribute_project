// Reads the Hindi text off a source poster with a Claude vision model and
// returns it as structured fields. The model is asked to transcribe, never to
// rewrite, so names, places, dates and numbers survive verbatim; facts.js then
// checks the poster fields against the transcription.

import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';
import { config } from '../config.js';

export class ExtractionUnavailable extends Error {}
export class ExtractionError extends Error {
  constructor(message, { retryable = true } = {}) {
    super(message);
    this.retryable = retryable;
  }
}

const str = { type: 'string' };
const strList = { type: 'array', items: { type: 'string' } };

export const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'is_news_poster', 'not_news_reason', 'category_label', 'headline', 'subheadline', 'body_lines',
    'location', 'date_text', 'people', 'places', 'numbers', 'source_branding', 'full_text', 'uncertain',
  ],
  properties: {
    is_news_poster: { type: 'boolean' },
    not_news_reason: str,
    category_label: str,
    headline: str,
    subheadline: str,
    body_lines: strList,
    location: str,
    date_text: str,
    people: strList,
    places: strList,
    numbers: strList,
    source_branding: strList,
    full_text: str,
    uncertain: strList,
  },
};

const SYSTEM = `You transcribe Hindi news poster images for a newsroom. An editor will rebuild each poster in their own channel's design, so your transcription must be exact.

Rules:
- Copy text exactly as printed, in its original script. Do not translate, paraphrase, summarise, shorten or "improve" anything.
- Keep every name, place, date, time, amount and number exactly as written, including whether digits are Devanagari (०-९) or Western (0-9).
- Do not add facts that are not printed on the image. The post caption is given only to help you read unclear words; never copy facts from it into the fields.
- Separate the source outlet's own branding (channel name, logo text, social handles, website, "follow us", watermarks, anchor or reporter credit lines tied to that outlet) into source_branding, and keep it out of every other field except full_text.
- headline: the largest/most prominent news line. subheadline: a secondary line directly under or above it, else "". body_lines: any remaining news lines, in reading order, one entry per line or bullet.
- category_label: a strap such as "ब्रेकिंग न्यूज़" or "बड़ी खबर" if one is printed, else "".
- location and date_text: only if printed on the poster, else "".
- people, places, numbers: list each as it appears in the text (these are used to verify the rebuilt poster).
- full_text: every piece of text on the image in reading order, including branding.
- uncertain: words or numbers you could not read with confidence.
- If the image is not a news poster (advertisement, meme, greeting, photo without news text), set is_news_poster to false, explain briefly in not_news_reason, and leave the other fields empty.`;

let client;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

/** Claude accepts JPEG/PNG/GIF/WebP; normalize anything else and cap very large images. */
async function toSupportedImage(buffer) {
  const img = sharp(buffer, { failOn: 'none' });
  const meta = await img.metadata();
  const longEdge = Math.max(meta.width || 0, meta.height || 0);
  if (['jpeg', 'png', 'webp'].includes(meta.format) && longEdge <= 2000 && buffer.length < 4.5 * 1024 * 1024) {
    return { data: buffer, mediaType: `image/${meta.format}` };
  }
  const data = await img.resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  return { data, mediaType: 'image/png' };
}

export async function extractPoster(imageBuffer, { caption = '' } = {}) {
  if (config.extraction.provider !== 'anthropic') {
    throw new ExtractionUnavailable('Automatic extraction is off (EXTRACTION_PROVIDER=manual).');
  }
  const { data, mediaType } = await toSupportedImage(imageBuffer);
  const content = [
    { type: 'image', source: { type: 'base64', media_type: mediaType, data: data.toString('base64') } },
    {
      type: 'text',
      text: caption
        ? `Post caption (context only, do not copy facts from it):\n<caption>\n${caption.slice(0, 4000)}\n</caption>\n\nTranscribe the poster.`
        : 'Transcribe the poster.',
    },
  ];

  let res;
  try {
    res = await getClient().beta.messages.create({
      model: config.extraction.model,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      messages: [{ role: 'user', content }],
      output_config: {
        effort: config.extraction.effort,
        format: { type: 'json_schema', schema: EXTRACTION_SCHEMA },
      },
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      throw new ExtractionError(`Anthropic API rejected the credentials: ${e.message}`, { retryable: false });
    }
    if (e instanceof Anthropic.BadRequestError) {
      throw new ExtractionError(`Anthropic API rejected the request: ${e.message}`, { retryable: false });
    }
    if (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError || e instanceof Anthropic.APIConnectionError) {
      throw new ExtractionError(`Anthropic API temporarily unavailable: ${e.message}`, { retryable: true });
    }
    throw new ExtractionError(e.message, { retryable: true });
  }

  if (res.stop_reason === 'refusal') {
    throw new ExtractionError(`The model declined to transcribe this image (${res.stop_details?.category || 'no category'}).`, {
      retryable: false,
    });
  }
  if (res.stop_reason === 'max_tokens') throw new ExtractionError('Transcription was cut off (max_tokens).', { retryable: true });

  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ExtractionError('Model returned invalid JSON.', { retryable: true });
  }
  return { ...parsed, model: res.model, extracted_at: new Date().toISOString() };
}

/** The editable fields that feed the template, derived from an extraction. */
export function fieldsFromExtraction(x) {
  return {
    category_label: x?.category_label || '',
    headline: x?.headline || '',
    subheadline: x?.subheadline || '',
    body_lines: Array.isArray(x?.body_lines) ? x.body_lines.filter(Boolean) : [],
    location: x?.location || '',
    date_text: x?.date_text || '',
  };
}

export const EMPTY_FIELDS = fieldsFromExtraction(null);
