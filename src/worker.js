import { config } from './config.js';
import { getSetting, setSetting } from './db.js';
import { GraphClient } from './facebook/graph.js';
import { pollAll } from './facebook/monitor.js';
import { claimNext, complete, fail, recoverStale } from './jobs.js';
import { log } from './logger.js';
import { updatePost } from './posts.js';
import { PermanentError, processPost, renderStored } from './pipeline/process.js';
import { closeRenderer } from './pipeline/render.js';

export function pollDue(nowMs = Date.now()) {
  if (getSetting('poll_requested') === '1') return true;
  if (getSetting('monitoring_paused') === '1') return false;
  const last = getSetting('last_poll_at');
  const intervalMs = Math.max(1, Number(getSetting('poll_interval_minutes')) || 10) * 60_000;
  return !last || nowMs - new Date(last).getTime() >= intervalMs;
}

export async function runJob(job, graph) {
  try {
    if (job.type === 'process') await processPost(job.post_id, { graph, force: job.payload.force, reextract: job.payload.reextract });
    else if (job.type === 'render') await renderStored(job.post_id);
    else throw new PermanentError(`unknown job type ${job.type}`);
    complete(job.id);
  } catch (e) {
    const permanent = e instanceof PermanentError || e.retryable === false;
    const retry = fail(job, e, { retryable: !permanent });
    const where = { postId: job.post_id, detail: e };
    if (retry) {
      log.warn('worker', `job ${job.id} (${job.type}) attempt ${job.attempts}/${job.max_attempts} failed, will retry: ${e.message}`, where);
      updatePost(job.post_id, { status: 'queued', status_reason: `Retrying after error: ${e.message}` });
    } else {
      log.error('worker', `job ${job.id} (${job.type}) failed permanently: ${e.message}`, where);
      updatePost(job.post_id, { status: 'failed', status_reason: e.message });
    }
  }
}

export async function startWorker({ signal } = {}) {
  const graph = new GraphClient();
  log.info('worker', `worker started (extraction: ${config.extraction.provider}, tick ${config.worker.tickMs}ms)`);
  let stopping = false;
  signal?.addEventListener('abort', () => {
    stopping = true;
  });

  while (!stopping) {
    try {
      const recovered = recoverStale();
      if (recovered) log.warn('worker', `requeued ${recovered} stale job(s)`);

      if (pollDue()) {
        setSetting('poll_requested', '0');
        const r = await pollAll(graph);
        log.info('monitor', `poll complete: ${r.pages} page(s), ${r.seen} post(s) seen, ${r.queued} queued, ${r.errors} error(s)`);
      }

      // Drain ready jobs, but come back to check the poll schedule at least every minute.
      const until = Date.now() + 60_000;
      let job;
      while (!stopping && Date.now() < until && (job = claimNext())) await runJob(job, graph);
    } catch (e) {
      log.error('worker', `worker loop error: ${e.message}`, { detail: e });
    }
    await new Promise((r) => setTimeout(r, config.worker.tickMs));
  }
  await closeRenderer();
}
