import './env.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getDb, now, openDb } from '../src/db.js';
import { GraphClient } from '../src/facebook/graph.js';
import { pollPage } from '../src/facebook/monitor.js';
import { claimNext, enqueue, fail } from '../src/jobs.js';

openDb();

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace('Z', '+0000');
const photo = (id, src) => ({ type: 'photo', media_type: 'photo', target: { id }, media: { image: { src } } });

function graphWith(posts) {
  const fetch = async (url) => {
    const u = new URL(url);
    const body = u.pathname.endsWith('/posts') ? { data: posts } : { id: '555', name: 'Test Page' };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
  return new GraphClient({ graphBase: 'https://graph.test', pageTokens: { testpage: 'T', 555: 'T' }, fetch, sleep: async () => {} });
}

test('poll stores baseline/skipped posts, queues image posts once', async () => {
  const d = getDb();
  const since = new Date(Date.now() - 60 * 60_000).toISOString();
  const pageId = Number(d.prepare("INSERT INTO pages (url, identifier, monitor_since, created_at) VALUES ('https://www.facebook.com/testpage','testpage',?,?)").run(since, now()).lastInsertRowid);
  const posts = [
    { id: '555_1', created_time: iso(5 * 60_000), message: 'नई खबर', permalink_url: 'https://fb/1', attachments: { data: [photo('p1', 'https://cdn/1.jpg')] } },
    { id: '555_2', created_time: iso(10 * 60_000), message: 'text only' },
    { id: '555_3', created_time: iso(15 * 60_000), attachments: { data: [{ type: 'album', subattachments: { data: [photo('a', 'https://cdn/a.jpg'), photo('b', 'https://cdn/b.jpg')] } }] } },
    { id: '555_4', created_time: iso(3 * 60 * 60_000), attachments: { data: [photo('old', 'https://cdn/old.jpg')] } },
  ];
  const page = d.prepare('SELECT * FROM pages WHERE id = ?').get(pageId);
  const c1 = await pollPage(graphWith(posts), page);
  assert.deepEqual(c1, { seen: 4, queued: 3, skipped: 1, baseline: 1 });

  const rows = d.prepare('SELECT source_key, status, fb_photo_id FROM posts ORDER BY source_key').all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { source_key: '555_1#0', status: 'queued', fb_photo_id: 'p1' },
    { source_key: '555_2#0', status: 'skipped', fb_photo_id: null },
    { source_key: '555_3#0', status: 'queued', fb_photo_id: 'a' },
    { source_key: '555_3#1', status: 'queued', fb_photo_id: 'b' },
    { source_key: '555_4#0', status: 'baseline', fb_photo_id: null },
  ]);
  assert.equal(d.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = 'process'").get().n, 3);

  // Second poll returns the same posts: nothing new is created or queued.
  const c2 = await pollPage(graphWith(posts), d.prepare('SELECT * FROM pages WHERE id = ?').get(pageId));
  assert.equal(c2.queued, 0);
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM posts').get().n, 5);
  assert.equal(d.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = 'process'").get().n, 3);
  assert.equal(d.prepare('SELECT access_status FROM pages WHERE id = ?').get(pageId).access_status, 'ok');
});

test('jobs retry with backoff up to max attempts', () => {
  const d = getDb();
  d.exec("DELETE FROM jobs");
  const postId = d.prepare('SELECT id FROM posts LIMIT 1').get().id;
  enqueue('render', postId, { maxAttempts: 2 });
  enqueue('render', postId, { maxAttempts: 2 }); // deduplicated while open
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 1);

  let job = claimNext();
  assert.equal(job.attempts, 1);
  assert.equal(claimNext(), null); // running jobs are not handed out twice
  assert.equal(fail(job, new Error('boom')), true);
  job = claimNext();
  assert.equal(job.attempts, 2);
  assert.equal(fail(job, new Error('boom again')), false);
  assert.equal(d.prepare('SELECT status, last_error FROM jobs').get().status, 'failed');

  enqueue('render', postId);
  job = claimNext();
  assert.equal(fail(job, new Error('bad input'), { retryable: false }), false);
});
