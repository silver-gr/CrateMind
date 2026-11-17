// The §3 preset table as data: the single source for the UI, the store and the worklet core. The numbers are starting
// points; the owner tunes them by ear, one edit here per change.
import type {
  BeatsSpec, BeatsValue, Curve, CurveInputs, FxFamilyId, FxPreset, GateParams, KeyTune, ReleaseSpec, ShortDelayParams,
} from "./types";

// ---- Curve shorthands ----
const L = (from: number, to: number, by?: "m" | "rho"): Curve => (by ? { c: "L", from, to, by } : { c: "L", from, to });
const E = (from: number, to: number, by?: "m"): Curve => (by ? { c: "E", from, to, by } : { c: "E", from, to });
/** SEND law: w·a^1.5. */
const send = (w: number): Curve => ({ c: "L", from: 0, to: w, pow: 1.5 });
/** A value that moves over `overBeats` beats from engage. */
const overT = (c: "L" | "E", from: number, to: number, overBeats: number): Curve => ({ c, from, to, by: "t", overBeats });
/** Lift's noise level, .3m² (Siren Lift uses half). */
const liftLevel = (w: number): Curve => ({ c: "L", from: 0, to: w, by: "m", pow: 2 });

const opts = (options: readonly BeatsValue[], def: number): BeatsSpec => ({ options, def });
const T: ReleaseSpec = { kind: "T" }, B: ReleaseSpec = { kind: "B" }, C: ReleaseSpec = { kind: "C" }, X: ReleaseSpec = { kind: "X" };
const flanger = (fb: number, periodBeats: number): ShortDelayParams =>
  ({ ms: 6, lfo: { shape: "triangle", lo: 0.3, periodBeats }, fb, mix: 0.5 });
const square = (stepBeats: GateParams["stepBeats"], depth: Curve, edgeMs = 2): GateParams =>
  ({ shape: "square", stepBeats, duty: 0.5, edgeMs, depth });
const ROOT_LOW: KeyTune = { lo: 55, hi: 110 };

/** Slice Gate (43): four one-bar 16-step patterns, x = open. */
export const SLICE_GATE_PATTERNS: readonly string[] = [
  "xx.xx.xx.xx.x.x.",
  "x..xx..xx.x.x..x",
  "x.xxx.x.x.xxx.xx",
  "xxx.xx.xxxx.x.x.",
];

/** Fractal (51): four tables of [16th step, op] in priority order; the first round(L(4→12)) entries apply, one table per bar. */
export const FRACTAL_TABLES = [
  [[3, "repeat"], [7, "reverse"], [11, "repeat"], [15, "up"], [14, "repeat"], [6, "down"], [10, "reverse"], [2, "repeat"], [13, "up"], [5, "reverse"], [9, "repeat"], [1, "down"]],
  [[2, "reverse"], [6, "repeat"], [10, "up"], [14, "reverse"], [15, "repeat"], [7, "repeat"], [11, "down"], [3, "up"], [12, "reverse"], [4, "repeat"], [9, "down"], [13, "repeat"]],
  [[1, "repeat"], [5, "repeat"], [9, "reverse"], [13, "down"], [15, "up"], [11, "repeat"], [7, "reverse"], [3, "repeat"], [14, "up"], [6, "reverse"], [10, "repeat"], [2, "down"]],
  [[4, "up"], [12, "reverse"], [7, "repeat"], [15, "repeat"], [11, "down"], [3, "reverse"], [14, "repeat"], [8, "repeat"], [6, "up"], [10, "reverse"], [13, "repeat"], [2, "repeat"]],
] as const;

/** Scramble (57): permutations of the last bar's slices per slice count (4, 8, 16), alternating per bar. */
export const SCRAMBLE_TABLES: Readonly<Record<number, readonly (readonly number[])[]>> = {
  4: [[0, 2, 1, 3], [2, 0, 3, 1]],
  8: [[0, 3, 2, 5, 4, 1, 6, 7], [4, 1, 6, 3, 0, 5, 2, 7]],
  16: [[0, 5, 2, 7, 4, 1, 6, 3, 8, 13, 10, 15, 12, 9, 14, 11], [8, 1, 10, 3, 12, 5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15]],
};

type Row = Omit<FxPreset, "phrase" | "key" | "noBpm" | "macro" | "star"> & { star?: 0 | 1 | 2; flags?: string };
/** Flags: P phrase release, K key, ∅ no BPM, M macro. */
const row = ({ star = 0, flags = "", ...r }: Row): FxPreset => ({
  ...r, star, phrase: flags.includes("P"), key: flags.includes("K"), noBpm: flags.includes("∅"), macro: flags.includes("M"),
});

/** All 66 presets in table order. */
export const FX_PRESETS: readonly FxPreset[] = [
  // Βασικά
  row({ n: 1, id: "echo", name: "Echo", line: "Ηχώ συγχρονισμένη στο beat", family: "basic", star: 1,
    beats: opts([1 / 4, 1 / 3, 1 / 2, 3 / 4, 1, 1.5, 2], 3), release: T,
    delay: { mode: "digital", timeBeats: "beats", fb: L(0.25, 0.78), loop: [{ type: "hp", hz: 150 }, { type: "lp", hz: 9000 }], drive: 1.2, send: send(0.85) } }),
  row({ n: 2, id: "reverb", name: "Reverb", line: "Αντήχηση χώρου", family: "basic", star: 1,
    beats: opts([2, 4, 8, 16], 1), release: T,
    reverb: { t60Beats: "beats", send: send(0.75), inHp: L(80, 350), damp: 0.35, size: 1 } }),
  row({ n: 3, id: "flanger", name: "Flanger", line: "Jet σάρωση", family: "basic", star: 1,
    beats: opts([1, 2, 4, 8, 16], 3), release: T,
    ins: { shortDelay: { ms: 6, lfo: { shape: "triangle", lo: 0.3, periodBeats: "beats", depth: L(0.5, 1) }, fb: L(0.45, 0.88), mix: 0.5 } } }),
  row({ n: 4, id: "phaser", name: "Phaser", line: "Σάρωση phaser", family: "basic",
    beats: opts([2, 4, 8, 16], 2), release: T,
    ins: { filters: [{ type: "phaser", stages: 6, lo: 250, hi: 4000, fb: L(0.2, 0.7), periodBeats: "beats", mix: 0.5 }] } }),
  row({ n: 5, id: "bit-crusher", name: "Bit Crusher", line: "Τραχύς ψηφιακός ήχος", family: "basic", flags: "∅",
    beats: null, release: X,
    ins: { crusher: { bits: L(16, 3), rateHz: E(48000, 1500), postLp: 0.45 } } }),
  row({ n: 6, id: "gate", name: "Gate", line: "Trance gate", family: "basic", star: 1, flags: "P",
    beats: opts([1 / 8, 1 / 4, 1 / 3, 1 / 2], 1), release: B,
    ins: { gate: square("beats", L(0, 1)) } }),
  row({ n: 7, id: "alarm", name: "Alarm", line: "Δύο τόνοι συναγερμού", family: "basic", flags: "K",
    beats: opts([1 / 2, 1], 0), release: { kind: "X", fadeBeats: 0.5 },
    gens: [{ source: { kind: "tones", hz: 880, key: { lo: 700, hi: 1400 }, interval: 7, q: 2, stepBeats: "beats" }, level: send(0.3) }] }),

  // Reverb & Echo
  row({ n: 8, id: "dub-echo", name: "Dub Echo", line: "Σκοτεινή ηχώ που κρατάει", family: "reverb-echo",
    beats: opts([1 / 2, 3 / 4, 1, 1.5], 1), release: T,
    delay: { mode: "tape", timeBeats: "beats", fb: L(0.45, 0.92), loop: [{ type: "hp", hz: 350 }, { type: "lp", hz: 2500 }], drive: 2,
      wow: { hz: 0.6, ms: 1 }, slewMs: 150, send: send(0.85) } }),
  row({ n: 9, id: "ping-pong-delay", name: "Ping-Pong Delay", line: "Ηχώ αριστερά-δεξιά", family: "reverb-echo", star: 1,
    beats: opts([1 / 4, 1 / 3, 1 / 2, 3 / 4, 1], 3), release: T,
    delay: { mode: "pingpong", timeBeats: "beats", fb: L(0.3, 0.82), loop: [{ type: "hp", hz: 200 }, { type: "lp", hz: 7000 }], send: send(0.85) } }),
  row({ n: 10, id: "polyrhythmic-delay", name: "Polyrhythmic Delay", line: "Δύο ηχώ, η καθεμία σε άλλο ρυθμό", family: "reverb-echo", star: 2,
    beats: opts([[3 / 4, 1], [3 / 4, 1 / 2], [1 / 3, 1 / 2], [3 / 4, 1.25], [1.25, 1]], 0), release: T,
    delay: { mode: "dual", timeBeats: "beats", fb: L(0.3, 0.78), cross: 0.15, pan: [-0.7, 0.7],
      loop: [{ type: "hp", hz: 180 }, { type: "lp", hz: 8000 }], send: send(0.85) } }),
  row({ n: 11, id: "tape-echo", name: "Tape Echo", line: "Ηχώ ταινίας", family: "reverb-echo",
    beats: opts([1 / 2, 3 / 4, 1], 0), release: T,
    delay: { mode: "tape", timeBeats: "beats", fb: L(0.3, 0.85), drive: L(1, 3), loop: [{ type: "hp", hz: 120 }, { type: "lp", hz: 4500 }],
      wow: { hz: 0.8, ms: 1.5 }, flutter: { hz: 7, ms: 0.15 }, slewMs: 80, send: send(0.8) } }),
  row({ n: 12, id: "complex-reverb", name: "Complex Reverb", line: "Βαθύ, πλούσιο reverb", family: "reverb-echo",
    beats: opts([4, 8, 16, 32], 1), release: T,
    reverb: { t60Beats: "beats", size: 1.3, preDelayBeats: 0.25, mod: 2, damp: 0.25, inHp: L(100, 400), send: send(0.7) } }),
  row({ n: 13, id: "shimmer", name: "Shimmer", line: "Λαμπερό reverb μια οκτάβα πάνω", family: "reverb-echo",
    beats: opts([8, 16, 32], 1), release: T,
    reverb: { t60Beats: "beats", shimmer: L(0.15, 0.35), inHp: 400, damp: 0.1, send: send(0.65) } }),
  row({ n: 14, id: "echo-out", name: "Echo Out", line: "Έξοδος: μένει μόνο η ηχώ", family: "reverb-echo", star: 1, flags: "P",
    beats: opts([1 / 2, 3 / 4, 1, 2], 2), release: T, exit: { overBeats: 1 },
    delay: { mode: "digital", timeBeats: "beats", fb: L(0.55, 0.85), loop: [{ type: "hp", hz: overT("E", 150, 600, 8) }], send: 0.9 } }),
  row({ n: 15, id: "echo-out-plus", name: "Echo Out+", line: "Έξοδος σε ηχώ που λεπταίνει", family: "reverb-echo", flags: "P",
    beats: opts([3 / 4, 1, 1.5], 0), release: T, exit: { overBeats: 1 },
    delay: { mode: "digital", timeBeats: "beats", fb: L(0.7, 0.9), loop: [{ type: "hp", hz: overT("E", 150, 1500, 8) }], send: 0.9 },
    reverb: { t60Beats: 4, send: 0.3 } }),
  row({ n: 16, id: "echoverb-out", name: "EchoVerb Out", line: "Έξοδος σε ηχώ και reverb", family: "reverb-echo", flags: "P",
    beats: opts([1, 2, 4], 1), release: T, exit: { overBeats: "beats" },
    delay: { mode: "digital", timeBeats: 3 / 4, fb: 0.65, send: 0.8, intoReverb: true },
    reverb: { t60Beats: 8, send: L(0.4, 0.8) } }),
  row({ n: 17, id: "reverb-out", name: "Reverb Out", line: "Έξοδος σε reverb", family: "reverb-echo", flags: "P",
    beats: opts([1, 2, 4], 1), release: T, exit: { overBeats: "beats" },
    reverb: { t60Beats: L(4, 16), inHp: 200, send: 0.8 } }),

  // Θόρυβος & Sweep
  row({ n: 18, id: "noise-sweep", name: "Noise Sweep", line: "Θόρυβος με φίλτρο που ανεβαίνει", family: "noise", star: 1, flags: "∅",
    beats: null, release: { kind: "X", fadeMs: 200 },
    gens: [{ source: { kind: "noise" }, level: L(0, 0.25), filters: [{ type: "bp", hz: E(200, 12000), q: 1.5 }] }] }),
  row({ n: 19, id: "noise-gate", name: "Noise Gate", line: "Θόρυβος κομμένος στο beat", family: "noise",
    beats: opts([1 / 8, 1 / 4, 1 / 2], 1), release: B,
    gens: [{ source: { kind: "noise" }, level: L(0, 0.25), filters: [{ type: "hp", hz: 2000 }], gate: square("beats", 1) }] }),
  row({ n: 20, id: "noise-pump", name: "Noise Pump", line: "Θόρυβος που φουσκώνει ανάμεσα στα kick", family: "noise",
    beats: opts([1, 1 / 2], 0), release: B,
    gens: [{ source: { kind: "noise" }, level: L(0, 0.3), filters: [{ type: "hp", hz: E(500, 4000) }],
      gate: { shape: "pump", stepBeats: "beats", depth: 1, tauBeats: 0.25, attackMs: 1, invert: true } }] }),
  row({ n: 21, id: "noise-layer", name: "Noise Layer", line: "Θόρυβος που ακολουθεί τα χτυπήματα", family: "noise", flags: "∅",
    beats: null, release: X,
    gens: [{ source: { kind: "noise" }, level: L(0, 0.5), filters: [{ type: "hp", hz: 3000 }], follow: { attackMs: 1, releaseMs: 40 } }] }),
  row({ n: 22, id: "clap-layer", name: "Clap Layer", line: "Συνθετικό clap στο ρυθμό", family: "noise",
    beats: opts([{ hits: "2&4" }, { hits: "every" }, { hits: "off" }], 0), release: T,
    gens: [{ source: { kind: "clap", bursts: 3, gapMs: 10, tailMs: 120, hz: 1200 }, level: L(0, 1.4), rms: true, hits: "beats" }] }),
  row({ n: 23, id: "backbeat", name: "Backbeat", line: "Συνθετικό snare στο 2 και 4", family: "noise",
    beats: opts([{ hits: "2&4" }, { hits: "off" }], 0), release: T,
    gens: [{ source: { kind: "snare", bodyHz: 190, dropPct: 10, dropMs: 30, bodyDecayMs: 80, noiseHz: 2500, noiseDecayMs: 150 },
      level: L(0, 1.4), rms: true, hits: "beats" }] }),

  // Macro: άνοδος
  row({ n: 24, id: "haze", name: "Haze", line: "Θολώνει με reverb και λιγότερα ψηλά", family: "macro-up", flags: "PM",
    beats: opts([4, 8, 16, "phrase"], 1), release: T,
    ins: { filters: [{ type: "lp", hz: E(20000, 2500, "m") }] },
    reverb: { t60Beats: 8, send: L(0, 0.8, "m") },
    delay: { mode: "digital", timeBeats: 3 / 4, fb: L(0, 0.4, "m"), send: L(0, 0.5, "m") } }),
  row({ n: 25, id: "lift", name: "Lift", line: "Θόρυβος και high-pass ως το drop", family: "macro-up", star: 1, flags: "PM",
    beats: opts([8, 16, 32, "phrase"], 1), release: { kind: "C", genFadeBeats: 0.5 },
    ins: { filters: [{ type: "hp", hz: E(20, 900, "m") }] },
    gens: [{ source: { kind: "noise" }, level: liftLevel(0.3), filters: [{ type: "bp", hz: E(400, 10000, "m"), q: L(1, 3, "m") }],
      reverb: { t60Beats: 4, wet: 0.5 } }] }),
  row({ n: 26, id: "launch", name: "Launch", line: "Roll που επιταχύνει και ανεβαίνει", family: "macro-up", flags: "PM",
    beats: opts([2, 4, 8, "phrase"], 1), release: C,
    ins: { slicer: { prog: "roll", sizeBeats: 1 / 2, schedule: { sizes: [1 / 2, 1 / 4, 1 / 8, 1 / 16], at: [0, 0.25, 0.5, 0.75] }, pitchSt: L(0, 12, "m") },
      filters: [{ type: "hp", hz: E(20, 1200, "m") }] } }),
  row({ n: 27, id: "geyser", name: "Geyser", line: "Έκρηξη θορύβου με flanger", family: "macro-up", flags: "M",
    beats: opts([2, 4, 8], 1), release: { kind: "X", fadeBeats: 0.5 },
    ins: { filters: [{ type: "hp", hz: E(20, 600, "m") }] },
    gens: [{ source: { kind: "noise" }, level: L(0, 0.35, "m"), flanger: flanger(0.8, 1) }] }),
  row({ n: 28, id: "siren-lift", name: "Siren Lift", line: "Σειρήνα στον τόνο του κομματιού που ανεβαίνει", family: "macro-up", flags: "PKM",
    beats: opts([8, 16, "phrase"], 1), release: C,
    gens: [
      { source: { kind: "tones", hz: 880, key: { lo: 700, hi: 1400 }, interval: 7, q: 2, stepBeats: 1 / 2, transposeSt: L(0, 12, "m") }, level: send(0.3) },
      { source: { kind: "noise" }, level: liftLevel(0.15), filters: [{ type: "bp", hz: E(400, 10000, "m"), q: L(1, 3, "m") }],
        reverb: { t60Beats: 4, wet: 0.5 } },
    ] }),
  row({ n: 29, id: "euphoria", name: "Euphoria", line: "Ανοιχτό build με gate, reverb και echo", family: "macro-up", flags: "PM",
    beats: opts([8, 16, 32, "phrase"], 1), release: C,
    ins: { filters: [{ type: "hp", hz: E(20, 500, "m") }], gate: square(1 / 4, L(0, 0.8, "m")) },
    reverb: { t60Beats: 8, send: L(0, 0.4, "m") },
    delay: { mode: "digital", timeBeats: 3 / 4, fb: L(0, 0.5, "m"), send: L(0, 0.5, "m") } }),
  row({ n: 30, id: "afterburner", name: "Afterburner", line: "Jet flanger με θόρυβο και high-pass", family: "macro-up", flags: "PM",
    beats: opts([4, 8, 16, "phrase"], 1), release: C,
    ins: { filters: [{ type: "hp", hz: E(20, 700, "m") }], shortDelay: { ms: E(6, 0.3, "m"), fb: 0.85, mix: 0.5 } },
    gens: [{ source: { kind: "noise" }, level: L(0, 0.2, "m"), filters: [{ type: "hp", hz: 3000 }] }] }),

  // Macro: κάθοδος
  row({ n: 31, id: "touchdown", name: "Touchdown", line: "Προσγείωση με low-pass και reverb", family: "macro-down", flags: "M",
    beats: opts([4, 8, 16], 0), release: T,
    ins: { filters: [{ type: "lp", hz: E(20000, 300, "m") }] },
    reverb: { t60Beats: 8, send: L(0, 0.5, "m") },
    delay: { mode: "digital", timeBeats: 1, fb: L(0, 0.5, "m"), send: L(0, 0.5, "m") } }),
  row({ n: 32, id: "shudder", name: "Shudder", line: "Σβήνει με επαναλήψεις 1/16", family: "macro-down", flags: "M",
    beats: opts([1, 2, 4], 1), release: B,
    ins: { slicer: { prog: "roll", sizeBeats: 1 / 4, repeatGain: L(1, 0.5, "m") }, filters: [{ type: "lp", hz: E(20000, 1500, "m") }] } }),
  row({ n: 33, id: "ember", name: "Ember", line: "Ήπιο σβήσιμο με echo και low-pass", family: "macro-down", flags: "M",
    beats: opts([8, 16], 0), release: T,
    ins: { filters: [{ type: "lp", hz: E(20000, 800, "m") }], gainDb: L(0, 20 * Math.log10(0.4), "m") },
    delay: { mode: "digital", timeBeats: 1, fb: L(0.4, 0.75, "m"), send: send(0.5) },
    reverb: { t60Beats: 8, send: L(0, 0.3, "m") } }),
  row({ n: 34, id: "horizon", name: "Horizon", line: "Ο ήχος απομακρύνεται", family: "macro-down", flags: "M",
    beats: opts([4, 8, 16], 1), release: T,
    ins: { filters: [{ type: "hp", hz: E(20, 250, "m") }, { type: "lp", hz: E(20000, 1800, "m") }], gainDb: L(0, -12, "m") },
    reverb: { t60Beats: 8, preDelayBeats: 0.25, send: L(0, 0.7, "m") } }),
  row({ n: 35, id: "deep-dive", name: "Deep Dive", line: "Υποβρύχιος ήχος", family: "macro-down", flags: "KM",
    beats: opts([2, 4, 8], 1), release: { kind: "X", fadeBeats: 1 },
    ins: { filters: [{ type: "lp", hz: E(20000, 350, "m"), q: 4, key: { ...ROOT_LOW, mul: 4 } }],
      shortDelay: { ms: 8, lfo: { shape: "sine", lo: 3, hz: 0.25 }, fb: 0.3, mix: L(0, 0.4, "m") } } }),

  // Φίλτρα
  row({ n: 36, id: "lowpass", name: "Lowpass", line: "Κόβει τα ψηλά", family: "filters", flags: "∅",
    beats: null, release: { kind: "X", fadeMs: 50 },
    ins: { filters: [{ type: "lp", hz: E(20000, 150), q: L(0.7, 4) }] } }),
  row({ n: 37, id: "highpass", name: "Highpass", line: "Κόβει τα χαμηλά για build-up", family: "filters", star: 1, flags: "P∅",
    beats: null, release: X,
    ins: { filters: [{ type: "hp", hz: E(20, 2500), q: L(0.7, 3) }] } }),
  row({ n: 38, id: "bandpass", name: "Bandpass", line: "Μόνο τα μεσαία", family: "filters", flags: "∅",
    beats: null, release: X,
    ins: { filters: [{ type: "bp", hz: E(150, 6000), q: 2.5 }] } }),
  row({ n: 39, id: "auto-filter", name: "Auto Filter", line: "Φίλτρο που κινείται στο beat", family: "filters", star: 1,
    beats: opts([1 / 4, 1 / 2, 1, 2, 4, 8], 3), release: X,
    ins: { filters: [{ type: "lp", hz: E(800, 12000), q: 2.5, lfo: { shape: "sine", lo: 400, periodBeats: "beats" } }] } }),
  row({ n: 40, id: "lofi", name: "LoFi", line: "Παλιός, θαμπός ήχος", family: "filters", flags: "∅",
    beats: null, release: X,
    ins: { crusher: { bits: L(12, 6), rateHz: E(16000, 4000) }, filters: [{ type: "lp", hz: E(12000, 3500) }, { type: "hp", hz: L(20, 250) }] } }),

  // Κοψίματα
  row({ n: 41, id: "simple-gate", name: "Simple Gate", line: "Απλό gate στο beat", family: "cuts", flags: "P",
    beats: opts([1 / 4, 1 / 2, 1], 1), release: B,
    ins: { gate: square("beats", L(0, 1), 1) } }),
  row({ n: 42, id: "tremolo-gate", name: "Tremolo Gate", line: "Ομαλό tremolo", family: "cuts",
    beats: opts([1 / 4, 1 / 3, 1 / 2, 1], 0), release: B,
    ins: { gate: { shape: "sine", stepBeats: "beats", depth: L(0, 1) } } }),
  row({ n: 43, id: "slice-gate", name: "Slice Gate", line: "Gate με μοτίβο 16 βημάτων", family: "cuts", flags: "P",
    beats: opts([{ pattern: 0 }, { pattern: 1 }, { pattern: 2 }, { pattern: 3 }], 0), release: B,
    ins: { gate: { shape: "pattern", stepBeats: 1 / 4, edgeMs: 2, depth: L(0, 1) } } }),
  row({ n: 44, id: "sidechain", name: "Sidechain", line: "Pump σαν sidechain από το kick", family: "cuts", star: 1, flags: "P",
    beats: opts([1, 1 / 2], 0), release: B,
    ins: { gate: { shape: "pump", stepBeats: "beats", attackMs: 1, depth: L(0.3, 0.95), tauBeats: L(0.25, 0.15) } } }),

  // Slice
  row({ n: 45, id: "flashback", name: "Flashback", line: "Ξαναπαίζει το προηγούμενο μέτρο, και ανάποδα", family: "slice",
    beats: opts([1, 2, 4], 1), release: B,
    ins: { slicer: { prog: "replay", backBeats: 4, lenBeats: "beats", sliceBeats: 1 / 2, reverseChance: L(0, 0.5) } } }),
  row({ n: 46, id: "warp-hop", name: "Warp Hop", line: "Τυχαία κομμάτια από τα δύο τελευταία μέτρα", family: "slice",
    beats: opts([1 / 4, 1 / 2, 1], 1), release: { kind: "B", sendsT: true },
    ins: { slicer: { prog: "random", sourceBeats: 8, sliceBeats: "beats", pan: 0.6 } },
    delay: { mode: "pingpong", timeBeats: 3 / 4, fb: 0.4, send: L(0, 1) } }),
  row({ n: 47, id: "tri-step", name: "Tri-Step", line: "Τρίηχα κομμάτια σε μοτίβο", family: "slice",
    beats: opts([1 / 3, 2 / 3], 0), release: B,
    ins: { slicer: { prog: "order", sourceBeats: 2, sliceBeats: "beats", order: [0, 0, 2, 0, 1, 2] },
      gate: { ...square("beats", L(0, 1)), stepMul: 2 } } }),
  row({ n: 48, id: "rapid-fire", name: "Rapid Fire", line: "Ριπή που πυκνώνει", family: "slice",
    beats: opts([1, 2, 4], 1), release: B,
    ins: { slicer: { prog: "roll", sizeBeats: 1 / 4, schedule: { sizes: [1 / 4, 1 / 8, 1 / 16], at: [0, 1 / 3, 2 / 3] } },
      filters: [{ type: "hp", hz: 300 }, { type: "peak", hz: 2000, q: 1, gainDb: L(0, 6) }] } }),
  row({ n: 49, id: "buzz-cut", name: "Buzz Cut", line: "Πολύ κοντές επαναλήψεις που βουίζουν", family: "slice",
    beats: opts([1 / 32, 1 / 16], 1), release: B,
    ins: { slicer: { prog: "roll", sizeBeats: "beats", vibrato: { st: L(0, 1), hz: 6 } }, filters: [{ type: "lp", hz: E(20000, 4000) }] } }),

  // Juggle
  row({ n: 50, id: "roll", name: "Roll", line: "Επαναλαμβάνει το τελευταίο κομμάτι στο beat", family: "juggle", star: 1,
    beats: opts([1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2], 2), release: B,
    ins: { slicer: { prog: "roll", sizeBeats: "beats" }, mix: L(0, 1) } }),
  row({ n: 51, id: "fractal", name: "Fractal", line: "Μοτίβο με επαναλήψεις, reverse και οκτάβες", family: "juggle",
    beats: opts([1 / 4, 1 / 2], 0), release: B,
    ins: { slicer: { prog: "fractal", stepBeats: "beats", altered: L(4, 12), tables: FRACTAL_TABLES } } }),
  row({ n: 52, id: "bounce", name: "Bounce", line: "Αναπηδητικό μοτίβο από kick και μπάσο", family: "juggle",
    beats: opts([1 / 2, 1], 0), release: B,
    ins: { slicer: { prog: "roll", sizeBeats: "beats", anchor: "beat" },
      gate: { shape: "pump", stepBeats: "beats", depth: 0.8, tauBeats: 0.2, attackMs: 1 },
      filters: [{ type: "lp", hz: E(20000, 1500) }] } }),
  row({ n: 53, id: "sub-shot", name: "Sub Shot", line: "Επαναλήψεις του kick στα χαμηλά", family: "juggle", flags: "K",
    beats: opts([1 / 8, 1 / 4], 1), release: B,
    ins: { slicer: { prog: "roll", sizeBeats: "beats", anchor: "beat" },
      filters: [{ type: "lp", hz: 250, key: { ...ROOT_LOW, mul: 4 } }], gainDb: L(0, 3) } }),
  row({ n: 54, id: "daybreak", name: "Daybreak", line: "Roll που επιταχύνει ως τη φράση", family: "juggle", star: 1, flags: "PM",
    beats: opts([4, 8, 16, "phrase"], 1), release: C,
    ins: { slicer: { prog: "roll", sizeBeats: 1 / 2, schedule: { sizes: [1 / 2, 1 / 4, 1 / 8, 1 / 16], at: [0, 0.4, 0.7, 0.9] }, pitchSt: L(0, 7, "m") },
      filters: [{ type: "hp", hz: E(20, 800, "m") }] } }),
  row({ n: 55, id: "chromatic-juggle", name: "Chromatic Juggle", line: "Επαναλήψεις που ανεβαίνουν ημιτόνιο-ημιτόνιο", family: "juggle", star: 2,
    beats: opts([1 / 4, 1 / 2, 1], 1), release: B,
    ins: { slicer: { prog: "chromatic", windowBeats: "beats", slots: L(4, 13) } } }),
  row({ n: 56, id: "freeform", name: "Freeform", line: "Τυχαίο μοτίβο σε κάθε μέτρο", family: "juggle",
    beats: opts([1 / 8, 1 / 4, 1 / 2], 1), release: B,
    ins: { slicer: { prog: "freeform", stepBeats: "beats", chance: L(0, 1) } } }),
  row({ n: 57, id: "scramble", name: "Scramble", line: "Ανακατεύει τα κομμάτια του μέτρου", family: "juggle",
    beats: opts([1 / 4, 1 / 2, 1], 1), release: B,
    ins: { slicer: { prog: "scramble", sourceBeats: 4, sliceBeats: "beats", tables: SCRAMBLE_TABLES }, mix: L(0, 1) } }),
  row({ n: 58, id: "saucer", name: "Saucer", line: "Κομμάτια με τόνο που γλιστράει, με flanger", family: "juggle",
    beats: opts([1 / 4, 1 / 2, 1], 1), release: { kind: "B", sendsT: true },
    ins: { slicer: { prog: "glide", sliceBeats: "beats", glideSt: L(1, 5) }, shortDelay: flanger(0.6, 4) },
    reverb: { t60Beats: 8, send: 0.3 } }),

  // Συντονισμός
  row({ n: 59, id: "frost-comb", name: "Frost Comb", line: "Συντονισμένη ηχώ στον τόνο, με λαμπερό reverb", family: "resonance", flags: "K",
    beats: opts([8, 16, 32], 1), release: T,
    delay: { mode: "comb", combHz: 110, key: ROOT_LOW, fb: L(0.6, 0.95), loop: [{ type: "lp", hz: 6000 }], send: send(0.6), intoReverb: true },
    reverb: { t60Beats: "beats", shimmer: 0.25, send: send(0.6) } }),
  row({ n: 60, id: "pulse-verb", name: "Pulse Verb", line: "Reverb κομμένο στο ρυθμό", family: "resonance",
    beats: opts([1 / 4, 1 / 2, 1], 0), release: T,
    reverb: { t60Beats: 8, send: send(0.8), gate: square("beats", 1) } }),
  row({ n: 61, id: "strobe-pan", name: "Strobe Pan", line: "Gate που πηγαίνει αριστερά-δεξιά", family: "resonance",
    beats: opts([1 / 4, 1 / 2, 1], 0), release: B,
    ins: { gate: { shape: "pan", stepBeats: "beats", depth: L(0, 1) } } }),
  row({ n: 62, id: "grinder", name: "Grinder", line: "Gate, crusher και stutter μαζί", family: "resonance",
    beats: null, release: B,
    ins: { slicer: { prog: "roll", sizeBeats: 1 / 16, steps: [13, 16] }, gate: square(1 / 4, L(0, 1)),
      crusher: { bits: L(10, 4), rateHz: E(24000, 3000) } } }),
  row({ n: 63, id: "vortex-echo", name: "Vortex Echo", line: "Echo με φίλτρο που σαρώνει", family: "resonance",
    beats: opts([2, 4, 8], 1), release: T,
    delay: { mode: "digital", timeBeats: 3 / 4, fb: L(0.5, 0.85),
      loop: [{ type: "bp", hz: 5000, q: 3, lfo: { shape: "triangle", lo: 400, periodBeats: "beats" } }], send: send(0.85) } }),

  // Psytrance
  row({ n: 64, id: "brake", name: "Brake", line: "Σταμάτημα σαν πικάπ ή ταινία", family: "psytrance", star: 1,
    beats: opts([1 / 2, 1, 2], 0), release: { kind: "X", fadeMs: 10 },
    ins: { slicer: { prog: "brake", lpFollow: L(0, 1) } } }),
  row({ n: 65, id: "reverse", name: "Reverse", line: "Παίζει ανάποδα από το πάτημα", family: "psytrance", star: 1, flags: "∅",
    beats: null, release: B,
    ins: { slicer: { prog: "reverse" }, mix: L(0, 1) } }),
  row({ n: 66, id: "spinback", name: "Spinback", line: "Γρήγορο γύρισμα πίσω και σβήσιμο", family: "psytrance",
    beats: opts([1 / 2, 1, 2], 1), release: X,
    ins: { slicer: { prog: "spin", rate: L(-1, -3, "rho") }, filters: [{ type: "lp", hz: E(20000, 2000) }] } }),
];

/** Picker families, in order, with their Greek headings. */
export const FX_FAMILIES: readonly { id: FxFamilyId; label: string }[] = [
  { id: "basic", label: "Βασικά" },
  { id: "reverb-echo", label: "Reverb & Echo" },
  { id: "noise", label: "Θόρυβος & Sweep" },
  { id: "macro-up", label: "Macro: άνοδος" },
  { id: "macro-down", label: "Macro: κάθοδος" },
  { id: "filters", label: "Φίλτρα" },
  { id: "cuts", label: "Κοψίματα" },
  { id: "slice", label: "Slice" },
  { id: "juggle", label: "Juggle" },
  { id: "resonance", label: "Συντονισμός" },
  { id: "psytrance", label: "Psytrance" },
];

/** Default favourites, in order (rows 10, 55, 1, 6, 3, 25, 54, 50, 64, 14). */
export const DEFAULT_FAVOURITES: readonly string[] = [
  "polyrhythmic-delay", "chromatic-juggle", "echo", "gate", "flanger", "lift", "daybreak", "roll", "brake", "echo-out",
];
/** First run: this preset on both decks at this amount. */
export const DEFAULT_PRESET_ID = "polyrhythmic-delay";
export const DEFAULT_AMOUNT = 0.7;

const byId = new Map(FX_PRESETS.map(p => [p.id, p]));
/** Preset by id, or undefined. */
export const presetById = (id: string): FxPreset | undefined => byId.get(id);
/** Presets of one family, in table order. */
export const presetsOfFamily = (family: FxFamilyId): FxPreset[] => FX_PRESETS.filter(p => p.family === family);
/** Tempo presets (all but ∅) need a BPM. */
export const needsBpm = (p: FxPreset): boolean => !p.noBpm;

/** Every beat division a preset may use: the label in beats (like djay) and the note value (beat = quarter note). */
export const BEAT_DIVISIONS: readonly { beats: number; label: string; note: string }[] = [
  { beats: 1 / 32, label: "1/32", note: "1/128" },
  { beats: 1 / 16, label: "1/16", note: "1/64" },
  { beats: 1 / 8, label: "⅛", note: "1/32" },
  { beats: 1 / 4, label: "¼", note: "1/16" },
  { beats: 1 / 3, label: "⅓", note: "1/8T" },
  { beats: 1 / 2, label: "½", note: "1/8" },
  { beats: 2 / 3, label: "⅔", note: "1/4T" },
  { beats: 3 / 4, label: "¾", note: "3/16" },
  { beats: 1, label: "1", note: "1/4" },
  { beats: 1.25, label: "1¼", note: "5/16" },
  { beats: 1.5, label: "1½", note: "3/8" },
  { beats: 2, label: "2", note: "1/2" },
  { beats: 4, label: "4", note: "1 μέτρο" },
  { beats: 8, label: "8", note: "2 μέτρα" },
  { beats: 16, label: "16", note: "4 μέτρα" },
  { beats: 32, label: "32", note: "8 μέτρα" },
];
const division = (beats: number) => BEAT_DIVISIONS.find(d => Math.abs(d.beats - beats) < 1e-9);
const HIT_TEXT = { "2&4": ["2&4", "στο 2 και στο 4"], every: ["Όλα", "σε κάθε beat"], off: ["&", "στα off-beat"] } as const;
const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** Short stepper label of a BEATS choice, e.g. "¾", "¾·1", "Φ", "Μ2" (μοτίβο), "2&4". */
export function beatsLabel(v: BeatsValue): string {
  if (typeof v === "number") return division(v)?.label ?? String(v);
  if (v === "phrase") return "Φ";
  if ("pattern" in v) return `Μ${v.pattern + 1}`;
  if ("hits" in v) return HIT_TEXT[v.hits][0];
  return `${beatsLabel(v[0])}·${beatsLabel(v[1])}`;
}
/** Second line of a BEATS choice: the note value, a pair's ratio, or what it means, e.g. "3/16", "3:4", «ως τη φράση». */
export function beatsNote(v: BeatsValue): string {
  if (typeof v === "number") return division(v)?.note ?? "";
  if (v === "phrase") return "ως τη φράση";
  if ("pattern" in v) return `Μοτίβο ${v.pattern + 1}`;
  if ("hits" in v) return HIT_TEXT[v.hits][1];
  const a = Math.round(v[0] * 12), b = Math.round(v[1] * 12), g = gcd(a, b);
  return `${a / g}:${b / g}`;
}

/** A valid BEATS index for `p`: `index` when in range, else the preset's default (0 for a preset without BEATS). */
export function beatsIndex(p: FxPreset, index: number | undefined): number {
  if (!p.beats) return 0;
  return index !== undefined && Number.isInteger(index) && index >= 0 && index < p.beats.options.length ? index : p.beats.def;
}
/** The BEATS choice at `index` (sanitised), or null for a preset without BEATS. */
export const beatsValue = (p: FxPreset, index: number | undefined): BeatsValue | null =>
  p.beats ? p.beats.options[beatsIndex(p, index)] : null;

/** Evaluates a parameter at the given inputs; drivers are clamped to 0..1. */
export function curveValue(c: Curve, v: CurveInputs): number {
  if (typeof c === "number") return c;
  const raw = c.by === "m" ? v.m : c.by === "rho" ? v.rho : c.by === "t" ? v.t / (c.overBeats ?? 1) : v.a;
  const x = Math.max(0, Math.min(1, raw)) ** (c.pow ?? 1);
  return c.c === "E" ? c.from * (c.to / c.from) ** x : c.from + (c.to - c.from) * x;
}

/** K: the root (pitch class, C = 0) folded into [lo, hi) Hz times `mul`, or `fixed` when the key is unknown. The caller applies the rate. */
export function keyHz(rootPc: number | null, key: KeyTune, fixed: number): number {
  if (rootPc === null || !Number.isFinite(rootPc)) return fixed;
  let f = 440 * 2 ** ((rootPc - 9) / 12);
  while (f < key.lo) f *= 2;
  while (f >= key.hi) f /= 2;
  return f * (key.mul ?? 1);
}
