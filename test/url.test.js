import './env.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PageUrlError, parsePageUrl } from '../src/facebook/url.js';

test('parses the common Page URL shapes', () => {
  const cases = {
    'https://www.facebook.com/ibn7bharat': 'ibn7bharat',
    'facebook.com/ibn7bharat/': 'ibn7bharat',
    'https://m.facebook.com/Some.Page?ref=bookmarks': 'Some.Page',
    'https://web.facebook.com/somepage/posts/pfbid0abc': 'somepage',
    'https://www.facebook.com/profile.php?id=100064123456789': '100064123456789',
    'https://www.facebook.com/people/Some-News/100089123456789/': '100089123456789',
    'https://www.facebook.com/pages/Old-Name/123456789012': '123456789012',
    'https://www.facebook.com/pg/legacy.page/posts/': 'legacy.page',
    'https://www.facebook.com/Some-Name-123456789012': '123456789012',
    'https://fb.com/shortname': 'shortname',
  };
  for (const [url, id] of Object.entries(cases)) assert.equal(parsePageUrl(url).identifier, id, url);
});

test('rejects URLs that are not Pages', () => {
  for (const url of [
    '', 'https://example.com/page', 'https://www.facebook.com/groups/123', 'https://www.facebook.com/share/abc123/',
    'https://www.facebook.com/watch/?v=1', 'https://www.facebook.com/profile.php', 'https://www.facebook.com/',
  ]) {
    assert.throws(() => parsePageUrl(url), PageUrlError, url);
  }
});

test('canonical URL', () => {
  assert.equal(parsePageUrl('m.facebook.com/abc').canonicalUrl, 'https://www.facebook.com/abc');
  assert.equal(parsePageUrl('https://facebook.com/profile.php?id=123456').canonicalUrl, 'https://www.facebook.com/profile.php?id=123456');
});
