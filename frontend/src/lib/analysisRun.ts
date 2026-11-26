import type { Job } from "./types";

// Seconds per track for a full re-analysis: an idle Mac, and the 2.68 s measured on a busy one (2026-11-26).
const IDLE_S_PER_TRACK = 1.6;
const BUSY_S_PER_TRACK = 2.7;

/** How long «Επανανάλυση» takes for `trackCount` tracks, in plain Greek ("περίπου 2 έως 3,5 ώρες"). */
export function reanalysisDuration(trackCount: number): string {
  const low = (trackCount * IDLE_S_PER_TRACK) / 60;
  const high = (trackCount * BUSY_S_PER_TRACK) / 60;
  if (high < 2) return "λίγα λεπτά";
  if (high < 90) return `περίπου ${Math.max(1, Math.round(low))} έως ${Math.round(high)} λεπτά`;
  const hours = (minutes: number) => (Math.round(minutes / 30) / 2).toLocaleString("el-GR");
  return `περίπου ${hours(low)} έως ${hours(high)} ώρες`;
}

/** A BPM/key analysis job that «Διακοπή» can stop. */
export function canStopAnalysis(job: Pick<Job, "kind" | "status"> | null): boolean {
  return job?.kind === "analyze" && job.status === "running";
}

/** Steps across every phase (first pass, grid, key, LUFS), not tracks: a full run counts about 3 per track. */
export function analysisProgress(job: Pick<Job, "processed" | "total">): string {
  return `${job.processed.toLocaleString("el-GR")} από ${(job.total ?? 0).toLocaleString("el-GR")} βήματα`;
}

/** A finished job that «Διακοπή» stopped (the worker's message), shown as stopped rather than as done. */
export const wasStopped = (job: Pick<Job, "status" | "message">): boolean =>
  job.status === "done" && (job.message ?? "").startsWith("Διακόπηκε");
