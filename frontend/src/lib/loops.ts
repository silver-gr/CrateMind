import { MIN_LOOP_S } from "./audio/stretchDeck";

// Controller loop planning (pure). Loop positions are track time in seconds; beat lengths come from the track's own BPM,
// not the fader-scaled tempo, because the engine loops the source audio.
export type Loop = { start: number; end: number };
export type LoopOp = "toggle" | "half" | "double" | "in" | "out";
export type LoopPlan =
  | { ok: true; kind: "clear" }
  | { ok: true; kind: "beats"; beats: number }
  | { ok: true; kind: "set"; loop: Loop; beats: number }
  | { ok: false; reason: "no-bpm" | "range" | "limit" };

export const LOOP_DEFAULT_BEATS = 4;
/** Half / double steps cover 1/8 to 32 beats. */
export const LOOP_MIN_BEATS = 1 / 8;
export const LOOP_MAX_BEATS = 32;

export const beatSeconds = (bpm: number | null | undefined) => (bpm != null && Number.isFinite(bpm) && bpm > 0 ? 60 / bpm : null);
const stepBeats = (beats: number, factor: 0.5 | 2) => Math.min(LOOP_MAX_BEATS, Math.max(LOOP_MIN_BEATS, beats * factor));

/** `beats` is the length the next fresh loop gets; it follows half / double even while no loop is set. */
export function planLoop(op: LoopOp, s: { position: number; duration: number; bpm: number | null | undefined; loop: Loop | null; beats: number }): LoopPlan {
  const beat = beatSeconds(s.bpm);
  const fits = (loop: Loop, beats: number): LoopPlan =>
    loop.start >= 0 && loop.end <= s.duration && loop.end - loop.start >= MIN_LOOP_S ? { ok: true, kind: "set", loop, beats } : { ok: false, reason: "range" };
  if (op === "toggle") {
    if (s.loop) return { ok: true, kind: "clear" };
    if (beat === null) return { ok: false, reason: "no-bpm" };
    return fits({ start: s.position, end: s.position + s.beats * beat }, s.beats);
  }
  if (op === "half" || op === "double") {
    const factor = op === "half" ? 0.5 : 2;
    const beats = stepBeats(s.beats, factor);
    if (beats === s.beats) return { ok: false, reason: "limit" };
    if (!s.loop) return { ok: true, kind: "beats", beats }; // only the next loop's length changes
    return fits({ start: s.loop.start, end: s.loop.start + (s.loop.end - s.loop.start) * factor }, beats);
  }
  if (op === "in") {
    if (s.loop && s.position < s.loop.end - MIN_LOOP_S) return fits({ start: s.position, end: s.loop.end }, s.beats);
    if (beat === null) return { ok: false, reason: "no-bpm" };
    return fits({ start: s.position, end: s.position + s.beats * beat }, s.beats);
  }
  if (s.loop && s.position > s.loop.start + MIN_LOOP_S) return fits({ start: s.loop.start, end: s.position }, s.beats);
  if (beat === null) return { ok: false, reason: "no-bpm" };
  return fits({ start: s.position - s.beats * beat, end: s.position }, s.beats);
}
