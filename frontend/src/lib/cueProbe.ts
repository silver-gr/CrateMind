/**
 * «Έλεγχος εξόδου ακουστικών»: stage 0 of the headphone cue plan (.omc/plans/2026-11-26-headphone-cue.md). A diagnostic the
 * owner runs once at the controller: it loops a tone on output channels 3-4 of the shared context while the master keeps its
 * own `out → destination` edge on 1-2, and logs what the destination reports every 250 ms, so a device change shows.
 *
 * On: destination `discrete`, then 4 channels, both read back, `out` forced stereo (all inside one master dip), then
 * merger → destination and the tone's gain up. Off, also after a failure: tone gain 0, then in one dip the merger off the
 * destination, the destination's count and interpretation as they were, stereo forcing off. The merger is never connected to a
 * destination that did not read back 4 channels and `discrete`: it would down-mix the tone into the speakers.
 * The channel count is held at 4 while it runs: the probe never reacts to a device change, it only logs it.
 */
import { hasMasterBus, setMasterStereo, withMasterDip } from "./audio/masterBus";

export const PROBE_SAMPLE_MS = 250;
/** Ten minutes: a forgotten probe turns itself off. */
export const PROBE_MAX_SAMPLES = 2400;
const TONE_HZ = 880;
const TONE_LEVEL = 0.25;
const RAMP_S = 0.015;

export type ProbeStatus = "idle" | "starting" | "running" | "stopping";
export type ProbeFailure = "no-context" | "host" | "not-running" | "stereo-device" | "refused";
export type ProbeStop = "user" | "left" | "limit";

export const PROBE_FAILURE_TEXT: Record<ProbeFailure, string> = {
  "no-context": "Ο ήχος δεν είναι διαθέσιμος εδώ.",
  host: "Κλείσε πρώτα τα VST3 plugins (Ρυθμίσεις → Αναπαραγωγή) και δοκίμασε ξανά.",
  "not-running": "Βάλε πρώτα ένα κομμάτι να παίζει σε ένα deck και δοκίμασε ξανά.",
  "stereo-device": "Η έξοδος ήχου του Mac δίνει μόνο 2 κανάλια: τα 3–4 δεν είναι διαθέσιμα. Έλεγξε ότι το Mixtrack είναι η έξοδος ήχου του Mac.",
  refused: "Η εφαρμογή δεν μπόρεσε να ανοίξει 4 κανάλια. Ο ήχος έμεινε όπως ήταν. Στείλε μας τα αποτελέσματα.",
};

const STOP_TEXT: Record<ProbeStop, string> = {
  user: "πατήθηκε «Διακοπή»",
  left: "έκλεισε η σελίδα",
  limit: "πέρασαν 10 λεπτά",
};

export interface ProbeSnapshot {
  status: ProbeStatus;
  /** Why the last start did not go through; null after a start that did. */
  failure: ProbeFailure | null;
  lines: readonly string[];
  /** Each `maxChannelCount` value in the order it was seen while the tone played, without repeats in a row. */
  maxSeen: readonly number[];
  /** A run reached the tone and has ended. */
  finished: boolean;
}

export interface ProbeDeps {
  context(): AudioContext | undefined;
  /** The VST3 slots run: `out` is off the speakers, so there is no master to compare with. */
  hostActive(): boolean;
  /** Milliseconds. */
  now(): number;
  /** First line of the log (app version, system). */
  about?: string;
  /** Calls fn every ms until the returned function is called. Default: setInterval. */
  every?(fn: () => void, ms: number): () => void;
}

interface Live {
  ctx: AudioContext;
  before: { count: number; interpretation: ChannelInterpretation };
  source: AudioBufferSourceNode;
  phones: GainNode;
  splitter: ChannelSplitterNode;
  merger: ChannelMergerNode;
  /** The destination was written to. */
  written: boolean;
  /** merger → destination exists. */
  connected: boolean;
  release: (() => void)[];
  last: string;
}

/** Half a second of tone with 10 ms fades, then half a second of silence: a beep that stands out over music. */
function toneBuffer(ctx: BaseAudioContext): AudioBuffer {
  const rate = ctx.sampleRate;
  const buffer = ctx.createBuffer(1, rate, rate);
  const data = buffer.getChannelData(0);
  const length = Math.floor(rate / 2), fade = Math.floor(rate / 100);
  for (let i = 0; i < length; i++) {
    data[i] = Math.sin(2 * Math.PI * TONE_HZ * i / rate) * Math.min(1, i / fade, (length - i) / fade);
  }
  return buffer;
}

function reading(ctx: AudioContext): string {
  const d = ctx.destination;
  return `max=${d.maxChannelCount} count=${d.channelCount} interp=${d.channelInterpretation} state=${ctx.state}`;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** A dip only where there is a bus to dip: the probe never builds one. */
const dip = async (ctx: AudioContext, fn: () => void) => { if (hasMasterBus(ctx)) await withMasterDip(ctx, fn); else fn(); };
const attempt = (fn: () => void) => { try { fn(); } catch { /* one refused step must not stop the rest */ } };

export function createCueProbe(deps: ProbeDeps) {
  let status: ProbeStatus = "idle";
  let failure: ProbeFailure | null = null;
  let lines: string[] = [];
  let maxSeen: number[] = [];
  let finished = false;
  let samples = 0;
  let startedAt = 0;
  let live: Live | null = null;
  let queue: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();
  const view = (): ProbeSnapshot => ({ status, failure, lines, maxSeen, finished });
  let snapshot = view();
  const emit = () => { snapshot = view(); for (const fn of listeners) fn(); };
  const note = (text: string) => { lines.push(`+${((deps.now() - startedAt) / 1000).toFixed(2)}s  ${text}`); };
  const every = deps.every ?? ((fn, ms) => { const id = setInterval(fn, ms); return () => clearInterval(id); });

  function restore(l: Live) {
    const destination = l.ctx.destination;
    attempt(() => { if (l.connected) l.merger.disconnect(destination); });
    l.connected = false;
    if (l.written) {
      attempt(() => { destination.channelCount = l.before.count; });
      attempt(() => { destination.channelInterpretation = l.before.interpretation; });
    }
    l.written = false;
    setMasterStereo(l.ctx, false);
  }

  async function off() {
    const l = live;
    if (!l) return;
    live = null;
    for (const fn of l.release) fn();
    const { gain } = l.phones;
    attempt(() => {
      gain.cancelScheduledValues(l.ctx.currentTime);
      gain.setValueAtTime(gain.value, l.ctx.currentTime);
      gain.linearRampToValueAtTime(0, l.ctx.currentTime + RAMP_S);
    });
    await sleep(RAMP_S * 1000 + 5);
    if (l.written || l.connected) await dip(l.ctx, () => restore(l)).catch(() => {});
    restore(l); // nothing left to do unless the dip itself failed
    attempt(() => l.source.stop());
    for (const node of [l.source, l.phones, l.splitter, l.merger]) attempt(() => node.disconnect());
    note(`μετά: ${reading(l.ctx)}`);
  }

  async function on(): Promise<ProbeFailure | null> {
    const ctx = deps.context();
    if (!ctx) return "no-context";
    const destination = ctx.destination;
    note(`πριν: ${reading(ctx)} mode=${destination.channelCountMode} rate=${ctx.sampleRate} bus=${hasMasterBus(ctx) ? "ναι" : "όχι"}`);
    if (deps.hostActive()) return "host";
    if (ctx.state !== "running") return "not-running";
    if (destination.maxChannelCount < 4) return "stereo-device";

    const phones = ctx.createGain();
    phones.gain.value = 0;
    phones.channelCount = 2;
    phones.channelCountMode = "explicit";
    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(4);
    const source = ctx.createBufferSource();
    source.buffer = toneBuffer(ctx);
    source.loop = true;
    source.connect(phones);
    phones.connect(splitter);
    splitter.connect(merger, 0, 2);
    splitter.connect(merger, 1, 3);
    const l: Live = live = {
      ctx, source, phones, splitter, merger, written: false, connected: false, release: [], last: "",
      before: { count: destination.channelCount, interpretation: destination.channelInterpretation },
    };
    let ok = false as boolean; // written inside the dip
    try {
      await dip(ctx, () => {
        l.written = true;
        try {
          destination.channelInterpretation = "discrete";
          destination.channelCount = 4;
          ok = destination.channelInterpretation === "discrete" && destination.channelCount === 4;
        } catch (error) {
          note(`σφάλμα εγγραφής: ${error instanceof Error ? error.name : String(error)}`);
        }
        if (ok) setMasterStereo(ctx, true);
        else { note(`δεν έγινε δεκτό: ${reading(ctx)}`); restore(l); }
      });
    } catch { ok = false; }
    if (!ok) { await off(); return "refused"; }

    merger.connect(destination);
    l.connected = true;
    source.start();
    phones.gain.setValueAtTime(0, ctx.currentTime);
    phones.gain.linearRampToValueAtTime(TONE_LEVEL, ctx.currentTime + RAMP_S);
    note("ο ήχος δοκιμής παίζει στα κανάλια 3–4");

    const onState = () => { note(`συμβάν statechange: ${ctx.state}`); emit(); };
    ctx.addEventListener("statechange", onState);
    l.release.push(() => ctx.removeEventListener("statechange", onState));
    const devices = globalThis.navigator?.mediaDevices;
    if (devices?.addEventListener) {
      const onDevice = () => { note("συμβάν devicechange"); emit(); };
      devices.addEventListener("devicechange", onDevice);
      l.release.push(() => devices.removeEventListener("devicechange", onDevice));
    }
    l.release.push(every(sample, PROBE_SAMPLE_MS));
    return null;
  }

  /** One log line; the 250 ms timer calls it. */
  function sample() {
    const l = live;
    if (!l || status !== "running") return;
    setMasterStereo(l.ctx, true); // a bus built after the start
    const now = reading(l.ctx);
    note(l.last && now !== l.last ? `${now}  ← άλλαξε` : now);
    l.last = now;
    const max = l.ctx.destination.maxChannelCount;
    if (maxSeen[maxSeen.length - 1] !== max) maxSeen = [...maxSeen, max];
    if (++samples >= PROBE_MAX_SAMPLES) void stop("limit");
    emit();
  }

  /** Starts the tone; does nothing unless idle. The log starts again. */
  function start(): Promise<void> {
    return queue = queue.then(async () => {
      if (status !== "idle") return;
      status = "starting";
      failure = null;
      finished = false;
      lines = deps.about ? [deps.about] : [];
      maxSeen = [];
      samples = 0;
      startedAt = deps.now();
      emit();
      let failed: ProbeFailure | null;
      try {
        failed = await on();
      } catch (error) {
        note(`σφάλμα: ${error instanceof Error ? error.name : String(error)}`);
        await off();
        failed = "refused";
      }
      failure = failed;
      status = failed ? "idle" : "running";
      if (failed) note(`δεν ξεκίνησε: ${PROBE_FAILURE_TEXT[failed]}`);
      else sample();
      emit();
    });
  }

  /** Stops the tone and puts the output back; does nothing unless running. */
  function stop(reason: ProbeStop = "user"): Promise<void> {
    return queue = queue.then(async () => {
      if (status !== "running") return;
      status = "stopping";
      note(`τέλος: ${STOP_TEXT[reason]}`);
      emit();
      await off();
      status = "idle";
      finished = true;
      emit();
    });
  }

  return {
    start, stop, sample,
    snapshot: () => snapshot,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
}

export type CueProbe = ReturnType<typeof createCueProbe>;

/** What the log shows about the channel count, in plain words; null before a run has ended. */
export function probeVerdict(snapshot: Pick<ProbeSnapshot, "finished" | "maxSeen">): string | null {
  if (!snapshot.finished || snapshot.maxSeen.length === 0) return null;
  const seen = snapshot.maxSeen;
  if (seen.length === 1) {
    return `Ο αριθμός καναλιών έμεινε ${seen[0]} σε όλη τη δοκιμή. Αν άλλαξες έξοδο ή έβγαλες το καλώδιο, η εφαρμογή δεν το είδε.`;
  }
  return `Ο αριθμός καναλιών άλλαξε (${seen.join(" → ")}): η εφαρμογή είδε την αλλαγή της εξόδου.`;
}

/** The three things only the owner's ears can tell; they go under the copied log to be answered. */
export const PROBE_QUESTIONS = [
  "Ακούστηκε το μπιπ στα ακουστικά του Mixtrack;",
  "Ακούστηκε το μπιπ από τα ηχεία, έστω και για μια στιγμή; Αν ναι, πότε;",
  "Άλλαξε η μουσική στα ηχεία όσο έπαιζε το μπιπ (ένταση, αριστερά-δεξιά, διακοπές);",
] as const;

/** The text of «Αντιγραφή αποτελεσμάτων». */
export function probeReport(snapshot: Pick<ProbeSnapshot, "finished" | "maxSeen" | "lines">): string {
  const verdict = probeVerdict(snapshot);
  return [
    "CrateMind · Έλεγχος εξόδου ακουστικών",
    ...snapshot.lines,
    ...(verdict ? ["", verdict] : []),
    "",
    ...PROBE_QUESTIONS.map((question, i) => `${i + 1}. ${question} Απάντηση:`),
  ].join("\n");
}

/** The probe is offered only in the macOS desktop app (`nativeHost` is the shell's "os arch"). */
export function cueProbeSupported(desktop: boolean, nativeHost: string | undefined): boolean {
  return desktop && (nativeHost ?? "").split(" ")[0] === "macos";
}
