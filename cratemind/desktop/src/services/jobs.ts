// Background job bookkeeping + a promise-retaining runner. Port of
// backend/app/jobs/worker.py's job-row lifecycle, minus the threading (Deno
// is single-threaded; "background" here just means an un-awaited async fn).
//
// runJob() flips status to "running" synchronously before returning, then
// guarantees a terminal status (done|error) via try/finally — a job can
// never be left stuck at "running" even if the caller never awaits the
// returned promise, because the promise is retained in `activeJobs` (cleared
// in `finally`) so its rejection is never silently swallowed.

import type { DatabaseSync } from "node:sqlite";
import { bindable } from "../utils/http.ts";
import { nowIso } from "../utils/time.ts";
import type { JobRow } from "../types/models.ts";

/** Retains in-flight job promises so a fire-and-forget runJob() call's
 * eventual failure is never silently lost. Keyed by job id, cleared once the
 * job reaches a terminal state. */
const activeJobs = new Map<number, Promise<void>>();

export function createJob(db: DatabaseSync, kind: string): JobRow {
  const now = nowIso();
  const result = db
    .prepare(
      `INSERT INTO jobs (kind, status, total, processed, message, error, created_at, updated_at)
       VALUES (?, 'pending', 0, 0, NULL, NULL, ?, ?)`,
    )
    .run(kind, now, now);
  const id = Number(result.lastInsertRowid);
  const job = getJob(db, id);
  if (job === null) {
    throw new Error(`createJob: failed to read back job ${id}`);
  }
  return job;
}

export function getJob(db: DatabaseSync, id: number): JobRow | null {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
  return row ?? null;
}

/** Most recent jobs first (mirrors backend/app/api/scan.py's ORDER BY id DESC). */
export function listJobs(db: DatabaseSync, limit = 50): JobRow[] {
  return db.prepare("SELECT * FROM jobs ORDER BY id DESC LIMIT ?").all(limit) as unknown as JobRow[];
}

export interface JobUpdate {
  status?: string;
  total?: number;
  processed?: number;
  message?: string | null;
  error?: string | null;
}

export function updateJob(db: DatabaseSync, id: number, patch: JobUpdate): void {
  const fields: Record<string, unknown> = { ...patch, updated_at: nowIso() };
  const keys = Object.keys(fields);
  const setClause = keys.map((k) => `${k} = ?`).join(", ");
  db.prepare(`UPDATE jobs SET ${setClause} WHERE id = ?`).run(
    ...keys.map((k) => bindable(fields[k])),
    id,
  );
}

/** Runs `task`, tracking `job`'s status through running -> done|error.
 * Returns the in-flight promise (also retained internally) so callers may
 * either await it or let it run in the background. */
export function runJob(
  db: DatabaseSync,
  job: JobRow,
  task: () => Promise<{ message?: string } | void>,
): Promise<void> {
  updateJob(db, job.id, { status: "running" });

  const promise = (async () => {
    try {
      const result = await task();
      updateJob(db, job.id, {
        status: "done",
        message: result?.message ?? null,
        error: null,
      });
    } catch (e) {
      updateJob(db, job.id, {
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      activeJobs.delete(job.id);
    }
  })();

  activeJobs.set(job.id, promise);
  return promise;
}

/** Returns the in-flight promise for a running job, if any — lets callers
 * (e.g. tests, or a future shutdown hook) await a background job started via
 * runJob() without needing the original returned promise reference. */
export function getActiveJobPromise(id: number): Promise<void> | undefined {
  return activeJobs.get(id);
}
