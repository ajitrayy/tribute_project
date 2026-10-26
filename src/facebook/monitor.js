import { getDb, now, setSetting } from '../db.js';
import { enqueue } from '../jobs.js';
import { log } from '../logger.js';
import { insertPost } from '../posts.js';
import { GraphError } from './graph.js';

const USAGE_STOP_PCT = 90;
const OVERLAP_MS = 2 * 60 * 60 * 1000; // re-read the last 2h each poll; source_key makes this idempotent

function setPage(id, patch) {
  const keys = Object.keys(patch);
  getDb()
    .prepare(`UPDATE pages SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map((k) => patch[k]), id);
}

function recordAccessError(page, e) {
  const status = e.kind === 'token' ? 'token_error' : e.kind === 'permission' || e.kind === 'not_found' ? 'no_access' : 'error';
  setPage(page.id, { access_status: status, last_error: e.message });
  log.warn('monitor', `${page.url}: ${e.message}`, { pageId: page.id, detail: { code: e.code, subcode: e.subcode, fbtrace_id: e.fbtraceId } });
}

/** Resolve the Page id and confirm a token can read it. Returns the updated page row or null. */
export async function checkPageAccess(graph, page) {
  try {
    const resolved = await graph.resolvePage(page.fb_page_id || page.identifier);
    // Make sure we can actually read posts, not just the Page object.
    await graph.pagePosts(resolved.id, resolved.token, { limit: 1 });
    setPage(page.id, {
      fb_page_id: resolved.id, name: resolved.name, access_status: 'ok', access_method: resolved.method, last_error: null,
    });
    return getDb().prepare('SELECT * FROM pages WHERE id = ?').get(page.id);
  } catch (e) {
    if (!(e instanceof GraphError)) throw e;
    recordAccessError(page, e);
    return null;
  }
}

/** Store new posts for one Page and queue the image posts. Returns counts. */
export async function pollPage(graph, page) {
  const counts = { seen: 0, queued: 0, skipped: 0, baseline: 0 };
  let p = page;
  if (!p.fb_page_id || p.access_status !== 'ok') {
    p = await checkPageAccess(graph, p);
    if (!p) return counts;
  }
  let posts;
  try {
    const { token } = await graph.tokenFor(p.identifier, p.fb_page_id);
    const since = p.last_polled_at
      ? new Date(Math.max(new Date(p.monitor_since).getTime(), new Date(p.last_polled_at).getTime() - OVERLAP_MS)).toISOString()
      : p.monitor_since;
    posts = await graph.pagePosts(p.fb_page_id, token, { since });
  } catch (e) {
    if (!(e instanceof GraphError)) throw e;
    if (e.kind === 'rate_limit' || e.kind === 'transient') {
      log.warn('monitor', `${p.url}: ${e.message} (will retry next cycle)`, { pageId: p.id });
    } else {
      recordAccessError(p, e);
    }
    throw e;
  }

  const monitorSince = new Date(p.monitor_since).getTime();
  for (const fp of posts) {
    counts.seen++;
    const base = {
      pageId: p.id, fbPostId: fp.id, sourceUrl: fp.permalinkUrl, caption: fp.message, postedAt: fp.createdTime,
    };
    if (new Date(fp.createdTime).getTime() < monitorSince) {
      if (insertPost({ ...base, sourceKey: `${fp.id}#0`, status: 'baseline', imageUrl: fp.images[0]?.url }).created) counts.baseline++;
      continue;
    }
    if (!fp.images.length) {
      const reason = `No image attachment (${fp.attachmentTypes.join(', ') || fp.statusType || 'text only'})`;
      if (insertPost({ ...base, sourceKey: `${fp.id}#0`, status: 'skipped', statusReason: reason }).created) counts.skipped++;
      continue;
    }
    fp.images.forEach((img, i) => {
      const r = insertPost({ ...base, imageIndex: i, sourceKey: `${fp.id}#${i}`, imageUrl: img.url, photoId: img.photoId, status: 'queued' });
      if (r.created) {
        enqueue('process', r.id);
        counts.queued++;
      }
    });
  }
  setPage(p.id, { last_polled_at: now(), last_error: null });
  return counts;
}

export async function pollAll(graph) {
  const pages = getDb().prepare('SELECT * FROM pages WHERE enabled = 1 ORDER BY id').all();
  const total = { pages: 0, seen: 0, queued: 0, skipped: 0, baseline: 0, errors: 0 };
  for (const page of pages) {
    if (graph.lastUsagePct >= USAGE_STOP_PCT) {
      log.warn('monitor', `Graph API usage at ${graph.lastUsagePct}% - stopping this cycle early to stay under rate limits`);
      break;
    }
    try {
      const c = await pollPage(graph, page);
      total.pages++;
      for (const k of ['seen', 'queued', 'skipped', 'baseline']) total[k] += c[k];
      if (c.queued) log.info('monitor', `${page.name || page.url}: ${c.queued} new poster(s) queued`, { pageId: page.id });
    } catch (e) {
      total.errors++;
      if (!(e instanceof GraphError)) log.error('monitor', `${page.url}: unexpected error`, { pageId: page.id, detail: e });
    }
  }
  setSetting('last_poll_at', now());
  return total;
}
