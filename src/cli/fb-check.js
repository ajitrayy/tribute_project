// Verifies Facebook access end to end against real Pages, without writing to the
// database:  npm run fb:check -- https://www.facebook.com/SomePage [more URLs]
//
// Prints which token type is configured, its scopes and expiry, the Pages it
// manages, and for each URL: whether it resolves, which access path is used,
// and what the latest posts look like (image vs non-image).

import { config } from '../config.js';
import { GraphClient, GraphError } from '../facebook/graph.js';
import { PageUrlError, parsePageUrl } from '../facebook/url.js';

const graph = new GraphClient();
const fb = config.facebook;
let failures = 0;

function line(label, value) {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

console.log('Configuration');
line('Graph API version', fb.graphVersion);
line('App id/secret', fb.appId && fb.appSecret ? 'set' : 'NOT SET (appsecret_proof and token debugging disabled)');
line('User/system token', fb.userToken ? 'set' : 'not set');
line('Explicit Page tokens', String(Object.keys(fb.pageTokens).length));
line('PPCA approved flag', String(fb.usePublicContentAccess));

if (fb.userToken && graph.appToken) {
  try {
    const d = await graph.debugToken(fb.userToken);
    console.log('\nUser/system token');
    line('valid', String(d.is_valid));
    line('type', d.type);
    line('app', `${d.application} (${d.app_id})`);
    line('expires', d.expires_at ? new Date(d.expires_at * 1000).toISOString() : 'never');
    line('scopes', (d.scopes || []).join(', ') || '(none)');
    const need = ['pages_show_list', 'pages_read_engagement'];
    const missing = need.filter((s) => !(d.scopes || []).includes(s));
    if (missing.length) line('MISSING scopes', missing.join(', '));
  } catch (e) {
    failures++;
    console.log(`\nToken debug failed: ${e.message}`);
  }
}

if (fb.userToken) {
  try {
    const pages = await graph.managedPages({ force: true });
    console.log(`\nPages this token manages (${pages.length})`);
    for (const p of pages) line(p.id, `${p.name}${p.username ? ` (@${p.username})` : ''}`);
  } catch (e) {
    failures++;
    console.log(`\nCould not list managed Pages: ${e.message}`);
  }
}

for (const url of process.argv.slice(2)) {
  console.log(`\n${url}`);
  try {
    const { identifier } = parsePageUrl(url);
    line('identifier', identifier);
    const page = await graph.resolvePage(identifier);
    line('resolved', `${page.name} (${page.id})`);
    line('access method', page.method);
    const posts = await graph.pagePosts(page.id, page.token, { limit: 5 });
    line('latest posts', String(posts.length));
    for (const p of posts) {
      const kind = p.images.length ? `${p.images.length} image(s)` : `no image (${p.attachmentTypes.join(',') || p.statusType || 'text'})`;
      console.log(`    ${p.createdTime}  ${kind}  ${p.permalinkUrl}`);
    }
    line('API usage', `${graph.lastUsagePct}%`);
    console.log('  RESULT                 OK - this Page can be monitored with the current credentials.');
  } catch (e) {
    failures++;
    if (e instanceof PageUrlError) line('RESULT', `invalid URL: ${e.message}`);
    else if (e instanceof GraphError) line('RESULT', `FAILED (${e.kind}, code ${e.code ?? '-'}): ${e.message}`);
    else line('RESULT', `FAILED: ${e.message}`);
  }
}

if (process.argv.length <= 2) console.log('\nPass one or more Page URLs to test them, e.g. npm run fb:check -- https://www.facebook.com/PageName');
process.exit(failures ? 1 : 0);
