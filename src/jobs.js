import { config } from './config.js';
import { getDb, now, tx } from './db.js';

export function enqueue(type, postId, { delaySec = 0, maxAttempts = config.worker.jobMaxAttempts, payload = null } = {}) {
  const d = getDb();
  // One open job per (type, post): re-requesting while queued just pulls it forward.
  const open = d
    .prepare("SELECT id FROM jobs WHERE type = ? AND post_id = ? AND status IN ('queued','running')")
    .get(type, postId);
  const runAfter = new Date(Date.now() + delaySec * 1000).toISOString();
  if (open) {
    d.prepare(
      "UPDATE jobs SET run_after = MIN(run_after, ?), payload = COALESCE(?, payload), updated_at = ? WHERE id = ? AND status = 'queued'",
    ).run(runAfter, payload ? JSON.stringify(payload) : null, now(), open.id);
    return open.id;
  }
  const r = d
    .prepare(
      'INSERT INTO jobs (type, post_id, payload, status, attempts, max_attempts, run_after, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)',
    )
    .run(type, postId, payload ? JSON.stringify(payload) : null, 'queued', maxAttempts, runAfter, now(), now());
  return Number(r.lastInsertRowid);
}

/** Atomically claim the next runnable job, or return null. */
export function claimNext() {
  return tx((d) => {
    const ts = now();
    const job = d
      .prepare("SELECT * FROM jobs WHERE status = 'queued' AND run_after <= ? ORDER BY run_after, id LIMIT 1")
      .get(ts);
    if (!job) return null;
    d.prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_at = ?, updated_at = ? WHERE id = ?").run(
      ts, ts, job.id,
    );
    return { ...job, payload: job.payload ? JSON.parse(job.payload) : {}, attempts: job.attempts + 1, status: 'running' };
  });
}

export function complete(jobId) {
  getDb().prepare("UPDATE jobs SET status = 'done', locked_at = NULL, last_error = NULL, updated_at = ? WHERE id = ?").run(now(), jobId);
}

/**
 * Record a failure. Retryable failures are rescheduled with exponential backoff
 * until max_attempts; returns true if the job will run again.
 */
export function fail(job, err, { retryable = true } = {}) {
  const msg = String(err?.message || err).slice(0, 2000);
  const willRetry = retryable && job.attempts < job.max_attempts;
  const delay = config.worker.jobBackoffBaseSec * 2 ** (job.attempts - 1);
  getDb()
    .prepare('UPDATE jobs SET status = ?, locked_at = NULL, last_error = ?, run_after = ?, updated_at = ? WHERE id = ?')
    .run(willRetry ? 'queued' : 'failed', msg, new Date(Date.now() + delay * 1000).toISOString(), now(), job.id);
  return willRetry;
}

/** Return jobs abandoned by a crashed worker to the queue. */
export function recoverStale() {
  const cutoff = new Date(Date.now() - config.worker.staleLockMin * 60_000).toISOString();
  return getDb()
    .prepare("UPDATE jobs SET status = 'queued', locked_at = NULL, updated_at = ? WHERE status = 'running' AND locked_at < ?")
    .run(now(), cutoff).changes;
}

export function jobsForPost(postId) {
  return getDb().prepare('SELECT * FROM jobs WHERE post_id = ? ORDER BY id DESC LIMIT 20').all(postId);
}

export function queueStats() {
  return getDb().prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all();
}
