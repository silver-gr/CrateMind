// Deck FX rack host: one rack node per deck, bound post-fader to the deck's current media in two-deck mode. It feeds the
// node the clock, track, preset and engage/release, and writes the node's state back to the store (§1 Host).
import { toast } from "sonner";
import { masterInput } from "./audio/masterBus";
import type { Anchor, EngineLoop } from "./audio/stretchDeck";
import type { BeatGrid } from "./beatGrid";
import { deckBeatsIndex, getFxRack, release, setAvailable, setNodeState, subscribe, type FxRackDeck } from "./fxRack";
import { beatsValue, needsBpm, presetById } from "./fxRack/presets";
import type { FxFromNode, FxToNode } from "./fxRack/types";
import {
  LIST_LOW, beatAt, engineClock, gridTrusted, phiBeat, plainClock, positionIn, releaseBeat, wrapAt,
  type DeckBeat, type EngineView,
} from "./fxRackClock";
import type { MediaLike } from "./media";
import { deckTransportOf } from "./mix/deckTransport";
import { getMixer } from "./mixer";
import type { DeckId } from "./player";
import { playbackContext, playbackLatency, setPlaybackInsert, type PlaybackInsert } from "./playbackAudio";

const POLL_MS = 50;
const UNAVAILABLE = "Τα εφέ δεν είναι διαθέσιμα.";
const FAULT = "Ένα εφέ σταμάτησε από σφάλμα ήχου.";
const DECKS: DeckId[] = ["A", "B"];

/** A track key as the node takes it (camelotRoot), null when unknown. */
export type FxKey = { pc: number; minor: boolean } | null;

/** The inputs of the last posted clock; a new clock goes out only when one of them changes. */
type ClockInputs = {
  anchor: Anchor | null; loop: EngineLoop | null; wraps: number; grid: BeatGrid | null;
  comp: number; bpm: number | null; playing: boolean;
};

interface Unit {
  deck: DeckId;
  node: AudioWorkletNode;
  insert: PlaybackInsert;
  amount: AudioParam;
  failed: boolean;
  bound: MediaLike | null;
  unwatch: (() => void) | null;
  /** A `seeking` event since the last clock (a Sync nudge fires none). */
  seek: boolean;
  /** undefined until the first poll. */
  trackId: number | null | undefined;
  /** The last posted track message, as a key. */
  track: string;
  clock: ClockInputs | null;
  wrapBase: number;
  /** W was snapped back onto the track's bars at a loop exit: B moved, so pending targets are re-sent. */
  snapped: boolean;
  horizon: number | null;
  /** The store slice the node was last brought in line with. */
  seen: FxRackDeck;
}

let units: Record<DeckId, Unit> | null = null;
let ctx: AudioContext | null = null;
let running = false;
let loading = false;
let failed = false;
let timer: ReturnType<typeof setInterval> | null = null;
let unsubscribe: (() => void) | null = null;
const keys: Record<DeckId, FxKey> = { A: null, B: null };
/** True while the host itself releases a deck (track change, eject, lost BPM, fault, leaving two-deck mode). */
let hostRelease = false;

/** Releases a deck at once from the host: an exit's dry comes back now, not on the next downbeat. */
function releaseNow(deck: DeckId) {
  hostRelease = true;
  try {
    release(deck, true);
  } finally {
    hostRelease = false;
  }
}

const post = (unit: Unit, message: FxToNode) => unit.node.port.postMessage(message);
const off = (d: FxRackDeck): FxRackDeck => ({ ...d, on: false, held: false, releasing: false });
const isPhi = (d: FxRackDeck) => {
  const p = presetById(d.preset);
  return p !== undefined && p.macro && beatsValue(p, deckBeatsIndex(d)) === "phrase";
};

function fail() {
  if (failed) return;
  failed = true;
  setAvailable(false);
  toast.error(UNAVAILABLE);
}

function bind(unit: Unit, media: MediaLike | null) {
  if (media === unit.bound) return;
  unbind(unit);
  if (!media) return;
  setPlaybackInsert(media, unit.insert);
  const onSeeking = () => { unit.seek = true; };
  media.addEventListener("seeking", onSeeking);
  unit.unwatch = () => media.removeEventListener("seeking", onSeeking);
  unit.bound = media;
}

/** Back to the deck's straight wiring; the node keeps ringing its tails into the bus. */
function unbind(unit: Unit) {
  if (unit.bound) setPlaybackInsert(unit.bound, null);
  unit.unwatch?.();
  unit.unwatch = null;
  unit.bound = null;
  unit.clock = null;
  unit.horizon = null;
  unit.wrapBase = 0;
  unit.snapped = false;
}

function engineView(t: { duration: number }, anchor: Anchor, loop: EngineLoop | null, grid: BeatGrid, comp: number, wrapBase: number): EngineView {
  return { anchor, loop, grid, comp, wrapBase, duration: t.duration, now: ctx!.currentTime, sampleRate: ctx!.sampleRate };
}

/** Posts a new clock when its inputs changed, and returns where the deck's beat stands now (null without a tempo). */
function syncClock(unit: Unit): DeckBeat | null {
  const t = deckTransportOf(unit.deck);
  const media = t?.media;
  if (!t || !media || media !== unit.bound || !ctx) return null;
  const now = ctx.currentTime;
  const seek = unit.seek;
  const prev = unit.clock;
  if (t.onEngine && t.engine && t.grid) {
    const { anchor, loop } = t.engine.clock;
    const grid = t.grid;
    const comp = playbackLatency(media);
    if (seek) unit.wrapBase = 0;
    else if (prev?.anchor && prev.grid && (prev.anchor !== anchor || prev.loop !== loop)) {
      // A re-anchor (rate change, loop change, nudge) keeps the wraps so far: B does not move.
      const w = wrapAt(engineView(t, prev.anchor, prev.loop, prev.grid, prev.comp, unit.wrapBase), anchor.output + prev.comp);
      // Leaving a loop: back onto the track's bars (B steps by ≤ 2 b, which the node re-phases like a non-whole wrap).
      unit.wrapBase = prev.loop && !loop ? 4 * Math.round(w / 4) : w;
      if (unit.wrapBase !== w) unit.snapped = true;
    }
    const v = engineView(t, anchor, loop, grid, comp, unit.wrapBase);
    const wraps = wrapAt(v, now);
    const low = unit.horizon !== null && beatAt(v, now) >= unit.horizon - LIST_LOW;
    if (seek || low || !prev || prev.anchor !== anchor || prev.loop !== loop || prev.wraps !== wraps || prev.grid !== grid
      || prev.comp !== comp || prev.bpm !== t.bpm) {
      const { msg, horizon } = engineClock(v, t.bpm, seek);
      post(unit, msg);
      unit.horizon = horizon;
      unit.clock = { anchor, loop, wraps, grid, comp, bpm: t.bpm, playing: anchor.active };
    }
    unit.seek = false;
    return { grid, trusted: gridTrusted(grid), position: positionIn(v, now), wrap: wraps, playing: anchor.active, looping: loop !== null };
  }
  if (seek || !prev || prev.anchor !== null || prev.playing !== t.playing || prev.bpm !== t.bpm) {
    post(unit, plainClock(now, ctx.sampleRate, t.playing, t.bpm, t.rate, seek));
    unit.horizon = null;
    unit.clock = { anchor: null, loop: null, wraps: 0, grid: null, comp: 0, bpm: t.bpm, playing: t.playing };
  }
  unit.seek = false;
  return t.bpm == null ? null : { grid: null, trusted: false, position: 0, wrap: 0, playing: t.playing, looping: false };
}

function postPreset(unit: Unit, d: FxRackDeck) {
  post(unit, { t: "preset", id: d.preset, beats: deckBeatsIndex(d) });
}

function postPhi(unit: Unit) {
  const atBeat = phiBeat(syncClock(unit));
  if (atBeat !== null) post(unit, { t: "release", atBeat });
}

/** Brings the node in line with the store: amount, preset, engage and release (the store owns hold/latch/phrase rules). */
function follow(unit: Unit) {
  const prev = unit.seen;
  const d = getFxRack().decks[unit.deck];
  if (d === prev) return;
  unit.seen = d;
  if (d.amount !== prev.amount) unit.amount.value = d.amount;
  const switched = d.preset !== prev.preset || deckBeatsIndex(d) !== deckBeatsIndex(prev);
  if (switched) postPreset(unit, d);
  if (d.on && (!prev.on || (prev.releasing && !d.releasing))) {
    // A controller paddle bypasses the disabled FX button: a tempo preset on a BPM-less deck never reaches the node.
    const p = presetById(d.preset);
    if (p && needsBpm(p) && deckTransportOf(unit.deck)?.bpm == null) { releaseNow(unit.deck); return; }
    // A press during a pending phrase release engages again, which cancels it.
    const lag = ctx ? (ctx.baseLatency || 0) + (ctx.outputLatency || 0) : 0;
    post(unit, { t: "engage", lag });
    if (isPhi(d)) postPhi(unit);
  } else if (!d.on && prev.on) {
    // A latched exit brings the dry back on the next downbeat; a hold or a host release brings it back at once (§3 Rel).
    const exit = !prev.held && !hostRelease && presetById(prev.preset)?.exit;
    post(unit, { t: "release", atBeat: exit ? "bar" : null });
  } else if (d.on && d.releasing && (!prev.releasing || switched)) {
    // A switch while releasing starts a new voice: the phrase target goes again, after the preset.
    post(unit, { t: "release", atBeat: releaseBeat(syncClock(unit), "phrase") });
  } else if (d.on && !d.releasing && switched && isPhi(d)) {
    postPhi(unit);
  }
}

function pollUnit(unit: Unit) {
  const t = deckTransportOf(unit.deck);
  if (!t) return;
  bind(unit, t.media);
  if (t.trackId !== unit.trackId) {
    // A new track or an eject: no exit may mute the next track and no slicer may replay the old one.
    const first = unit.trackId === undefined;
    unit.trackId = t.trackId;
    unit.track = "";
    unit.clock = null;
    unit.horizon = null;
    unit.wrapBase = 0;
    if (!first) releaseNow(unit.deck);
  }
  const d = getFxRack().decks[unit.deck];
  const preset = presetById(d.preset);
  if (d.on && t.bpm == null && preset && needsBpm(preset)) releaseNow(unit.deck);
  const seek = unit.seek;
  const beat = syncClock(unit);
  const moved = seek || unit.snapped;
  unit.snapped = false;
  // Like MiniPlayer: the element cannot key lock.
  const keylock = t.onEngine && getMixer().fx[unit.deck].keylock;
  const key = keys[unit.deck];
  const track = `${key?.pc ?? ""}|${key?.minor ?? ""}|${keylock}`;
  if (track !== unit.track) {
    // A new track clears `unit.track`; any later change is the same track's key arriving or a key-lock toggle.
    const keep = unit.track !== "";
    unit.track = track;
    post(unit, { t: "track", rootPc: key?.pc ?? null, minor: key?.minor ?? false, keylock, ...(keep && { keep }) });
  }
  const now = getFxRack().decks[unit.deck];
  if (moved && now.on) {
    // B jumped (a seek, or W snapped at a loop exit): the pending release target moves with it.
    if (now.releasing) post(unit, { t: "release", atBeat: releaseBeat(beat, "phrase") });
    else if (isPhi(now)) postPhi(unit);
  }
}

/** The 50 ms poll over both decks. */
export function pollFxRack(): void {
  if (!running || !units) return;
  for (const deck of DECKS) if (!units[deck].failed) pollUnit(units[deck]);
}

function onNode(unit: Unit, data: FxFromNode) {
  if (data?.t === "state") setNodeState(unit.deck, { engaged: data.engaged, tail: data.tail });
  else if (data?.t === "fault") {
    releaseNow(unit.deck);
    toast.error(FAULT);
  }
}

function createUnit(audio: AudioContext, deck: DeckId, create: (ctx: AudioContext) => AudioWorkletNode): Unit {
  const node = create(audio);
  const input = audio.createGain();
  const output = audio.createGain();
  input.connect(node);
  node.connect(output);
  output.connect(masterInput(audio));
  const unit: Unit = {
    deck, node, insert: { input, output, fader: node.parameters.get("fader")! }, amount: node.parameters.get("amount")!,
    failed: false, bound: null, unwatch: null, seek: false, trackId: undefined, track: "", clock: null, wrapBase: 0,
    snapped: false, horizon: null, seen: off(getFxRack().decks[deck]),
  };
  node.port.onmessage = ({ data }: MessageEvent<FxFromNode>) => onNode(unit, data);
  node.onprocessorerror = () => {
    unit.failed = true;
    unbind(unit);
    fail();
  };
  return unit;
}

function begin() {
  if (!units || timer) return;
  unsubscribe = subscribe(() => { if (units) DECKS.forEach(deck => follow(units![deck])); });
  for (const deck of DECKS) {
    const unit = units[deck];
    const d = getFxRack().decks[deck];
    unit.seen = off(d);
    postPreset(unit, d);
    unit.amount.value = d.amount;
    follow(unit);
  }
  timer = setInterval(pollFxRack, POLL_MS);
  pollFxRack();
}

async function load(): Promise<void> {
  if (units || failed || loading) return;
  const audio = playbackContext();
  if (!audio) { fail(); return; }
  loading = true;
  try {
    const { FxRackNotYet, createFxRackNode, loadFxRack } = await import("./fxRackLoader");
    try {
      await loadFxRack(audio);
    } catch (error) {
      // Not yet: try again once the load ends (a late rejection then fails on that pass).
      if (error instanceof FxRackNotYet) { error.loading.then(retry, retry); return; }
      throw error;
    }
    // Built once per context and never disposed: leaving two-deck mode only unbinds them.
    ctx = audio;
    units = { A: createUnit(audio, "A", createFxRackNode), B: createUnit(audio, "B", createFxRackNode) };
  } catch {
    fail();
    return;
  } finally {
    loading = false;
  }
  if (running) begin();
}
const retry = () => { if (running) void load(); };

/** Two-deck mode on: loads the module once, then binds each deck's node to its media and starts the poll. */
export function startFxRack(): Promise<void> {
  running = true;
  if (units) { begin(); return Promise.resolve(); }
  return load();
}

/** Two-deck mode off: releases both decks, unbinds every insert (tails ring out) and stops. */
export function stopFxRack(): void {
  running = false;
  if (!units) return;
  for (const deck of DECKS) releaseNow(deck);
  unsubscribe?.();
  unsubscribe = null;
  if (timer) clearInterval(timer);
  timer = null;
  for (const deck of DECKS) unbind(units[deck]);
}

/** The loaded track's key for a deck (from the player's slots); posted on the next poll. */
export function setFxRackKey(deck: DeckId, key: FxKey): void {
  keys[deck] = key;
}
