// Exercises request construction and response handling against a fake fetch.
// This verifies our client logic only; it says nothing about whether a real
// Facebook Page is readable - use `npm run fb:check` for that.
import './env.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { GraphClient, GraphError, normalizePost } from '../src/facebook/graph.js';

function fakeFetch(routes, calls = []) {
  return async (url) => {
    const u = new URL(url);
    calls.push(u);
    const key = u.pathname.replace(/^\/v[\d.]+\//, '');
    const r = routes[key];
    const { status = 200, body = {}, headers = {} } = typeof r === 'function' ? r(u) : r || { status: 404, body: { error: { code: 803, message: 'not found' } } };
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  };
}

const opts = (extra) => ({ graphBase: 'https://graph.test', graphVersion: 'v23.0', appId: '1', appSecret: 's3cret', userToken: 'USER', pageTokens: {}, usePublicContentAccess: false, sleep: async () => {}, ...extra });

test('uses the managed Page token and sends appsecret_proof', async () => {
  const calls = [];
  const g = new GraphClient(opts({
    fetch: fakeFetch({
      'me/accounts': { body: { data: [{ id: '111', name: 'My Page', username: 'mypage', access_token: 'PAGE' }] } },
      mypage: { body: { id: '111', name: 'My Page', link: 'https://www.facebook.com/mypage' } },
    }, calls),
  }));
  const p = await g.resolvePage('mypage');
  assert.deepEqual([p.id, p.method, p.token], ['111', 'managed_page_token', 'PAGE']);
  const pageCall = calls.find((c) => c.pathname.endsWith('/mypage'));
  assert.equal(pageCall.searchParams.get('access_token'), 'PAGE');
  assert.equal(pageCall.searchParams.get('appsecret_proof'), crypto.createHmac('sha256', 's3cret').update('PAGE').digest('hex'));
});

test('unmanaged Page without PPCA is refused before calling the API', async () => {
  const calls = [];
  const g = new GraphClient(opts({ fetch: fakeFetch({ 'me/accounts': { body: { data: [] } } }, calls) }));
  await assert.rejects(g.resolvePage('someoneelse'), (e) => e instanceof GraphError && e.kind === 'permission');
  assert.equal(calls.filter((c) => c.pathname.endsWith('someoneelse')).length, 0);
});

test('with PPCA approved, falls back to the user token', async () => {
  const g = new GraphClient(opts({
    usePublicContentAccess: true,
    fetch: fakeFetch({ 'me/accounts': { body: { data: [] } }, publicpage: { body: { id: '222', name: 'Public' } } }),
  }));
  const p = await g.resolvePage('publicpage');
  assert.equal(p.method, 'user_token_ppca');
});

test('classifies Graph errors', async () => {
  const mk = (error, status = 400) => new GraphClient(opts({ pageTokens: { x: 'T' }, fetch: fakeFetch({ x: { status, body: { error } } }) }));
  const kind = async (error, status) => mk(error, status).resolvePage('x').catch((e) => e.kind);
  assert.equal(await kind({ code: 190, message: 'expired' }), 'token');
  assert.equal(await kind({ code: 10, message: 'needs PPCA' }), 'permission');
  assert.equal(await kind({ code: 100, error_subcode: 33, message: 'unsupported get' }), 'permission');
  assert.equal(await kind({ code: 4, message: 'rate' }), 'rate_limit');
  assert.equal(await kind({ code: 2, message: 'temp' }, 500), 'transient');
});

test('retries transient errors then succeeds', async () => {
  let n = 0;
  const g = new GraphClient(opts({
    pageTokens: { x: 'T' },
    fetch: fakeFetch({ x: () => (++n < 3 ? { status: 503, body: { error: { code: 2, message: 'down' } } } : { body: { id: '9', name: 'X' } }) }),
  }));
  assert.equal((await g.resolvePage('x')).id, '9');
  assert.equal(n, 3);
});

test('records rate-limit usage headers', async () => {
  const g = new GraphClient(opts({
    pageTokens: { x: 'T' },
    fetch: fakeFetch({ x: { body: { id: '9' }, headers: { 'x-app-usage': JSON.stringify({ call_count: 42, total_time: 91, total_cputime: 3 }) } } }),
  }));
  await g.resolvePage('x');
  assert.equal(g.lastUsagePct, 91);
});

test('normalizes photo, album, video and text posts', () => {
  const photo = normalizePost({
    id: '1_2', created_time: '2026-10-26T08:00:00+0000', message: 'cap', permalink_url: 'https://fb/p',
    attachments: { data: [{ type: 'photo', media_type: 'photo', target: { id: '77' }, media: { image: { src: 'https://cdn/a.jpg' } } }] },
  });
  assert.deepEqual(photo.images, [{ url: 'https://cdn/a.jpg', photoId: '77' }]);

  const album = normalizePost({
    id: '1_3', attachments: { data: [{ type: 'album', subattachments: { data: [
      { type: 'photo', target: { id: 'a' }, media: { image: { src: 'u1' } } },
      { type: 'video_autoplay', media: { image: { src: 'thumb' } } },
      { type: 'photo', target: { id: 'b' }, media: { image: { src: 'u2' } } },
    ] } }] },
  });
  assert.deepEqual(album.images.map((i) => i.url), ['u1', 'u2']);

  const video = normalizePost({ id: '1_4', attachments: { data: [{ type: 'video_inline', media: { image: { src: 'thumb' } } }] } });
  assert.equal(video.images.length, 0);
  const text = normalizePost({ id: '1_5', message: 'hello' });
  assert.equal(text.images.length, 0);
});
