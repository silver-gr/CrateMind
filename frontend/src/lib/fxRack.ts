import { useSyncExternalStore } from "react";
import type { DeckId } from "./player";
import { getPref, setPref, type FxRackDeckPrefs, type FxRackPrefs } from "./prefs";
import { DEFAULT_AMOUNT, DEFAULT_FAVOURITES, DEFAULT_PRESET_ID, beatsIndex, presetById } from "./fxRack/presets";

/** One deck's rack: preset id, amount 0..1, BEATS index per preset id (default entries omitted), and the live flags. */
export type FxRackDeck = {
  preset: string; amount: number; beats: Record<string, number>;
  /** Effect on; `held` while a hold (FX button or paddle) keeps it on; `releasing` while a latched release waits for the phrase line. */
  on: boolean; held: boolean; releasing: boolean;
  /** The node still rings a tail. */
  tail: boolean;
};
/** Both decks plus the shared favourites, per-deck phrase release and availability. */
export type FxRackState = {
  decks: Record<DeckId, FxRackDeck>; favourites: string[]; phraseRelease: Record<DeckId, boolean>;
  available: boolean;
};

const DECKS = ["A", "B"] as const;
/** Saved prefs are written this long after the last change, or at once by `saveFxRackNow()` (knob release). */
export const SAVE_IDLE_MS = 500;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function deckFromPrefs(raw: unknown): FxRackDeck {
  const o = isRecord(raw) ? raw : {};
  const preset = typeof o.preset === "string" && presetById(o.preset) ? o.preset : DEFAULT_PRESET_ID;
  const amount = typeof o.amount === "number" && Number.isFinite(o.amount) ? clamp(o.amount, 0, 1) : DEFAULT_AMOUNT;
  const beats: Record<string, number> = {};
  if (isRecord(o.beats)) {
    for (const [id, index] of Object.entries(o.beats)) {
      const p = presetById(id);
      if (p?.beats && typeof index === "number" && beatsIndex(p, index) === index && index !== p.beats.def) beats[id] = index;
    }
  }
  return { preset, amount, beats, on: false, held: false, releasing: false, tail: false };
}

/** The store from saved prefs: unknown ids fall back to the defaults and values are clamped; `null` is the first run. */
export function fxRackFromPrefs(saved: FxRackPrefs | null): FxRackState {
  const o: Record<string, unknown> = isRecord(saved) ? saved : {};
  const favourites = Array.isArray(o.favourites)
    ? [...new Set(o.favourites.filter((id): id is string => typeof id === "string" && presetById(id) !== undefined))]
    : [...DEFAULT_FAVOURITES];
  const phrase = isRecord(o.phraseRelease) ? o.phraseRelease : {};
  return {
    decks: { A: deckFromPrefs(o.A), B: deckFromPrefs(o.B) },
    favourites,
    phraseRelease: { A: typeof phrase.A === "boolean" ? phrase.A : true, B: typeof phrase.B === "boolean" ? phrase.B : true },
    available: true,
  };
}

const deckPrefs = (d: FxRackDeck): FxRackDeckPrefs => ({ preset: d.preset, amount: d.amount, beats: { ...d.beats } });
const toPrefs = (s: FxRackState): FxRackPrefs => ({
  A: deckPrefs(s.decks.A), B: deckPrefs(s.decks.B), favourites: [...s.favourites], phraseRelease: { ...s.phraseRelease },
});

// Read lazily: on desktop the preferences are hydrated after the modules load.
let state: FxRackState | null = null;
const current = () => (state ??= fxRackFromPrefs(getPref("fxRack")));
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** The node has reported engaged since this deck's last engage from off, so its `engaged: false` ends the latch. */
const acked: Record<DeckId, boolean> = { A: false, B: false };

function update(next: FxRackState, persist = false) {
  state = next;
  if (persist) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveFxRackNow, SAVE_IDLE_MS);
  }
  listeners.forEach(listener => listener());
}
function patchDeck(deck: DeckId, patch: Partial<FxRackDeck>, persist = false) {
  const s = current();
  update({ ...s, decks: { ...s.decks, [deck]: { ...s.decks[deck], ...patch } } }, persist);
}

/** Writes a pending save now (knob release); nothing when no save is pending. */
export function saveFxRackNow() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  if (state) setPref("fxRack", toPrefs(state));
}

export const getFxRack = () => current();
/** For the host, which reads the store imperatively instead of re-rendering. */
export const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export const useFxRackStore = () => useSyncExternalStore(subscribe, getFxRack, getFxRack);
/** Immutable slice, replaced only when that deck changes. */
export const useFxRackDeck = (deck: DeckId) => useSyncExternalStore(subscribe, () => current().decks[deck], () => current().decks[deck]);

/** The BEATS index in effect for a deck's selected preset. */
export function deckBeatsIndex(d: FxRackDeck): number {
  const p = presetById(d.preset);
  return p ? beatsIndex(p, d.beats[d.preset]) : 0;
}

/** Selects a preset; while the effect is on it switches live. Unknown ids are ignored. */
export function selectPreset(deck: DeckId, id: string) {
  if (!presetById(id) || current().decks[deck].preset === id) return;
  patchDeck(deck, { preset: id }, true);
}
export function setAmount(deck: DeckId, value: number) {
  if (!Number.isFinite(value)) return;
  const amount = clamp(value, 0, 1);
  if (current().decks[deck].amount !== amount) patchDeck(deck, { amount }, true);
}
/** Sets the BEATS index of the deck's preset (clamped to its choices); presets without BEATS ignore it. */
export function setBeats(deck: DeckId, index: number) {
  const d = current().decks[deck];
  const p = presetById(d.preset);
  if (!p?.beats || !Number.isFinite(index)) return;
  const i = clamp(Math.round(index), 0, p.beats.options.length - 1);
  if (i === deckBeatsIndex(d)) return;
  const beats = { ...d.beats };
  if (i === p.beats.def) delete beats[d.preset];
  else beats[d.preset] = i;
  patchDeck(deck, { beats }, true);
}
/** One BEATS choice up (1) or down (-1), stopping at the ends. */
export function stepBeats(deck: DeckId, dir: number) {
  const step = Math.sign(dir);
  if (step) setBeats(deck, deckBeatsIndex(current().decks[deck]) + step);
}

/** The deck whose effect was last turned on (FX button or paddle, screen or controller); null until one has been. */
let lastFxDeck: DeckId | null = null;
export const getLastFxDeck = () => lastFxDeck;

/** Turns the effect on, latched or held; a re-engage cancels a pending phrase release. Ignored while unavailable. */
export function engage(deck: DeckId, mode: "latch" | "hold") {
  const s = current();
  const d = s.decks[deck];
  const held = mode === "hold";
  if (!s.available) return;
  lastFxDeck = deck;
  if (d.on && !d.releasing && d.held === held) return;
  if (!d.on) acked[deck] = false;
  patchDeck(deck, { on: true, held, releasing: false });
}
/** A short press: the hold becomes a latch. */
export function latchHeld(deck: DeckId) {
  const d = current().decks[deck];
  if (d.on && d.held) patchDeck(deck, { held: false });
}
/**
 * Turns the effect off. A hold releases at once; a latched P preset with phrase release on waits (`releasing`) for the
 * phrase beat the host posts, and a second release ends it now. `now` skips the wait (track change, eject, fault).
 */
export function release(deck: DeckId, now = false) {
  const s = current();
  const d = s.decks[deck];
  if (!d.on) return;
  if (!now && !d.held && !d.releasing && presetById(d.preset)?.phrase && s.phraseRelease[deck]) patchDeck(deck, { releasing: true });
  else patchDeck(deck, { on: false, held: false, releasing: false });
}
export function toggleFavourite(id: string) {
  if (!presetById(id)) return;
  const s = current();
  const favourites = s.favourites.includes(id) ? s.favourites.filter(f => f !== id) : [...s.favourites, id];
  update({ ...s, favourites }, true);
}
export function setPhraseRelease(deck: DeckId, on: boolean) {
  const s = current();
  if (s.phraseRelease[deck] !== on) update({ ...s, phraseRelease: { ...s.phraseRelease, [deck]: on } }, true);
}

// ---- Controller (§6) ----

/** FX paddle: 1 latches, 2 holds, 0 releases. */
export function paddle(deck: DeckId, value: 0 | 1 | 2) {
  if (value === 0) release(deck);
  else engage(deck, value === 1 ? "latch" : "hold");
}
/** The one Wet/Dry knob (0..1) is both decks' amount, at once and with no pickup, so the connect dump sets them like the faders. */
export function controllerAmount(value: number) {
  for (const deck of DECKS) setAmount(deck, value);
}
/** The one Beats encoder steps both decks, one step per tick in the sign of `delta`. */
export function controllerBeats(delta: number) {
  if (!Number.isFinite(delta) || !delta) return;
  for (const deck of DECKS) stepBeats(deck, delta);
}
/** Window blur or controller disconnect: ends holds only, never latches. */
export function releaseHeld() {
  for (const deck of DECKS) if (current().decks[deck].held) release(deck, true);
}
/** Controller disconnected: ends holds. */
export function controllerDisconnected() {
  releaseHeld();
}

// ---- Host only ----

/**
 * Node state on change. `engaged: false` completes a pending phrase release, and ends a latch the node ended by itself
 * (a Φ line, Reverse at its cap) once the node has acknowledged this engage; a stale one from before is ignored.
 */
export function setNodeState(deck: DeckId, node: { engaged: boolean; tail: boolean }) {
  const d = current().decks[deck];
  const patch: Partial<FxRackDeck> = { tail: node.tail };
  if (node.engaged) acked[deck] = true;
  else if (d.releasing || (d.on && !d.held && acked[deck])) Object.assign(patch, { on: false, held: false, releasing: false });
  if ((Object.keys(patch) as (keyof FxRackDeck)[]).some(k => d[k] !== patch[k])) patchDeck(deck, patch);
}
/** Loader result or processor error; unavailable turns both decks off. */
export function setAvailable(available: boolean) {
  const s = current();
  if (s.available === available) return;
  const off = (d: FxRackDeck): FxRackDeck => ({ ...d, on: false, held: false, releasing: false, tail: false });
  update({ ...s, available, decks: available ? s.decks : { A: off(s.decks.A), B: off(s.decks.B) } });
}

/** Test hook: drop the store and pending save, so the next read starts from prefs again. */
export function resetFxRack() {
  lastFxDeck = null;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  state = null;
  acked.A = acked.B = false;
}
