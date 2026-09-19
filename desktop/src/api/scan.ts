// Scan / fingerprint / duplicate-detection job endpoints. Port of
// backend/app/api/scan.py onto T5's job/scanner/fingerprint/duplicate
// services (src/services/{jobs,scanner,fingerprint,duplicateDetector}.ts).
//
// Deliberate divergence (see plan "Deliberate Divergences from Python"):
// POST /api/scan/analyze always returns 501 — Python's analyze job depends
// on librosa/scipy (audio_analysis.py), a DSP stack that isn't portable to
// Deno, so this route never becomes a real job here.
//
// Scope note: unlike worker.py's _run_scan, the scan job below does not
// trigger an artist-profile rebuild as a post-step — that stays a distinct,
// user-triggered action via POST /api/artists/rebuild (artists.ts), matching
// this task's contract (scan/start's spec doesn't call for it).

import type { AppContext, RouteDef } from "./dispatch.ts";
import { err, json, readJson } from "../utils/http.ts";
import { createJob, getJob, listJobs, runJob } from "../services/jobs.ts";
import { scanRoots } from "../services/scanner.ts";
import { fingerprintAll } from "../services/fingerprint.ts";
import { detectDuplicates } from "../services/duplicateDetector.ts";
import type { JobRow, ScanRequest } from "../types/models.ts";

/** Job row as of right after starting it. runJob() flips status to "running"
 * synchronously before returning (see jobs.ts's doc comment), so re-reading
 * here reflects that — the frontend receives an already-started job from a
 * /start-style POST, not a stale "pending" snapshot. */
function startedJobPayload(ctx: AppContext, jobId: number): JobRow {
  const job = getJob(ctx.db, jobId);
  if (job === null) {
    throw new Error(`job ${jobId} vanished immediately after creation`);
  }
  return job;
}

export function routes(): RouteDef[] {
  return [
    {
      method: "POST",
      pattern: new URLPattern({ pathname: "/api/scan/start" }),
      handler: async (req, _params, ctx) => {
        const body = await readJson<ScanRequest>(req);
        const roots =
          body.roots && body.roots.length > 0 ? body.roots : ctx.config.libraryRoots;
        if (!roots || roots.length === 0) {
          return err(400, "No library roots configured. Set CRATEMIND_LIBRARY_ROOTS.");
        }

        const job = createJob(ctx.db, "scan");
        runJob(ctx.db, job, async () => {
          const stats = await scanRoots(ctx.db, ctx.config, roots, job);
          return {
            message:
              `added ${stats.added}, updated ${stats.updated}, ` +
              `unchanged ${stats.unchanged}, missing ${stats.missing}`,
          };
        });
        return json(startedJobPayload(ctx, job.id));
      },
    },

    {
      method: "POST",
      pattern: new URLPattern({ pathname: "/api/scan/fingerprint" }),
      handler: (_req, _params, ctx) => {
        if (!ctx.config.fpcalcPath) {
          return err(400, "fpcalc/Chromaprint not found on PATH.");
        }
        const job = createJob(ctx.db, "fingerprint");
        runJob(ctx.db, job, async () => {
          const n = await fingerprintAll(ctx.db, ctx.config.fpcalcPath);
          return { message: `fingerprinted ${n}` };
        });
        return json(startedJobPayload(ctx, job.id));
      },
    },

    {
      method: "POST",
      pattern: new URLPattern({ pathname: "/api/scan/analyze" }),
      handler: () => err(501, "Not available in desktop build"),
    },

    {
      method: "POST",
      pattern: new URLPattern({ pathname: "/api/scan/duplicates" }),
      handler: (_req, _params, ctx) => {
        const job = createJob(ctx.db, "duplicate_scan");
        runJob(ctx.db, job, async () => {
          const result = detectDuplicates(ctx.db);
          return { message: `groups ${result.groups_created}` };
        });
        return json(startedJobPayload(ctx, job.id));
      },
    },

    {
      method: "GET",
      pattern: new URLPattern({ pathname: "/api/scan/status" }),
      handler: (req, _params, ctx) => {
        const url = new URL(req.url);
        const jobIdParam = url.searchParams.get("job_id");
        if (jobIdParam !== null) {
          const jobId = Number(jobIdParam);
          const job = Number.isFinite(jobId) ? getJob(ctx.db, jobId) : null;
          if (job === null) {
            return err(404, "job not found");
          }
          return json(job);
        }
        const latest = listJobs(ctx.db, 1);
        return json(latest[0] ?? null);
      },
    },
  ];
}
