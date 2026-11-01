import { useSyncExternalStore } from "react";
import type { DeckId } from "./player";

export type EqBand = "hi" | "mid" | "lo";
/** Per-deck tone and tempo. Knobs and the fader are -1..1 (0 = flat / 100 %); `bend.since` is the press time in ms. */
export type DeckFx = {
  eq: Record<EqBand, number>; filter: number; pitch: number;
  bend: { dir: -1 | 0 | 1; since: number }; keylock: boolean;
};
export type MixerState = { volume: Record<DeckId, number>; crossfader: number; midiConnected: boolean; fx: Record<DeckId, DeckFx> };

/** Shared by both decks until touched, and by single-deck mode, so neutral slices keep one identity. */
export const NEUTRAL_FX: DeckFx = { eq: { hi: 0, mid: 0, lo: 0 }, filter: 0, pitch: 0, bend: { dir: 0, since: 0 }, keylock: false };
const initialMixer = (): MixerState => ({ volume: { A: 1, B: 1 }, crossfader: 0, midiConnected: false, fx: { A: NEUTRAL_FX, B: NEUTRAL_FX } });

/** Fader range, and how far (fraction) and how fast a held bend ramps; tune live. */
export const PITCH_RANGE = 0.08;
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
  if (!connected) releaseBends();
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
export function setDeckPitch(deck: DeckId, value: number) {
  if (Number.isFinite(value)) patchFx(deck, { pitch: clamp(value, -1, 1) });
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
/** Momentary bends must never outlive their button (disconnect, bridge teardown, unmount). */
export function releaseBends() {
  setDeckBend("A", 0, 0);
  setDeckBend("B", 0, 0);
}
/** Test hook: restore the initial mixer. */
export function resetMixer() {
  update(initialMixer());
}

/** Squared fader taper times a crossfader that leaves both decks at full gain in the centre. */
export function deckGain(deck: DeckId, s: MixerState): number {
  const x = deck === "A" ? 1 - s.crossfader : 1 + s.crossfader;
  return s.volume[deck] ** 2 * clamp(x, 0, 1);
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
  return Math.max(0.5, Math.min(1.5, 1 + fx.pitch * PITCH_RANGE + bendAmount(fx.bend, now)));
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
