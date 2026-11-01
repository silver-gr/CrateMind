import { useEffect, useState } from "react";
import { api } from "./api";
import type { BeatGridDto } from "./types";

/**
 * A deck's beat grid. `straight`: beat n is at anchor + n*period (n = 0 is a downbeat).
 * `list`: explicit beat times (gaps already filled); the beat at `downIndex` is a downbeat.
 * `estimated` grids come from BPM + entry cue, not from an import; `overridden` grids carry the user's downbeat (Set / ◀ ▶).
 */
export type BeatGrid =
  | { kind: "straight"; anchor: number; period: number; estimated: boolean; overridden: boolean }
  | { kind: "list"; times: number[]; downIndex: number; estimated: boolean; overridden: boolean };

export interface GridBeat { time: number; downbeat: boolean; bar: number | null }

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** Raw beats may skip beats; a gap is rounded to a whole number of beats and filled evenly. Returns times and the new index of `downIndex`. */
export function fillBeatGaps(beats: readonly number[], downIndex: number): { times: number[]; downIndex: number } {
  if (beats.length < 2) return { times: [...beats], downIndex: Math.max(0, downIndex) };
  const ref = median(beats.slice(1).map((t, i) => t - beats[i]).filter(g => g > 0));
  const times: number[] = [beats[0]];
  let mapped = downIndex === 0 ? 0 : -1;
  for (let i = 1; i < beats.length; i++) {
    const n = ref > 0 ? Math.max(1, Math.round((beats[i] - beats[i - 1]) / ref)) : 1;
    for (let k = 1; k < n; k++) times.push(beats[i - 1] + (beats[i] - beats[i - 1]) * k / n);
    times.push(beats[i]);
    if (i === downIndex) mapped = times.length - 1;
  }
  return { times, downIndex: mapped < 0 ? 0 : mapped };
}

/**
 * The imported grid when usable, otherwise the dim BPM + entry-cue estimate (null without a tempo).
 * `downbeatS` is the user's marked downbeat: on an imported grid it is snapped to the nearest beat (djay's beats never move),
 * on an estimate it is the phase reference itself. The downbeat chosen is the in-phase one nearest the original anchor.
 */
export function buildBeatGrid(dto: BeatGridDto | null, bpm: number | null | undefined, entryCueS: number | null | undefined, downbeatS?: number | null): BeatGrid | null {
  const d = downbeatS != null && Number.isFinite(downbeatS) ? downbeatS : null;
  if (dto && Number.isFinite(dto.bpm) && dto.bpm > 0) {
    if (dto.straight && dto.anchor_s != null && Number.isFinite(dto.anchor_s)) {
      const period = 60 / dto.bpm;
      const anchor = dto.anchor_s;
      return { kind: "straight", anchor: d == null ? anchor : shiftAnchor(anchor, anchor + Math.round((d - anchor) / period) * period, period), period, estimated: false, overridden: d != null };
    }
    if (!dto.straight && dto.beats && dto.beats.length >= 2) {
      const filled = fillBeatGaps(dto.beats, dto.first_downbeat_index ?? 0);
      let downIndex = filled.downIndex;
      if (d != null) {
        const j = nearestIndex(filled.times, d);
        downIndex = j + Math.round((downIndex - j) / 4) * 4;
        if (downIndex < 0) downIndex += 4;
      }
      return { kind: "list", times: filled.times, downIndex, estimated: false, overridden: d != null };
    }
  }
  if (bpm != null && Number.isFinite(bpm) && bpm > 0) {
    const anchor = entryCueS != null && Number.isFinite(entryCueS) ? entryCueS : 0;
    const period = 60 / bpm;
    return { kind: "straight", anchor: d == null ? anchor : shiftAnchor(anchor, d, period), period, estimated: true, overridden: d != null };
  }
  return null;
}

/** The downbeat (a multiple of 4 beats from `r`) nearest `anchor`, kept at or after 0:00. */
function shiftAnchor(anchor: number, r: number, period: number): number {
  const bar = 4 * period;
  const a = r + Math.round((anchor - r) / bar) * bar;
  return a < Math.min(0, anchor) - 1e-6 ? a + bar : a; // a djay anchor a few ms before 0:00 keeps its numbering
}

/** Index of the list beat closest to `t`. */
function nearestIndex(times: readonly number[], t: number): number {
  const hi = lowerBound(times, t);
  if (hi <= 0) return 0;
  if (hi >= times.length) return times.length - 1;
  return t - times[hi - 1] <= times[hi] - t ? hi - 1 : hi;
}

/**
 * The downbeat time to store for Set / ◀ / ▶. Set takes the playhead. ◀ ▶ start from the effective grid's downbeat nearest
 * the playhead and move one beat; out-of-range results wrap by 4 beats (same phase) so the stored value stays in [0, last beat / maxS].
 */
export function downbeatAfter(grid: BeatGrid, playheadS: number, op: "set" | "prev" | "next", maxS?: number | null): number {
  if (op === "set") return Math.max(0, maxS != null && Number.isFinite(maxS) ? Math.min(playheadS, maxS) : playheadS);
  const dir = op === "next" ? 1 : -1;
  if (grid.kind === "straight") {
    const bar = 4 * grid.period;
    let v = grid.anchor + Math.round((playheadS - grid.anchor) / bar) * bar + dir * grid.period;
    while (v < 0) v += bar;
    if (maxS != null && Number.isFinite(maxS)) while (v > maxS && v - bar >= 0) v -= bar;
    return v;
  }
  const { times, downIndex } = grid;
  const j = nearestIndex(times, playheadS);
  const base = downIndex + Math.round((j - downIndex) / 4) * 4;
  let best = base;
  for (const c of [base - 4, base + 4]) {
    if (c >= 0 && c < times.length && (base < 0 || base >= times.length || Math.abs(times[c] - playheadS) < Math.abs(times[base] - playheadS))) best = c;
  }
  let i = best + dir;
  while (i < 0) i += 4;
  while (i > times.length - 1) i -= 4;
  return times[Math.max(0, i)];
}

const mod4 = (n: number) => ((n % 4) + 4) % 4;

/** Index of the first list beat at or after `t`. */
function lowerBound(times: readonly number[], t: number): number {
  let lo = 0, hi = times.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] < t) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Beats inside [t0, t1]; `bar` is the 1-based bar number on downbeats (null before bar 1). */
export function beatsInRange(grid: BeatGrid, t0: number, t1: number): GridBeat[] {
  const out: GridBeat[] = [];
  if (!(t1 >= t0)) return out;
  if (grid.kind === "straight") {
    for (let n = Math.ceil((t0 - grid.anchor) / grid.period); grid.anchor + n * grid.period <= t1; n++) {
      const downbeat = mod4(n) === 0;
      out.push({ time: grid.anchor + n * grid.period, downbeat, bar: downbeat && n >= 0 ? n / 4 + 1 : null });
    }
    return out;
  }
  for (let i = lowerBound(grid.times, t0); i < grid.times.length && grid.times[i] <= t1; i++) {
    const n = i - grid.downIndex;
    const downbeat = mod4(n) === 0;
    out.push({ time: grid.times[i], downbeat, bar: downbeat && n >= 0 ? n / 4 + 1 : null });
  }
  return out;
}

/** Position within the 4-beat bar (0..1) on an imported grid; -1 for estimates or out-of-range times (callers fall back to barPhase). */
export function gridBarPhase(grid: BeatGrid | null, t: number): number {
  if (!grid || (grid.estimated && !grid.overridden) || !Number.isFinite(t)) return -1;
  if (grid.kind === "straight") return mod4((t - grid.anchor) / grid.period) / 4;
  const { times, downIndex } = grid;
  if (t < times[0] || t > times[times.length - 1]) return -1;
  const i = Math.max(0, Math.min(times.length - 2, lowerBound(times, t) - 1));
  const frac = (t - times[i]) / (times[i + 1] - times[i]);
  return mod4(i - downIndex + frac) / 4;
}

const dtoCache = new Map<number, BeatGridDto | null>();

/** Forget cached grids so decks pick up an import/removal on their next load. */
export function clearBeatGridCache(): void { dtoCache.clear(); }

/** The stored beat grid for a track (null: none, or still loading). Found grids are cached per track id; a failed request counts as none. */
export function useBeatGridDto(trackId: number | null): BeatGridDto | null {
  const [state, setState] = useState<{ id: number; dto: BeatGridDto | null } | null>(null);
  useEffect(() => {
    if (trackId == null || dtoCache.has(trackId)) return;
    let active = true;
    api.getBeatGrid(trackId).catch(() => null).then(dto => {
      if (dto) dtoCache.set(trackId, dto); // a missing grid is re-asked on the next load (an import may add it)
      if (active) setState({ id: trackId, dto });
    });
    return () => { active = false; };
  }, [trackId]);
  if (trackId == null) return null;
  return dtoCache.get(trackId) ?? (state?.id === trackId ? state.dto : null);
}
