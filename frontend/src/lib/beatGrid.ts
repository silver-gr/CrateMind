import { useEffect, useState } from "react";
import { api } from "./api";
import type { BeatGridDto } from "./types";

/**
 * A deck's beat grid. `straight`: beat n is at anchor + n*period (n = 0 is a downbeat).
 * `list`: explicit beat times (gaps already filled); the beat at `downIndex` is a downbeat.
 * `estimated` grids come from BPM + entry cue, not from an import.
 */
export type BeatGrid =
  | { kind: "straight"; anchor: number; period: number; estimated: boolean }
  | { kind: "list"; times: number[]; downIndex: number; estimated: boolean };

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

/** The imported grid when usable, otherwise the dim BPM + entry-cue estimate (null without a tempo). */
export function buildBeatGrid(dto: BeatGridDto | null, bpm: number | null | undefined, entryCueS: number | null | undefined): BeatGrid | null {
  if (dto && Number.isFinite(dto.bpm) && dto.bpm > 0) {
    if (dto.straight && dto.anchor_s != null && Number.isFinite(dto.anchor_s)) {
      return { kind: "straight", anchor: dto.anchor_s, period: 60 / dto.bpm, estimated: false };
    }
    if (!dto.straight && dto.beats && dto.beats.length >= 2) {
      const filled = fillBeatGaps(dto.beats, dto.first_downbeat_index ?? 0);
      return { kind: "list", times: filled.times, downIndex: filled.downIndex, estimated: false };
    }
  }
  if (bpm != null && Number.isFinite(bpm) && bpm > 0) {
    return { kind: "straight", anchor: entryCueS != null && Number.isFinite(entryCueS) ? entryCueS : 0, period: 60 / bpm, estimated: true };
  }
  return null;
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
  if (!grid || grid.estimated || !Number.isFinite(t)) return -1;
  if (grid.kind === "straight") return mod4((t - grid.anchor) / grid.period) / 4;
  const { times, downIndex } = grid;
  if (t < times[0] || t > times[times.length - 1]) return -1;
  const i = Math.max(0, Math.min(times.length - 2, lowerBound(times, t) - 1));
  const frac = (t - times[i]) / (times[i + 1] - times[i]);
  return mod4(i - downIndex + frac) / 4;
}

const dtoCache = new Map<number, BeatGridDto | null>();

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
