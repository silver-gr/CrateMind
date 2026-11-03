import { pollJob } from "./jobPolling";
import { tokenizeQuery } from "./queryGrammar";
import type { BpmUpdate, Job, Track } from "./types";

/** Window event dispatched when any BPM analysis job ends (dialog or Settings). */
export const ANALYSIS_FINISHED = "cratemind:analysis-finished";

const followedAnalysisJobs = new Set<number>();

/** Follow a running analyze or scan job to its end, outside any page's lifetime, and then
 * dispatch ANALYSIS_FINISHED once. A job already followed is not followed twice. */
export function followAnalysisJob(job: Pick<Job, "id" | "kind" | "status">, read: (jobId?: number) => Promise<Job | null>): void {
  if (job.kind !== "analyze" && job.kind !== "scan") return;
  if (job.status !== "pending" && job.status !== "running") return;
  if (followedAnalysisJobs.has(job.id)) return;
  followedAnalysisJobs.add(job.id);
  void pollJob({ jobId: job.id, read, onJob: () => {}, onConnection: () => {} }).then(() => {
    window.dispatchEvent(new Event(ANALYSIS_FINISHED));
  });
}

/** Window event dispatched after a manual «×½ / ×2» or reset: CustomEvent<BpmUpdatedDetail>. */
export const BPM_UPDATED = "cratemind:bpm-updated";
export type BpmFields = Pick<Track, "bpm_consensus" | "bpm_consensus_sources">;
export type BpmUpdatedDetail = { trackId: number; fields: BpmFields };
export type BpmFactor = 0.5 | 2;

export function applyBpmFields<T extends Track>(track: T, fields: BpmFields): T {
  return { ...track, bpm_consensus: fields.bpm_consensus, bpm_consensus_sources: fields.bpm_consensus_sources };
}

export function bpmFieldsOf(update: BpmUpdate): BpmFields {
  return { bpm_consensus: update.bpm_consensus, bpm_consensus_sources: update.bpm_consensus_sources };
}

export function notifyBpmUpdated(trackId: number, fields: BpmFields): void {
  window.dispatchEvent(new CustomEvent<BpmUpdatedDetail>(BPM_UPDATED, { detail: { trackId, fields } }));
}

/** Undo of a factor change: a manual old value comes back through the inverse factor, anything else through a reset. */
export function undoPlan(oldSource: string | null | undefined, factor: BpmFactor): { kind: "factor"; factor: BpmFactor } | { kind: "reset" } {
  return oldSource?.startsWith("manual:") ? { kind: "factor", factor: factor === 2 ? 0.5 : 2 } : { kind: "reset" };
}

const oneDecimal = (bpm: number | null | undefined) => (bpm == null ? "—" : String(Math.round(bpm * 10) / 10));
export function bpmChangeText(before: number | null | undefined, after: number | null | undefined): string {
  return `BPM ${oneDecimal(before)} → ${oneDecimal(after)}`;
}

/** A `bpm:` filter can drop or gain a track whose BPM just changed, so the list must reload. */
export function queryHasBpmFilter(query: string): boolean {
  return tokenizeQuery(query).some(token => token.field?.toLowerCase() === "bpm");
}

/** Button logic: one request at a time; a trigger while one is pending is ignored, a failure clears it.
 * A success stays locked for `cooldownMs`, so the second click of a double click never compounds
 * (a localhost request settles well inside a double-click gap). */
export function createOctaveController<A>({ send, onDone, onError, cooldownMs = 500 }: {
  send: (arg: A) => Promise<BpmUpdate>;
  onDone: (result: BpmUpdate, arg: A) => void;
  onError: (error: unknown, arg: A) => void;
  cooldownMs?: number;
}) {
  let pending = false;
  const release = () => {
    if (cooldownMs > 0) setTimeout(() => { pending = false; }, cooldownMs);
    else pending = false;
  };
  return {
    get pending() { return pending; },
    trigger(arg: A): boolean {
      if (pending) return false;
      pending = true;
      send(arg).then(
        result => { release(); onDone(result, arg); },
        error => { pending = false; onError(error, arg); },
      );
      return true;
    },
  };
}
