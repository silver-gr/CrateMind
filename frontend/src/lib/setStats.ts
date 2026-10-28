import { camelotCode, formatKey, toCamelot } from "./camelot";
import type { Track } from "./types";

export function setKeyRuns(tracks: Pick<Track, "key_text" | "key_analyzed">[]) {
  const runs: { code: string | null; start: number; end: number }[] = [];
  tracks.forEach((track, index) => {
    const key = toCamelot(formatKey(track.key_text, track.key_analyzed));
    const code = key ? camelotCode(key) : null;
    const previous = runs[runs.length - 1];
    if (previous && previous.code === code) previous.end = index;
    else runs.push({ code, start: index, end: index });
  });
  return runs;
}

export function setKeyStats(tracks: Pick<Track, "key_text" | "key_analyzed">[]) {
  const keys = tracks.map(track => toCamelot(formatKey(track.key_text, track.key_analyzed)));
  const counts: Record<string, number> = {};
  const path: string[] = [];
  for (const key of keys) {
    if (!key) continue;
    const code = camelotCode(key);
    counts[code] = (counts[code] ?? 0) + 1;
    path.push(code);
  }
  const last = keys[keys.length - 1] ?? null;
  return { counts, path, distinct: Object.keys(counts).length, last, lastKey: last ? camelotCode(last) : null };
}

export function formatSetBpmRange(values: (number | null)[]): string {
  const bpms = values.filter((v): v is number => v != null && Number.isFinite(v) && v > 0);
  return bpms.length ? `${Math.round(Math.min(...bpms))}–${Math.round(Math.max(...bpms))}` : "—";
}
