import './env.js';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openDb } from '../src/db.js';
import { GraphClient } from '../src/facebook/graph.js';
import { createApp } from '../src/server.js';

openDb();
let server, base;
before(async () => {
  // No credentials configured: every Page should come back as no_access.
  const graph = new GraphClient({ graphBase: 'https://graph.test', userToken: '', pageTokens: {}, fetch: async () => { throw new Error('should not be called'); } });
  server = createApp({ graph }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const j = (path, body, method = 'POST') => fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('adding a Page without credentials explains the access problem', async () => {
  const res = await j('/api/pages', { url: 'https://www.facebook.com/somenewspage' });
  assert.equal(res.status, 201);
  const page = await res.json();
  assert.equal(page.access_status, 'no_access');
  assert.match(page.last_error, /Page Public Content Access/);
  assert.equal((await j('/api/pages', { url: 'facebook.com/somenewspage' })).status, 409);
  assert.equal((await j('/api/pages', { url: 'https://www.facebook.com/groups/1' })).status, 400);
});

test('monitoring controls', async () => {
  assert.equal((await j('/api/monitoring', { paused: true, interval_minutes: 15 })).status, 200);
  let s = await (await fetch(`${base}/api/status`)).json();
  assert.equal(s.monitoring.paused, true);
  assert.equal(s.monitoring.interval_minutes, 15);
  assert.equal((await j('/api/monitoring', { interval_minutes: 0 })).status, 400);
  await j('/api/monitoring', { paused: false });
  s = await (await fetch(`${base}/api/status`)).json();
  assert.equal(s.monitoring.paused, false);
});

test('manual import queues a post; drafts cannot be approved', async () => {
  const sharp = (await import('sharp')).default;
  const png = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#888' } }).png().toBuffer();
  const fd = new FormData();
  fd.append('image', new Blob([png], { type: 'image/png' }), 'p.png');
  fd.append('source_url', 'https://www.facebook.com/x/posts/1');
  const res = await fetch(`${base}/api/import`, { method: 'POST', body: fd });
  assert.equal(res.status, 201);
  const post = await res.json();
  assert.equal(post.status, 'queued');
  assert.equal(post.jobs[0].type, 'process');
  const appr = await j(`/api/posts/${post.id}/approve`, {});
  assert.equal(appr.status, 409);
});
