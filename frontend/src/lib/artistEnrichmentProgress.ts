import type { Job } from "./types";

/** Backend datetimes without an offset are UTC, regardless of the browser locale. */
export function jobCreatedAtMs(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction = "", offset = "Z"] = match;
  const calendar = new Date(Date.UTC(+year, +month - 1, +day, +hour, +minute, +second));
  if (calendar.getUTCFullYear() !== +year || calendar.getUTCMonth() !== +month - 1
    || calendar.getUTCDate() !== +day || calendar.getUTCHours() !== +hour
    || calendar.getUTCMinutes() !== +minute || calendar.getUTCSeconds() !== +second) return null;
  const parsed = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}${fraction.slice(0, 4)}${offset}`);
  return Number.isFinite(parsed) ? parsed : null;
}

export function currentResearchArtist(message?: string | null): string | null {
  // Only strip the final progress suffix; parentheses may be part of an artist's name.
  return message?.match(/^Έρευνα είδους:\s*(.+?)\s+\(\d+\/\d+\)\s*$/)?.[1].trim() || null;
}

export function artistEnrichmentProgress(job: Job, now = Date.now()) {
  const processed = Number.isFinite(job.processed) ? Math.max(0, Math.floor(job.processed)) : 0;
  const total = job.total !== undefined && Number.isFinite(job.total) && job.total > 0
    ? Math.floor(job.total) : null;
  const complete = job.status === "done" || (job.status === "error" && total !== null && processed >= total);
  const percent = complete ? 100 : total === null ? null
    : Math.min(99, Math.floor(Math.min(processed, total) / total * 100));
  const started = jobCreatedAtMs(job.created_at);
  const elapsed = started === null ? 0 : now - started;
  const remainingMinutes = job.status === "running" && total !== null && processed >= 2
    && processed < total && elapsed > 0 && Number.isFinite(elapsed)
    ? Math.max(1, Math.ceil(elapsed / processed * (total - processed) / 60_000)) : null;
  // The message can survive a completed artist's commit; validate its ordinal
  // against completed work so that a stale name is never called "now processing".
  const ordinal = job.message?.match(/\((\d+)\/\d+\)\s*$/);
  const artist = job.status === "running" && ordinal && Number(ordinal[1]) === processed + 1
    ? currentResearchArtist(job.message) : null;
  return { processed, total, percent, remainingMinutes, artist };
}
