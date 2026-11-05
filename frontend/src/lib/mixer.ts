import { useSyncExternalStore } from "react";
import type { DeckId } from "./player";

export type EqBand = "hi" | "mid" | "lo";
/** Per-deck tone and tempo. Knobs and the fader are -1..1 (0 = flat / 100 %); `bend.since` is the press time in ms. */
export type DeckFx = {
  eq: Record<EqBand, number>; filter: number; pitch: number;
  bend: { dir: -1 | 0 | 1; since: number }; keylock: boolean;
  /** Pre-EQ level trim, -1..1 (= -12..+12 dB). `range` is the pitch fader's +/- span (a PITCH_RANGES entry). */
  trim: number; range: number;
};
/** `master`: global attenuation 0..1 (squared taper), applied after the limiter. */
export type MixerState = { volume: Record<DeckId, number>; crossfader: number; midiConnected: boolean; fx: Record<DeckId, DeckFx>; master: number };

/** Shared by both decks until touched, and by single-deck mode, so neutral slices keep one identity. */
export const NEUTRAL_FX: DeckFx = { eq: { hi: 0, mid: 0, lo: 0 }, filter: 0, pitch: 0, bend: { dir: 0, since: 0 }, keylock: false, trim: 0, range: 0.08 };
const initialMixer = (): MixerState => ({ volume: { A: 1, B: 1 }, crossfader: 0, midiConnected: false, fx: { A: NEUTRAL_FX, B: NEUTRAL_FX }, master: 1 });

/** Fader range (the default), and how far (fraction) and how fast a held bend ramps; tune live. */
export const PITCH_RANGE = 0.08;
/** Selectable pitch-fader spans, narrowest first; the range button cycles through them. */
export const PITCH_RANGES = [0.08, 0.16, 0.5] as const;
export const BEND_MAX = 0.10;
export const BEND_RAMP_S = 5;
const BEND_TAP = 0.01;

let state: MixerState = initialMixer();
const listeners = new Set<() => void>();
const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo);
function update(next: MixerState) {
  state = next;
  listeners.forEach(listener => listener());
}

export const getMixer = () => state;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export const useMixer = () => useSyncExternalStore(subscribe, getMixer, getMixer);
export const useMidiConnected = () => useSyncExternalStore(subscribe, () => state.midiConnected, () => state.midiConnected);
/** Immutable slice, replaced only when that deck's fx change. */
export const useDeckFx = (deck: DeckId) => useSyncExternalStore(subscribe, () => state.fx[deck], () => state.fx[deck]);
export const useDeckGain = (deck: DeckId) => useSyncExternalStore(subscribe, () => deckGain(deck, state), () => deckGain(deck, state));

export function setMixerVolume(deck: DeckId, value: number) {
  update({ ...state, volume: { ...state.volume, [deck]: clamp(value, 0, 1) } });
}
export function setCrossfader(value: number) {
  update({ ...state, crossfader: clamp(value, -1, 1) });
}
export function setMidiConnected(connected: boolean) {
  if (connected === state.midiConnected) return;
  update({ ...state, midiConnected: connected });
  if (!connected) { releaseBends(); resetPickup(); }
}
function patchFx(deck: DeckId, patch: Partial<DeckFx>) {
  const prev = state.fx[deck];
  if ((Object.keys(patch) as (keyof DeckFx)[]).every(k => prev[k] === patch[k])) return;
  update({ ...state, fx: { ...state.fx, [deck]: { ...prev, ...patch } } });
}
export function setDeckEq(deck: DeckId, band: EqBand, value: number) {
  const eq = state.fx[deck].eq;
  if (Number.isFinite(value) && eq[band] !== clamp(value, -1, 1)) patchFx(deck, { eq: { ...eq, [band]: clamp(value, -1, 1) } });
}
export function setDeckFilter(deck: DeckId, value: number) {
  if (Number.isFinite(value)) patchFx(deck, { filter: clamp(value, -1, 1) });
}
/** On-screen fader: always applies, and ends any pending controller pickup. */
export function setDeckPitch(deck: DeckId, value: number) {
  if (!Number.isFinite(value)) return;
  pickup[deck] = null;
  patchFx(deck, { pitch: clamp(value, -1, 1) });
}

// Soft takeover: after software moves a deck's pitch (range cycle, Sync), the physical fader is ignored until it
// reaches that value. `lastCtl` is the fader's last reported position, so a crossing between two reports counts.
const PICKUP_EPSILON = 0.02;
const pickup: Record<DeckId, number | null> = { A: null, B: null };
const lastCtl: Record<DeckId, number | null> = { A: null, B: null };
/** True when the controller value `v` should be applied given the pickup target and its previous position. */
export function pickupCrossed(target: number, last: number | null, v: number): boolean {
  if (Math.abs(v - target) <= PICKUP_EPSILON) return true;
  return last !== null && Math.sign(last - target) !== Math.sign(v - target);
}
/** Physical pitch fader (-1..1): applies unless a software move is waiting to be picked up. */
export function setDeckPitchFromController(deck: DeckId, value: number) {
  if (!Number.isFinite(value)) return;
  const v = clamp(value, -1, 1);
  const last = lastCtl[deck];
  lastCtl[deck] = v;
  const target = pickup[deck];
  if (target !== null) {
    if (!pickupCrossed(target, last, v)) return;
    pickup[deck] = null;
  }
  patchFx(deck, { pitch: v });
}
export function setDeckTrim(deck: DeckId, value: number) {
  if (Number.isFinite(value)) patchFx(deck, { trim: clamp(value, -1, 1) });
}
export function setMasterGain(value: number) {
  if (Number.isFinite(value)) update({ ...state, master: clamp(value, 0, 1) });
}
/** Software pitch/range move (range cycle, Sync): the physical fader must cross the new value before it takes over. */
export function setDeckRangePitch(deck: DeckId, range: number, pitch: number) {
  if (!Number.isFinite(range) || !Number.isFinite(pitch)) return;
  const p = clamp(pitch, -1, 1);
  pickup[deck] = p;
  patchFx(deck, { range, pitch: p });
}
/** Re-pressing the held direction keeps the original `since` so the ramp is not restarted. */
export function setDeckBend(deck: DeckId, dir: -1 | 0 | 1, now: number) {
  const prev = state.fx[deck].bend;
  if (prev.dir === dir) return;
  patchFx(deck, { bend: dir === 0 ? NEUTRAL_FX.bend : { dir, since: now } });
}
export function toggleKeylock(deck: DeckId) {
  patchFx(deck, { keylock: !state.fx[deck].keylock });
}
/** Mix sessions turn key lock on for both decks and restore the user's values afterwards. */
export function setDeckKeylock(deck: DeckId, keylock: boolean) {
  patchFx(deck, { keylock });
}
/** Momentary bends must never outlive their button (disconnect, bridge teardown, unmount). */
export function releaseBends() {
  setDeckBend("A", 0, 0);
  setDeckBend("B", 0, 0);
}
/** Forget fader positions and pending pickups (a reconnect re-syncs the faders from the status dump). */
export function resetPickup() {
  for (const d of ["A", "B"] as const) { pickup[d] = null; lastCtl[d] = null; }
}
/** Test hook: restore the initial mixer. */
export function resetMixer() {
  resetPickup();
  update(initialMixer());
}

/** Squared fader taper times a crossfader that leaves both decks at full gain in the centre. */
export function deckGain(deck: DeckId, s: MixerState): number {
  const x = deck === "A" ? 1 - s.crossfader : 1 + s.crossfader;
  return s.volume[deck] ** 2 * s.master ** 2 * clamp(x, 0, 1);
}

/** Trim knob -1..1 -> -12..+12 dB. */
export const trimDb = (v: number) => clamp(v, -1, 1) * 12;

const RATE_EPSILON = 1e-6;
/** Fader position (-1..1) holding `rate` at `range`, or null when the range can't reach it. */
function pitchFor(rate: number, range: number): number | null {
  const p = (rate - 1) / range;
  return Math.abs(p) <= 1 + RATE_EPSILON ? clamp(p, -1, 1) : null;
}
export type PitchPlan = { range: number; pitch: number };
/**
 * Next range in the cycle that can hold the current fader rate (rescaling `pitch` so the rate doesn't jump);
 * ranges that can't are skipped. Null when no other range can hold it.
 */
export function cycleRange(fx: DeckFx): PitchPlan | null {
  const rate = faderRate(fx);
  const at = PITCH_RANGES.findIndex(r => r === fx.range);
  for (let step = 1; step < PITCH_RANGES.length; step++) {
    const range = PITCH_RANGES[((at < 0 ? 0 : at) + step) % PITCH_RANGES.length];
    const pitch = pitchFor(rate, range);
    if (pitch !== null) return { range, pitch };
  }
  return null;
}
/** Range and fader position giving `rate`: the current range if it fits, else the next wider ones (8 -> 16 -> 50). Null if none. */
export function planRate(fx: DeckFx, rate: number): PitchPlan | null {
  if (!Number.isFinite(rate) || rate < 0.5 || rate > 1.5) return null;
  const at = Math.max(0, PITCH_RANGES.findIndex(r => r === fx.range));
  for (const range of PITCH_RANGES.slice(at)) {
    const pitch = pitchFor(rate, range);
    if (pitch !== null) return { range, pitch };
  }
  return null;
}

/** Two-deck dock: a controller is connected or Deck B holds a track. */
export function isTwoDeck(midiConnected: boolean, deckBTrack: unknown): boolean {
  return midiConnected || deckBTrack != null;
}

/** Controller CC 0..127 -> -1..1 with 64 at the exact centre. */
export const ccToBipolar = (v: number) => (v < 64 ? (v - 64) / 64 : (v - 64) / 63);

/** Held-bend offset: an immediate 1 % nudge, then a linear ramp to BEND_MAX over BEND_RAMP_S. */
export function bendAmount(bend: DeckFx["bend"], now: number): number {
  if (bend.dir === 0) return 0;
  const t = Math.max(0, (now - bend.since) / 1000);
  return bend.dir * Math.min(BEND_MAX, BEND_TAP + (BEND_MAX - BEND_TAP) * t / BEND_RAMP_S);
}
export function deckRate(fx: DeckFx, now: number): number {
  return Math.max(0.5, Math.min(1.5, 1 + fx.pitch * fx.range + bendAmount(fx.bend, now)));
}

/** Fader-only rate (no bend): what the pitch readout and the BPM badge show. */
export const faderRate = (fx: DeckFx) => deckRate({ ...fx, bend: NEUTRAL_FX.bend }, 0);
/** Signed one-decimal percent, e.g. "+2.4%"; "0.0%" at 100 %. */
export function formatPitchPercent(rate: number): string {
  const p = Math.round((rate - 1) * 1000) / 10;
  return p === 0 ? "0.0%" : `${p > 0 ? "+" : "-"}${Math.abs(p).toFixed(1)}%`;
}
/** BPM badge text at a deck rate: whole BPM at rate 1, one decimal otherwise. */
export const rateBpmText = (bpm: number, rate: number) => `${rate === 1 ? bpm.toFixed(0) : (bpm * rate).toFixed(1)} BPM`;

/** DJM-style EQ: down to -26 dB (near-kill), up to +6 dB. */
export const eqDb = (v: number) => { const x = clamp(v, -1, 1); return x < 0 ? x * 26 : x * 6; };

/** Web Audio reads Q of low-pass/high-pass as resonance in dB; -3.0103 dB is Butterworth. */
export const FILTER_Q_DB = -3.0103;
const FILTER_DEAD_ZONE = 0.03;
/** Neutral = low-pass at Nyquist + high-pass at 0 Hz (passed through flat by the spec). Left sweeps the low-pass, right the high-pass. */
export function filterParams(v: number, sampleRate: number) {
  const x = clamp(v, -1, 1);
  const lpHz = sampleRate / 2;
  if (Math.abs(x) < FILTER_DEAD_ZONE) return { neutral: true, lpHz, hpHz: 0 };
  const t = (Math.abs(x) - FILTER_DEAD_ZONE) / (1 - FILTER_DEAD_ZONE);
  return x < 0
    ? { neutral: false, lpHz: 20000 * (60 / 20000) ** t, hpHz: 0 }
    : { neutral: false, lpHz, hpHz: 20 * (8000 / 20) ** t };
}
