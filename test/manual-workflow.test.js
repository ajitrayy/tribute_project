// The free workflow end to end through the API: no Facebook credentials, no
// paid AI. A dummy ANTHROPIC_API_KEY is set to prove its presence alone does
// not switch on paid extraction.
import './env.js';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import sharp from 'sharp';

process.env.ANTHROPIC_API_KEY = 'dummy-key-not-used';
delete process.env.EXTRACTION_PROVIDER;
const { config } = await import('../src/config.js');
const { openDb } = await import('../src/db.js');
const { GraphClient } = await import('../src/facebook/graph.js');
const { createApp } = await import('../src/server.js');
const { claimNext } = await import('../src/jobs.js');
const { runJob } = await import('../src/worker.js');
const { closeRenderer } = await import('../src/pipeline/render.js');

openDb();
let server, base;
const noNetwork = async () => { throw new Error('network must not be used'); };
const graph = new GraphClient({ graphBase: 'https://graph.invalid', userToken: '', pageTokens: {}, fetch: noNetwork });

before(async () => {
  server = createApp({ graph }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.close();
  await closeRenderer();
});

const api = async (path, { method = 'POST', json, form } = {}) => {
  const res = await fetch(base + path, {
    method, body: form || (json ? JSON.stringify(json) : undefined), headers: json ? { 'content-type': 'application/json' } : {},
  });
  return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
};
async function drainJobs() {
  let job;
  while ((job = claimNext())) await runJob(job, graph);
}

test('paid extraction stays off unless explicitly selected', async () => {
  assert.equal(config.extraction.provider, 'manual');
  const s = (await api('/api/status', { method: 'GET' })).body;
  assert.equal(s.extraction.provider, 'manual');
  assert.equal(s.facebook.configured, false);
  assert.equal(s.ocr.engine, 'tesseract.js');
});

test('OCR engine and Hindi/English data are served locally', async () => {
  for (const p of ['/vendor/tesseract/tesseract.min.js', '/vendor/tesseract/worker.min.js', '/vendor/tessdata/hin.traineddata.gz', '/vendor/tessdata/eng.traineddata.gz']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
  }
  assert.equal((await fetch(`${base}/vendor/tessdata/fra.traineddata.gz`)).status, 404);
});

test('upload poster -> OCR text -> edit -> 1080x1350 PNG, without any API keys', async () => {
  const poster = await sharp({ create: { width: 900, height: 1100, channels: 3, background: '#a00' } }).jpeg().toBuffer();
  const fd = new FormData();
  fd.append('image', new Blob([poster], { type: 'image/jpeg' }), 'fb-poster.jpg');
  fd.append('source_url', 'https://www.facebook.com/somepage/posts/1');
  const imp = await api('/api/import', { form: fd });
  assert.equal(imp.status, 201);
  const id = imp.body.id;

  await drainJobs();
  let post = (await api(`/api/posts/${id}`, { method: 'GET' })).body;
  assert.equal(post.status, 'needs_input');
  assert.match(post.status_reason, /OCR/);

  assert.equal((await api(`/api/posts/${id}/ocr`, { json: { full_text: '  ' } })).status, 400);
  const ocrText = 'वाराणसी में भीषण आग, 7 दुकानें जलकर राख\nदमकल की 4 गाड़ियाँ मौके पर\n@xyznews';
  post = (await api(`/api/posts/${id}/ocr`, { json: { full_text: ocrText, confidence: 71.6, branding: ['@xyznews'] } })).body;
  assert.equal(post.extraction.source, 'ocr');
  assert.equal(post.extraction.confidence, 72);

  // Editor corrects/colours the text; one number deliberately differs from the OCR text.
  const fields = { headline: '[b]वाराणसी[/b] में [r]भीषण आग[/r], 8 दुकानें जलकर राख', subheadline: 'दमकल की 4 गाड़ियाँ मौके पर', body_lines: [] };
  assert.equal((await api(`/api/posts/${id}/fields`, { method: 'PUT', json: { fields } })).status, 200);
  await drainJobs();
  post = (await api(`/api/posts/${id}`, { method: 'GET' })).body;
  assert.equal(post.status, 'ready');
  const msgs = post.fact_check.warnings.map((w) => `${w.level}: ${w.message}`);
  assert.ok(msgs.some((m) => m.startsWith('warn') && m.includes('"8"') && m.includes('OCR')), msgs.join('\n'));

  const png = await api(`/api/posts/${id}/download`, { method: 'GET' });
  assert.equal(png.status, 200);
  const meta = await sharp(png.body).metadata();
  assert.deepEqual([meta.width, meta.height, meta.format], [1080, 1350, 'png']);
});

test('manual typing works when there is no OCR result at all', async () => {
  const poster = await sharp({ create: { width: 600, height: 600, channels: 3, background: '#036' } }).png().toBuffer();
  const fd = new FormData();
  fd.append('image', new Blob([poster], { type: 'image/png' }), 'p.png');
  const id = (await api('/api/import', { form: fd })).body.id;
  await drainJobs();
  await api(`/api/posts/${id}/fields`, { method: 'PUT', json: { fields: { headline: 'पटना में बारिश का अलर्ट', subheadline: '', body_lines: [] } } });
  await drainJobs();
  const post = (await api(`/api/posts/${id}`, { method: 'GET' })).body;
  assert.equal(post.status, 'ready');
  assert.equal(post.renders[0].width, 1080);
  assert.equal(post.renders[0].height, 1350);
  assert.ok(post.fact_check.warnings.some((w) => /verify facts against the source poster manually/.test(w.message)));
});
