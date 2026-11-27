// Controller diagnostics: a small in-memory log of MIDI messages decodeMidi does not use (never persisted, never sent
// anywhere) and the Deck 3/4 layer check. Pure helpers first, then the store the Settings page reads. At the end, the
// raw log of every message, off by default.
import { useSyncExternalStore } from "react";
import type { DeckCommand, MidiOutput } from "./midi";
import type { PadBank } from "./padBank";

export type MidiTriple = [number, number, number];
/** One row of the log: the latest bytes for a status + data1 pair, how often it came and when it was last seen (ms). */
export type UnhandledMidi = { status: number; d1: number; d2: number; count: number; at: number };

export const UNHANDLED_MAX = 30;
/** The Settings list re-renders at most this often (ms), however fast an unused knob sends. */
export const UNHANDLED_PUBLISH_MS = 250;
export const DECK_LAYER_WARN_MS = 30_000;

/** Note-offs (8n, or 9n with velocity 0) are never logged: a press already shows the button, and pad releases would flood the list. */
export const isLoggable = ([status, , d2]: MidiTriple) => {
  const type = status & 0xf0;
  return type !== 0x80 && !(type === 0x90 && d2 === 0);
};

/** Newest first; a repeat of the same status + data1 moves its row to the top and counts up instead of adding a row. */
export function recordUnhandled(ring: readonly UnhandledMidi[], [status, d1, d2]: MidiTriple, at: number, max = UNHANDLED_MAX): UnhandledMidi[] {
  const prev = ring.find(e => e.status === status && e.d1 === d1);
  return [{ status, d1, d2, count: (prev?.count ?? 0) + 1, at }, ...ring.filter(e => e !== prev)].slice(0, max);
}

const hex = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");
/** "90 06 7F ×3". */
export const formatUnhandled = (e: UnhandledMidi) => `${hex(e.status)} ${hex(e.d1)} ${hex(e.d2)}${e.count > 1 ? ` ×${e.count}` : ""}`;

/**
 * A message the controller sends only in its Deck 3/4 layer (Mixxx's Platinum FX map): transport and mixer on MIDI
 * channels 3/4 (status low nibble 2/3), pads on channels 7/8 (6/7). Effects (9/10), master (15) and browse/load (16)
 * are shared by both layers, so they never count. Only button presses and jog turns count: the controller's knob and
 * fader position dump must not raise the warning. Note 08 on channels 3/4 is skipped, since it may be the deck switch
 * itself (the Mixxx sources disagree).
 */
export function isDeckLayerMessage([status, d1, d2]: MidiTriple): boolean {
  const type = status & 0xf0;
  const ch = status & 0x0f;
  if (type === 0x90 && d2 > 0) return ch === 6 || ch === 7 || ((ch === 2 || ch === 3) && d1 !== 0x08);
  return type === 0xb0 && (ch === 2 || ch === 3) && d1 === 0x06 && d2 !== 0;
}

/** Warn on a Deck 3/4 layer message, at most once per DECK_LAYER_WARN_MS. */
export const deckLayerWarningDue = (msg: MidiTriple, lastWarnedAt: number | null, now: number) =>
  isDeckLayerMessage(msg) && (lastWarnedAt === null || now - lastWarnedAt >= DECK_LAYER_WARN_MS);

let ring: UnhandledMidi[] = [];
let published = ring;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function publish() {
  timer = null;
  if (published === ring) return;
  published = ring;
  for (const l of listeners) l();
}

export function noteUnhandledMidi(msg: MidiTriple, at = Date.now()) {
  if (!isLoggable(msg)) return;
  ring = recordUnhandled(ring, msg, at);
  timer ??= setTimeout(publish, UNHANDLED_PUBLISH_MS);
}

export function clearUnhandledMidi() {
  if (timer !== null) { clearTimeout(timer); timer = null; }
  ring = [];
  publish();
}

export const getUnhandledMidi = () => published;
export const subscribeUnhandledMidi = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const useUnhandledMidi = () => useSyncExternalStore(subscribeUnhandledMidi, getUnhandledMidi, getUnhandledMidi);

// ── Raw log: every message and what CrateMind made of it. Off until switched on in Settings (and on every start), in
// memory only, never sent anywhere. It only reads what the bridge already decoded, so it changes no mapping.

/** One row: the latest bytes, what decodeMidi made of them (Greek), how often in a row, and when last seen (ms). */
export type RawMidi = UnhandledMidi & { what: string };
export const RAW_MAX = 100;

const DECK_CMD_LABEL: Record<DeckCommand["cmd"], string> = {
  toggle: "Play/Pause", seek: "Jog", pad: "Pad", "pad-delete": "Διαγραφή pad", cue: "Cue", "cue-release": "Cue (άφημα)",
  sync: "Sync", range: "Εύρος pitch", tag: "Pad βαθμολόγησης", status: "Pad κατάστασης", note: "Σημείωση μετάβασης",
  "loop-toggle": "Loop", "loop-half": "Loop ½", "loop-double": "Loop ×2", "loop-in": "Loop in", "loop-out": "Loop out",
};
type MixerControl = Extract<MidiOutput, { kind: "mixer" }>["control"];
const MIXER_LABEL: Record<MixerControl, string> = {
  volume: "Ένταση", crossfader: "Crossfader", eq: "EQ", filter: "Φίλτρο", pitch: "Pitch fader", trim: "Trim", master: "Master",
  cueGain: "Ένταση ακουστικών", cueMix: "Μίξη ακουστικών", bend: "Bend", keylock: "Key lock",
};
const BANK_LABEL: Record<PadBank, string> = { cue: "Cue", tag: "Βαθμολόγηση", status: "Κατάσταση" };
const EQ_LABEL = { hi: "HI", mid: "MID", lo: "LOW" } as const;
const sign = (n: number) => (n > 0 ? `+${n}` : `${n}`);

/** One decoded output in Greek, e.g. "Deck B · Sync", "EQ LOW (Deck A)", "Φόρτωση στο Deck A". */
export function describeMidiOutput(o: MidiOutput): string {
  switch (o.kind) {
    case "key": return `Πλήκτρο ${o.shiftKey ? "Shift + " : ""}${o.key}`;
    case "bank": return `Deck ${o.deck} · Ομάδα pads: ${BANK_LABEL[o.bank]}`;
    case "deck": {
      const pad = o.cmd === "pad" || o.cmd === "pad-delete" ? ` ${o.value + 1}` : "";
      return o.cmd === "note" ? `${DECK_CMD_LABEL.note} (FX ${o.deck === "A" ? 1 : 2})` : `Deck ${o.deck} · ${DECK_CMD_LABEL[o.cmd]}${pad}`;
    }
    case "fxrack":
      if (o.control === "paddle") return `Deck ${o.deck} · Μοχλός FX`;
      return o.control === "amount" ? "FX Wet/Dry" : `FX Beats ${o.value > 0 ? "+" : "−"}`;
    case "mixer": {
      const what = o.control === "eq" ? `EQ ${EQ_LABEL[o.band]}`
        : o.control === "bend" ? `Bend ${o.dir > 0 ? "+" : o.dir < 0 ? "−" : "(άφημα)"}` : MIXER_LABEL[o.control];
      return "deck" in o ? `Deck ${o.deck} · ${what}` : what;
    }
    case "action": {
      const a = o.action;
      if (a.type === "browse") return `Περιήγηση ${sign(a.delta)}`;
      if (a.type === "load-deck") return `Φόρτωση στο Deck ${a.deck}`;
      if (a.type === "eject") return `Άδειασμα του Deck ${a.deck}`;
      return a.type === "play" ? "Αναπαραγωγή επιλογής" : a.type === "cycle-focus" ? "Αλλαγή λίστας" : "Προσθήκη στο set";
    }
  }
}

/** What a message did: its outputs in Greek, «χωρίς ενέργεια» for a known one that does nothing by itself (a pitch coarse
 * byte, a jog standstill, a Load press), «χωρίς αντιστοίχιση» when no mapping matched. With `msg`, a release no mapping
 * uses reads «άφημα, χωρίς ενέργεια»: most buttons act on the press, so it is no mapping problem. */
export const describeMidiOutputs = (outputs: readonly MidiOutput[], unhandled: boolean, msg?: MidiTriple) =>
  unhandled ? (msg && !isLoggable(msg) ? "άφημα, χωρίς ενέργεια" : "χωρίς αντιστοίχιση")
    : outputs.length === 0 ? "χωρίς ενέργεια" : outputs.map(describeMidiOutput).join(", ");

/** Newest first. A CC that repeats the newest row (same status, data1 and meaning: a knob, a fader, the jog) updates that
 * row and counts up, so one turn is one row; notes always get their own row, so press and release both show. */
export function recordRaw(log: readonly RawMidi[], [status, d1, d2]: MidiTriple, what: string, at: number, max = RAW_MAX): RawMidi[] {
  const top = log[0];
  if (top && (status & 0xf0) === 0xb0 && top.status === status && top.d1 === d1 && top.what === what) {
    return [{ ...top, d2, count: top.count + 1, at }, ...log.slice(1)];
  }
  return [{ status, d1, d2, count: 1, at, what }, ...log].slice(0, max);
}

export type RawMidiLog = { on: boolean; entries: readonly RawMidi[] };
let rawLog: RawMidiLog = { on: false, entries: [] };
let rawPublished = rawLog;
let rawTimer: ReturnType<typeof setTimeout> | null = null;
const rawListeners = new Set<() => void>();

function publishRaw() {
  rawTimer = null;
  if (rawPublished === rawLog) return;
  rawPublished = rawLog;
  for (const l of rawListeners) l();
}
/** The bridge asks first, so a message costs nothing while the log is off. */
export const rawMidiLogOn = () => rawLog.on;
/** Switching off stops recording and keeps the rows, so they can be read at leisure. */
export function setRawMidiLog(on: boolean) {
  if (on === rawLog.on) return;
  rawLog = { ...rawLog, on };
  publishRaw();
}
export function noteRawMidi(msg: MidiTriple, what: string, at = Date.now()) {
  if (!rawLog.on) return;
  rawLog = { on: true, entries: recordRaw(rawLog.entries, msg, what, at) };
  rawTimer ??= setTimeout(publishRaw, UNHANDLED_PUBLISH_MS);
}
export function clearRawMidi() {
  if (rawTimer !== null) { clearTimeout(rawTimer); rawTimer = null; }
  rawLog = { ...rawLog, entries: [] };
  publishRaw();
}
export const getRawMidiLog = () => rawPublished;
export const subscribeRawMidiLog = (l: () => void) => { rawListeners.add(l); return () => { rawListeners.delete(l); }; };
export const useRawMidiLog = () => useSyncExternalStore(subscribeRawMidiLog, getRawMidiLog, getRawMidiLog);
