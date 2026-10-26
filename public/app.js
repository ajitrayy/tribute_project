const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (t) => (t ? new Date(t).toLocaleString() : '–');

let status = null;
let currentPost = null;
let cropSel = null; // normalized {x,y,width,height} drawn on the source image

const activeTemplate = () => status?.templates.find((t) => t.id === status.active_template);

function markupHtml(text) {
  // Mirrors src/pipeline/template.js markupToHtml for the live preview.
  let out = '';
  let open = null;
  let last = 0;
  const t = String(text || '');
  for (const m of t.matchAll(/\[(\/?)(r|b)\]/g)) {
    out += esc(t.slice(last, m.index));
    last = m.index + m[0].length;
    if (!m[1] && !open) { out += `<span class="${m[2]}">`; open = m[2]; } else if (m[1] && open === m[2]) { out += '</span>'; open = null; }
  }
  out += esc(t.slice(last));
  if (open) out += '</span>';
  return out.replace(/\n/g, '<br>');
}
const stripMarkup = (t) => String(t || '').replace(/\[\/?(r|b)\]/g, '');

async function api(path, opts = {}) {
  const init = { ...opts, headers: { ...(opts.headers || {}) } };
  if (opts.json !== undefined) {
    init.body = JSON.stringify(opts.json);
    init.headers['content-type'] = 'application/json';
    init.method ||= 'POST';
  }
  const res = await fetch(path, init);
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(body?.error || body || `HTTP ${res.status}`);
  return body;
}

function banner(msg, isErr = false) {
  const b = $('#banner');
  b.hidden = !msg;
  b.textContent = msg || '';
  b.className = `banner${isErr ? ' err' : ''}`;
}

async function guarded(fn) {
  try {
    banner('');
    await fn();
  } catch (e) {
    banner(e.message, true);
  }
}

// ---------- tabs ----------
document.querySelectorAll('.tabs button').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab').forEach((t) => (t.hidden = t.id !== `tab-${b.dataset.tab}`));
    loaders[b.dataset.tab]?.();
  }),
);

// ---------- status / monitoring ----------
async function loadStatus() {
  status = await api('/api/status');
  const m = status.monitoring;
  $('#mon-dot').className = `dot ${m.paused ? 'off' : 'on'}`;
  $('#mon-text').textContent = `${m.paused ? 'Paused' : 'Monitoring'} · last check ${fmt(m.last_poll_at)}${m.poll_requested ? ' · check requested' : ''}`;
  if (document.activeElement !== $('#mon-interval')) $('#mon-interval').value = m.interval_minutes;
  $('#mon-toggle').textContent = m.paused ? 'Resume' : 'Pause';
  const v = status.verification || {};
  const chip = $('#mon-verified');
  if (!v.pages) {
    chip.textContent = 'No Facebook Pages added';
    chip.className = 'pill skipped';
  } else if (v.verified) {
    chip.textContent = `Facebook monitoring verified on ${v.verified}/${v.pages} Page(s)`;
    chip.className = 'pill ok';
  } else {
    chip.textContent = `Facebook monitoring UNVERIFIED (${v.readable || 0}/${v.pages} Page(s) readable, no real post processed yet)`;
    chip.className = 'pill needs_input';
  }
  chip.title = 'A Page is verified only after a real post detected on it has been processed into a poster.';
  const t = status.templates.find((x) => x.id === status.active_template);
  const warnings = [];
  if (!t || t.placeholder) warnings.push('The official IBN7 Bharat template is not installed yet - posters are rendered as DRAFTS on a placeholder layout and cannot be approved.');
  if (!status.logo) warnings.push('The official logo has not been uploaded (Branding & template).');
  if (status.extraction.provider !== 'anthropic') warnings.push('Automatic text extraction is off (no ANTHROPIC_API_KEY) - poster text must be typed in manually.');
  $('#notice').hidden = !warnings.length;
  $('#notice').textContent = warnings.join(' ');
}

$('#mon-toggle').addEventListener('click', () => guarded(async () => {
  await api('/api/monitoring', { json: { paused: !status.monitoring.paused } });
  await loadStatus();
}));
$('#mon-interval').addEventListener('change', (e) => guarded(async () => {
  await api('/api/monitoring', { json: { interval_minutes: Number(e.target.value) } });
  await loadStatus();
}));
$('#mon-poll').addEventListener('click', () => guarded(async () => {
  await api('/api/monitoring/poll-now', { json: {} });
  await loadStatus();
}));

// ---------- posters ----------
function thumbUrl(p) {
  if (p.latest_render_path) return `/media/${p.latest_render_path}`;
  if (p.source_image_path) return `/media/${p.source_image_path}`;
  return null;
}

async function loadPosters() {
  const params = new URLSearchParams({ status: $('#f-status').value, q: $('#f-q').value, limit: 120 });
  const { rows, total } = await api(`/api/posts?${params}`);
  $('#f-count').textContent = `${total} item(s)`;
  const statuses = status?.statuses || {};
  const imageRows = rows.filter((p) => !['skipped', 'baseline'].includes(p.status));
  const textRows = rows.filter((p) => ['skipped', 'baseline'].includes(p.status));
  $('#poster-grid').innerHTML = imageRows.map((p) => {
    const t = thumbUrl(p);
    return `<div class="poster" data-id="${p.id}">
      <div class="thumb">${t ? `<img loading="lazy" src="${esc(t)}" alt="">` : esc(p.status)}</div>
      <div class="meta">
        <span class="pill ${esc(p.status)}" title="${esc(statuses[p.status] || '')}">${esc(p.status.replace('_', ' '))}</span>
        <div class="headline">${esc(p.fields?.headline || p.status_reason || '')}</div>
        <span class="muted">${esc(p.page_name || (p.source === 'manual' ? 'Manual import' : ''))} · ${fmt(p.posted_at || p.discovered_at)}</span>
      </div></div>`;
  }).join('') || (textRows.length ? '' : '<p class="muted">Nothing here yet.</p>');
  $('#history-table').innerHTML = textRows.length
    ? `<h3>Not processed</h3><table class="table"><tr><th>Posted</th><th>Page</th><th>Status</th><th>Reason</th><th>Link</th></tr>${textRows.map((p) => `<tr>
        <td>${fmt(p.posted_at)}</td><td>${esc(p.page_name || '')}</td><td><span class="pill ${esc(p.status)}">${esc(p.status)}</span></td>
        <td>${esc(p.status_reason || statuses[p.status] || '')}</td><td>${p.source_url ? `<a href="${esc(p.source_url)}" target="_blank" rel="noopener">open</a>` : ''}</td></tr>`).join('')}</table>`
    : '';
  document.querySelectorAll('.poster').forEach((el) => el.addEventListener('click', () => openPost(el.dataset.id)));
}
$('#f-status').addEventListener('change', () => guarded(loadPosters));
$('#f-q').addEventListener('input', debounce(() => guarded(loadPosters), 300));
$('#rerender-all').addEventListener('click', () => guarded(async () => {
  const r = await api('/api/posts/rerender', { json: {} });
  banner(`${r.queued} poster(s) queued for re-rendering.`);
  await loadPosters();
}));

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

// ---------- poster detail ----------
async function openPost(id) {
  await guarded(async () => {
    currentPost = await api(`/api/posts/${id}`);
    renderDetail();
    if (!$('#detail').open) $('#detail').showModal();
  });
}

function renderDetail() {
  const p = currentPost;
  const latest = p.renders[0];
  $('#d-title').innerHTML = `#${p.id} <span class="pill ${esc(p.status)}">${esc(p.status.replace('_', ' '))}</span>`;
  $('#d-version').textContent = latest ? `v${latest.version} · ${latest.template_id}${latest.placeholder ? ' · DRAFT' : ''}` : '';
  $('#d-generated').innerHTML = latest
    ? `<img src="/media/${esc(latest.path)}" alt="Generated poster">`
    : `<p class="muted">${esc(p.status_reason || 'Not generated yet.')}</p>`;
  $('#d-download').href = latest ? `/api/posts/${p.id}/download` : '#';
  $('#d-download').toggleAttribute('hidden', !latest);
  const approved = p.status === 'approved';
  $('#d-approve').textContent = approved ? 'Unapprove' : 'Approve';
  $('#d-approve').disabled = !approved && (p.status !== 'ready' || !latest || latest.placeholder === 1);
  $('#d-approve').title = latest?.placeholder ? 'Drafts (placeholder template or missing logo) cannot be approved' : '';
  $('#d-force').hidden = !['duplicate', 'skipped'].includes(p.status);

  const warnings = p.fact_check?.warnings || [];
  const reason = p.status_reason && !['ready', 'approved'].includes(p.status) ? [{ level: p.status === 'failed' ? 'error' : 'info', message: p.status_reason }] : [];
  $('#d-warnings').innerHTML = [...reason, ...warnings].length
    ? `<ul class="warn-list">${[...reason, ...warnings].map((w) => `<li class="${esc(w.level)}">${esc(w.message)}</li>`).join('')}</ul>`
    : '<p class="muted">Fact check: no differences from the source transcription.</p>';

  if ($('#d-source').dataset.src !== (p.source_image_path || '')) {
    $('#d-source').dataset.src = p.source_image_path || '';
    $('#d-source').innerHTML = p.source_image_path ? `<img src="/media/${esc(p.source_image_path)}" alt="Source poster" draggable="false"><div class="crop-box" hidden></div>` : '<p class="muted">No source image stored.</p>';
    cropSel = null;
    $('#d-crop').disabled = true;
    $('#d-crop-info').textContent = '';
  }
  $('#d-photo-preview').innerHTML = p.photo_url ? `<img src="${esc(p.photo_url)}" alt="">` : 'no photo';
  $('#d-photo-origin').textContent = { auto: 'cut automatically from the source poster', crop: 'cropped from the source poster', upload: 'uploaded by an editor' }[p.photo_origin] || '';
  const t = activeTemplate();
  const used = t?.fields || ['category_label', 'headline', 'subheadline', 'body_lines', 'location', 'date_text'];
  document.querySelectorAll('#d-form [data-field]').forEach((el) => {
    const k = el.dataset.field;
    el.hidden = !used.includes(k);
    if (t?.fieldLabels?.[k]) el.querySelector('span').textContent = t.fieldLabels[k];
  });
  const unusedWithText = Object.entries(p.fields || {}).filter(([k, v]) => !used.includes(k) && (Array.isArray(v) ? v.length : v));
  $('#d-unused').textContent = unusedWithText.length
    ? `Not printed by this template: ${unusedWithText.map(([k, v]) => `${k} = "${Array.isArray(v) ? v.join(' / ') : v}"`).join('; ')}`
    : '';
  $('#d-source-meta').innerHTML = [
    p.page_name ? esc(p.page_name) : p.source === 'manual' ? 'Manual import' : '',
    `posted ${fmt(p.posted_at)}`,
    p.source_url ? `<a href="${esc(p.source_url)}" target="_blank" rel="noopener">Open source post ↗</a>` : '',
    p.duplicate_of ? `duplicate of <a href="#" data-open="${p.duplicate_of}">#${p.duplicate_of}</a>` : '',
  ].filter(Boolean).join(' · ');
  $('#d-source-meta [data-open]')?.addEventListener('click', (e) => {
    e.preventDefault();
    openPost(e.target.dataset.open);
  });
  $('#d-caption').textContent = p.caption ? `Caption:\n${p.caption}` : 'No caption.';
  $('#d-fulltext').textContent = p.extraction?.full_text ? `Transcription (${p.extraction.model || ''}):\n${p.extraction.full_text}` : 'No machine transcription.';
  $('#d-versions').innerHTML = `<table class="table"><tr><th>Version</th><th>Template</th><th>Created</th><th></th></tr>${p.renders.map((r) => `<tr><td>v${r.version}${r.placeholder ? ' (draft)' : ''}</td><td>${esc(r.template_id)}</td><td>${fmt(r.created_at)}</td><td><a href="/api/posts/${p.id}/download?version=${r.version}">download</a></td></tr>`).join('')}</table>
    <table class="table"><tr><th>Job</th><th>Status</th><th>Attempts</th><th>Error</th></tr>${p.jobs.map((j) => `<tr><td>${esc(j.type)}</td><td>${esc(j.status)}</td><td>${j.attempts}/${j.max_attempts}</td><td>${esc(j.last_error || '')}</td></tr>`).join('')}</table>`;

  const f = p.fields || {};
  const form = $('#d-form');
  if (!form.contains(document.activeElement)) {
    for (const k of ['category_label', 'headline', 'subheadline', 'location', 'date_text']) form.elements[k].value = f[k] || '';
    form.elements.body_lines.value = (f.body_lines || []).join('\n');
    $('#d-headline-preview').innerHTML = markupHtml(form.elements.headline.value);
  }
}

$('#d-close').addEventListener('click', () => $('#detail').close());

// Headline colour markup: wrap the selection in [r]/[b], or strip tags for black.
document.querySelectorAll('.swatch').forEach((btn) => btn.addEventListener('click', () => {
  const ta = $('#d-form').elements.headline;
  const { selectionStart: a, selectionEnd: b, value } = ta;
  if (a === b) return;
  const sel = stripMarkup(value.slice(a, b));
  const c = btn.dataset.color;
  const wrapped = c ? `[${c}]${sel}[/${c}]` : sel;
  ta.value = value.slice(0, a) + wrapped + value.slice(b);
  ta.focus();
  ta.setSelectionRange(a, a + wrapped.length);
  $('#d-headline-preview').innerHTML = markupHtml(ta.value);
}));
$('#d-form').elements.headline.addEventListener('input', (e) => {
  $('#d-headline-preview').innerHTML = markupHtml(e.target.value);
});

// Drag a rectangle on the source image to choose the poster photo.
(() => {
  const host = $('#d-source');
  let start = null;
  const pos = (e) => {
    const img = host.querySelector('img');
    const r = img.getBoundingClientRect();
    return { img, r, x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const draw = () => {
    const box = host.querySelector('.crop-box');
    const img = host.querySelector('img');
    if (!box || !img || !cropSel) return;
    const hr = host.getBoundingClientRect();
    const r = img.getBoundingClientRect();
    Object.assign(box.style, {
      left: `${r.left - hr.left + cropSel.x * r.width}px`, top: `${r.top - hr.top + cropSel.y * r.height}px`,
      width: `${cropSel.width * r.width}px`, height: `${cropSel.height * r.height}px`,
    });
    box.hidden = false;
  };
  host.addEventListener('pointerdown', (e) => {
    if (e.target.tagName !== 'IMG') return;
    start = pos(e);
    host.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  host.addEventListener('pointermove', (e) => {
    if (!start) return;
    const p = pos(e);
    cropSel = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), width: Math.abs(p.x - start.x), height: Math.abs(p.y - start.y) };
    draw();
  });
  host.addEventListener('pointerup', () => {
    if (!start) return;
    start = null;
    const ok = cropSel && cropSel.width > 0.05 && cropSel.height > 0.05;
    $('#d-crop').disabled = !ok;
    $('#d-crop-info').textContent = ok ? `${Math.round(cropSel.width * 100)}% × ${Math.round(cropSel.height * 100)}% of the source selected` : '';
  });
})();
$('#d-crop').addEventListener('click', () => guarded(async () => {
  currentPost = await api(`/api/posts/${currentPost.id}/photo-crop`, { json: cropSel });
  $('#d-crop').disabled = true;
  renderDetail();
}));
$('#detail').addEventListener('close', () => {
  currentPost = null;
  loadPosters();
});
$('#d-form').addEventListener('submit', (e) => {
  e.preventDefault();
  guarded(async () => {
    const el = e.target.elements;
    const fields = {
      category_label: el.category_label.value, headline: el.headline.value, subheadline: el.subheadline.value,
      body_lines: el.body_lines.value.split('\n'), location: el.location.value, date_text: el.date_text.value,
    };
    currentPost = await api(`/api/posts/${currentPost.id}/fields`, { method: 'PUT', json: { fields } });
    document.activeElement.blur();
    renderDetail();
  });
});
$('#d-approve').addEventListener('click', () => guarded(async () => {
  const action = currentPost.status === 'approved' ? 'unapprove' : 'approve';
  currentPost = await api(`/api/posts/${currentPost.id}/${action}`, { json: {} });
  renderDetail();
}));
$('#d-regenerate').addEventListener('click', () => guarded(async () => {
  if (!confirm('Read the source poster again? Manual text edits will be replaced by the new transcription.')) return;
  currentPost = await api(`/api/posts/${currentPost.id}/regenerate`, { json: { reextract: true } });
  renderDetail();
}));
$('#d-force').addEventListener('click', () => guarded(async () => {
  currentPost = await api(`/api/posts/${currentPost.id}/regenerate`, { json: { reextract: true, force: true } });
  renderDetail();
}));
$('#d-photo').addEventListener('change', (e) => guarded(async () => {
  const fd = new FormData();
  fd.append('photo', e.target.files[0]);
  currentPost = await api(`/api/posts/${currentPost.id}/photo`, { method: 'POST', body: fd });
  e.target.value = '';
  renderDetail();
}));
$('#d-photo-remove').addEventListener('click', () => guarded(async () => {
  currentPost = await api(`/api/posts/${currentPost.id}/photo`, { method: 'DELETE' });
  renderDetail();
}));

// ---------- pages ----------
async function loadPages() {
  const pages = await api('/api/pages');
  const fb = status?.facebook || {};
  $('#fb-config').innerHTML = `<strong>Facebook credentials on the server:</strong>
    app id/secret ${fb.has_app ? '✔' : '✘'} · user/system-user token ${fb.has_user_token ? '✔' : '✘'} ·
    explicit Page tokens: ${fb.page_token_count ?? 0} · Page Public Content Access: ${fb.ppca_enabled ? 'enabled' : 'not enabled'} · Graph ${esc(fb.graph_version || '')}`;
  $('#pages-table').innerHTML = `<tr><th>Page</th><th>Access</th><th>Monitoring verified</th><th>Last checked</th><th>Posters</th><th>Enabled</th><th></th></tr>${pages.map((p) => `<tr>
      <td><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name || p.identifier)}</a><br><span class="muted">${esc(p.fb_page_id || '')}</span></td>
      <td><span class="pill ${esc(p.access_status)}">${esc(p.access_status.replace('_', ' '))}</span> <span class="muted">${esc(p.access_method || '')}</span>${p.last_error ? `<br><span class="muted">${esc(p.last_error)}</span>` : ''}</td>
      <td>${p.verified_at ? `<span class="pill ok">verified</span><br><span class="muted">${fmt(p.verified_at)} · <a href="#" data-open="${p.verified_post_id}">post #${p.verified_post_id}</a></span>` : '<span class="pill needs_input">not yet</span><br><span class="muted">waiting for a real new post</span>'}</td>
      <td>${fmt(p.last_polled_at)}</td><td>${p.poster_count}</td>
      <td><input type="checkbox" data-enable="${p.id}" ${p.enabled ? 'checked' : ''}></td>
      <td class="row"><button class="secondary" data-check="${p.id}">Re-check access</button><button class="secondary" data-del="${p.id}">Remove</button></td></tr>`).join('')}`;
  document.querySelectorAll('#pages-table [data-open]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    openPost(a.dataset.open);
  }));
  document.querySelectorAll('[data-enable]').forEach((el) => el.addEventListener('change', () => guarded(async () => {
    await api(`/api/pages/${el.dataset.enable}`, { method: 'PATCH', json: { enabled: el.checked } });
  })));
  document.querySelectorAll('[data-check]').forEach((el) => el.addEventListener('click', () => guarded(async () => {
    el.disabled = true;
    await api(`/api/pages/${el.dataset.check}/check`, { json: {} });
    await loadPages();
  })));
  document.querySelectorAll('[data-del]').forEach((el) => el.addEventListener('click', () => guarded(async () => {
    if (!confirm('Stop monitoring this Page? Its processed posts stay in history.')) return;
    await api(`/api/pages/${el.dataset.del}`, { method: 'DELETE' });
    await loadPages();
  })));
}
$('#page-form').addEventListener('submit', (e) => {
  e.preventDefault();
  guarded(async () => {
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      const page = await api('/api/pages', { json: { url: $('#page-url').value, backfill_hours: Number($('#page-backfill').value) } });
      $('#page-url').value = '';
      if (page.access_status !== 'ok') banner(`Page saved, but it cannot be read yet: ${page.last_error || page.access_status}`, true);
    } finally {
      btn.disabled = false;
    }
    await loadPages();
  });
});

// ---------- import ----------
$('#import-form').addEventListener('submit', (e) => {
  e.preventDefault();
  guarded(async () => {
    const post = await api('/api/import', { method: 'POST', body: new FormData(e.target) });
    e.target.reset();
    document.querySelector('[data-tab=posters]').click();
    openPost(post.id);
  });
});

// ---------- branding ----------
async function loadBranding() {
  await loadStatus();
  $('#logo-preview').innerHTML = status.logo ? `<img src="${esc(status.logo.url)}" alt="Logo">` : '<span class="muted">No logo</span>';
  $('#template-select').innerHTML = status.templates.map((t) => `<option value="${esc(t.id)}" ${t.id === status.active_template ? 'selected' : ''}>${esc(t.name)} (${t.width}×${t.height})</option>`).join('');
  const t = status.templates.find((x) => x.id === status.active_template);
  $('#template-note').textContent = t?.placeholder ? 'This is a placeholder layout. Output is marked DRAFT until the official template is installed (docs/TEMPLATE.md).' : '';
  $('#references').innerHTML = (t?.references || []).map((r) => `<img src="/templates/${esc(t.id)}/reference/${esc(r)}" alt="${esc(r)}">`).join('') || '<p class="muted">No reference posters in this template\'s reference/ folder.</p>';
}
$('#logo-form').addEventListener('submit', (e) => {
  e.preventDefault();
  guarded(async () => {
    const r = await api('/api/logo', { method: 'POST', body: new FormData(e.target) });
    e.target.reset();
    await loadBranding();
    banner(`Logo saved (${r.format}, ${r.width}×${r.height}${r.has_alpha ? ', transparent' : ''}). Use "Re-render all" on the Posters tab to apply it to posters awaiting review.`);
  });
});
$('#template-save').addEventListener('click', () => guarded(async () => {
  await api('/api/template', { json: { id: $('#template-select').value } });
  await loadBranding();
}));

// ---------- logs ----------
async function loadLogs() {
  const rows = await api(`/api/logs?level=${$('#log-level').value}`);
  $('#logs-table').innerHTML = `<tr><th>Time</th><th>Level</th><th>Scope</th><th>Message</th></tr>${rows.map((l) => `<tr>
    <td>${fmt(l.ts)}</td><td><span class="pill ${l.level === 'error' ? 'failed' : l.level === 'warn' ? 'needs_input' : ''}">${esc(l.level)}</span></td>
    <td>${esc(l.scope)}${l.post_id ? ` <a href="#" data-open="${l.post_id}">#${l.post_id}</a>` : ''}</td>
    <td>${esc(l.message)}${l.detail ? `<details><summary>detail</summary><pre>${esc(l.detail)}</pre></details>` : ''}</td></tr>`).join('')}`;
  document.querySelectorAll('#logs-table [data-open]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    openPost(a.dataset.open);
  }));
}
$('#log-level').addEventListener('change', () => guarded(loadLogs));
$('#log-refresh').addEventListener('click', () => guarded(loadLogs));

const loaders = { posters: loadPosters, pages: loadPages, branding: loadBranding, logs: loadLogs };

// ---------- refresh loop ----------
async function refresh() {
  await guarded(loadStatus);
  const active = document.querySelector('.tabs button.active').dataset.tab;
  if (active === 'posters' && !$('#detail').open) await guarded(loadPosters);
  if (currentPost && ['queued', 'processing'].includes(currentPost.status)) {
    currentPost = await api(`/api/posts/${currentPost.id}`).catch(() => currentPost);
    renderDetail();
  }
}
await refresh();
setInterval(refresh, 4000);
