// Minimal Facebook Graph API client for reading Page posts.
//
// Access paths, in the order they are tried for a Page:
//   1. An explicit Page access token from FB_PAGE_ACCESS_TOKENS.
//   2. A Page token obtained from /me/accounts with FB_USER_ACCESS_TOKEN, i.e. a
//      Page the token's user/system user has a task on (pages_read_engagement).
//   3. Only when FB_PPCA_APPROVED=true: the user token or app token, which can read
//      public Pages the business does not manage once Meta has approved the app for
//      the "Page Public Content Access" feature.
// No other access method (scraping, logged-in browser sessions) is used.

import crypto from 'node:crypto';
import { config } from '../config.js';

export class GraphError extends Error {
  constructor(message, { code, subcode, status, type, fbtraceId, kind } = {}) {
    super(message);
    this.code = code;
    this.subcode = subcode;
    this.status = status;
    this.type = type;
    this.fbtraceId = fbtraceId;
    // kind: token | permission | rate_limit | transient | not_found | other
    this.kind = kind || 'other';
  }
  get retryable() {
    return this.kind === 'rate_limit' || this.kind === 'transient';
  }
}

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80001, 80004, 80005, 80006]);

export function classifyGraphError(status, err = {}) {
  const code = err.code;
  const sub = err.error_subcode;
  if (code === 190 || code === 102 || code === 463 || code === 467) return 'token';
  if (RATE_LIMIT_CODES.has(code)) return 'rate_limit';
  if (code === 10 || (code >= 200 && code < 300)) return 'permission';
  // "Unsupported get request. Object with ID 'x' does not exist, cannot be loaded due to
  // missing permissions, or does not support this operation" - Graph cannot tell which.
  if (code === 100 && sub === 33) return 'permission';
  if (code === 803) return 'not_found';
  if (code === 1 || code === 2 || status >= 500) return 'transient';
  return 'other';
}

const POST_FIELDS = [
  'id', 'created_time', 'message', 'permalink_url', 'full_picture', 'status_type',
  'attachments{type,media_type,url,target{id},media,subattachments.limit(20){type,media_type,url,target{id},media}}',
].join(',');

export class GraphClient {
  constructor(opts = {}) {
    const fb = { ...config.facebook, ...opts };
    this.base = `${fb.graphBase.replace(/\/$/, '')}/${fb.graphVersion}`;
    this.appId = fb.appId;
    this.appSecret = fb.appSecret;
    this.userToken = fb.userToken;
    this.pageTokens = fb.pageTokens || {};
    this.ppca = fb.usePublicContentAccess;
    this.fetch = opts.fetch || globalThis.fetch;
    this.sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.managedCache = null; // { at, pages: [{id,name,username,link,access_token}] }
    this.lastUsagePct = 0;
  }

  get appToken() {
    return this.appId && this.appSecret ? `${this.appId}|${this.appSecret}` : '';
  }

  proof(token) {
    if (!this.appSecret || !token || token === this.appToken) return null;
    return crypto.createHmac('sha256', this.appSecret).update(token).digest('hex');
  }

  async get(pathOrUrl, params = {}, token) {
    const url = pathOrUrl.startsWith('http') ? new URL(pathOrUrl) : new URL(`${this.base}/${pathOrUrl.replace(/^\//, '')}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    if (token) {
      url.searchParams.set('access_token', token);
      const p = this.proof(token);
      if (p) url.searchParams.set('appsecret_proof', p);
    }

    let lastErr;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let res;
      try {
        res = await this.fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
      } catch (e) {
        lastErr = new GraphError(`Network error calling Graph API: ${e.message}`, { kind: 'transient' });
        if (attempt < this.maxAttempts) await this.sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      this.recordUsage(res.headers);
      let body;
      try {
        body = await res.json();
      } catch {
        body = {};
      }
      if (res.ok && !body.error) return body;

      const e = body.error || {};
      const kind = classifyGraphError(res.status, e);
      lastErr = new GraphError(e.message || `Graph API HTTP ${res.status}`, {
        code: e.code, subcode: e.error_subcode, status: res.status, type: e.type, fbtraceId: e.fbtrace_id, kind,
      });
      // Rate limits are retried by the monitor on its next cycle, not hammered here.
      if (kind !== 'transient' || attempt === this.maxAttempts) throw lastErr;
      await this.sleep(1000 * 2 ** (attempt - 1));
    }
    throw lastErr;
  }

  recordUsage(headers) {
    let pct = 0;
    const read = (h) => {
      try {
        return h ? JSON.parse(h) : null;
      } catch {
        return null;
      }
    };
    const app = read(headers.get?.('x-app-usage'));
    if (app) pct = Math.max(pct, app.call_count || 0, app.total_cputime || 0, app.total_time || 0);
    const buc = read(headers.get?.('x-business-use-case-usage'));
    if (buc) {
      for (const entries of Object.values(buc)) {
        for (const u of entries || []) pct = Math.max(pct, u.call_count || 0, u.total_cputime || 0, u.total_time || 0);
      }
    }
    const page = read(headers.get?.('x-page-usage'));
    if (page) pct = Math.max(pct, page.call_count || 0, page.total_cputime || 0, page.total_time || 0);
    this.lastUsagePct = pct;
  }

  /** Pages the configured user/system-user token can manage, with their Page tokens. */
  async managedPages({ force = false } = {}) {
    if (!this.userToken) return [];
    if (!force && this.managedCache && Date.now() - this.managedCache.at < 30 * 60_000) return this.managedCache.pages;
    const pages = [];
    let next = null;
    let body = await this.get('me/accounts', { fields: 'id,name,username,link,access_token,tasks', limit: 100 }, this.userToken);
    for (;;) {
      pages.push(...(body.data || []));
      next = body.paging?.next;
      if (!next || pages.length > 1000) break;
      body = await this.get(next);
    }
    this.managedCache = { at: Date.now(), pages };
    return pages;
  }

  findManaged(pages, identifier) {
    const id = String(identifier).toLowerCase();
    return pages.find((p) => {
      if (p.id === identifier) return true;
      if (p.username && p.username.toLowerCase() === id) return true;
      if (p.link) {
        try {
          const seg = new URL(p.link).pathname.split('/').filter(Boolean)[0];
          if (seg && seg.toLowerCase() === id) return true;
        } catch { /* ignore malformed link */ }
      }
      return false;
    });
  }

  /**
   * Work out which token can read a Page. Returns { token, method } or throws a
   * GraphError(kind=permission) explaining what is missing.
   */
  async tokenFor(identifier, fbPageId) {
    const explicit = this.pageTokens[fbPageId] || this.pageTokens[identifier];
    if (explicit) return { token: explicit, method: 'page_token' };

    if (this.userToken) {
      const managed = this.findManaged(await this.managedPages(), fbPageId || identifier);
      if (managed?.access_token) return { token: managed.access_token, method: 'managed_page_token' };
    }
    if (this.ppca) {
      if (this.userToken) return { token: this.userToken, method: 'user_token_ppca' };
      if (this.appToken) return { token: this.appToken, method: 'app_token_ppca' };
    }
    throw new GraphError(
      'No authorized access to this Page. It is not a Page your token manages, and Page Public Content Access ' +
        'is not enabled (FB_PPCA_APPROVED). See docs/FACEBOOK_ACCESS.md for the supported options.',
      { kind: 'permission' },
    );
  }

  /** Resolve a URL identifier to { id, name, link, token, method }. */
  async resolvePage(identifier) {
    const { token, method } = await this.tokenFor(identifier);
    const page = await this.get(encodeURIComponent(identifier), { fields: 'id,name,link' }, token);
    // A token found by username may still need re-keying by numeric id for later lookups.
    return { id: page.id, name: page.name, link: page.link, token, method };
  }

  /** Latest posts on a Page, newest first, normalized. */
  async pagePosts(fbPageId, token, { since, limit = config.facebook.postsPerPoll } = {}) {
    const params = { fields: POST_FIELDS, limit };
    if (since) params.since = Math.floor(new Date(since).getTime() / 1000);
    const body = await this.get(`${fbPageId}/posts`, params, token);
    return (body.data || []).map(normalizePost);
  }

  /** Largest available rendition of a photo object, or null. */
  async bestPhotoUrl(photoId, token) {
    const body = await this.get(photoId, { fields: 'images' }, token);
    const imgs = (body.images || []).slice().sort((a, b) => b.width * b.height - a.width * a.height);
    return imgs[0]?.source || null;
  }

  /** Debug info for a token (requires app id + secret). */
  async debugToken(token) {
    if (!this.appToken) return null;
    const body = await this.get('debug_token', { input_token: token }, this.appToken);
    return body.data || null;
  }
}

export function normalizePost(p) {
  const images = [];
  const pushMedia = (a) => {
    const src = a?.media?.image?.src;
    const isPhoto = a?.type === 'photo' || a?.media_type === 'photo' || a?.type === 'cover_photo' || a?.type === 'profile_media';
    if (src && isPhoto) images.push({ url: src, photoId: a.target?.id || null });
  };
  for (const a of p.attachments?.data || []) {
    const subs = a.subattachments?.data;
    if (subs?.length) subs.forEach(pushMedia);
    else pushMedia(a);
  }
  // Some photo posts only expose full_picture.
  if (!images.length && p.full_picture && /photo/.test(p.status_type || '')) images.push({ url: p.full_picture, photoId: null });

  const types = (p.attachments?.data || []).map((a) => a.media_type || a.type).filter(Boolean);
  return {
    id: p.id,
    createdTime: p.created_time,
    message: p.message || '',
    permalinkUrl: p.permalink_url || `https://www.facebook.com/${p.id}`,
    statusType: p.status_type || null,
    attachmentTypes: types,
    images,
  };
}
