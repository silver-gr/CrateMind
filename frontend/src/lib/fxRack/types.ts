// Deck FX rack contract: preset data shapes, the main-thread <-> worklet messages, and the pieces the core and the
// slicer share. No DOM or worklet globals: the worklet core and bun tests import this file directly.

/** AudioWorklet processor name registered by fx-rack.worklet.js. */
export const FX_RACK_PROCESSOR = "cratemind-fx-rack";

/** AudioWorkletNode options: one stereo input and one stereo output, channel count explicit (§1 Graph). */
export const FX_RACK_NODE_OPTIONS: AudioWorkletNodeOptions = {
  numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2,
  channelCountMode: "explicit", channelInterpretation: "speakers",
};

/** The node's two k-rate AudioParams: `amount` is the knob (0..1); `fader` mirrors the deck's `master.gain` (default 1). */
export type FxRackParamName = "amount" | "fader";
/** `parameterDescriptors` of the processor. */
export const FX_RACK_PARAMS = [
  { name: "amount", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
  { name: "fader", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" },
] as const;
/** The param arrays `process()` receives (length 1 for k-rate). */
export type FxRackParamValues = Record<FxRackParamName, Float32Array>;

// ---- Messages (§1 Messages) ----

/** Clock: `knots` are [frame, beat, …] (frame = round(t·fs)), null for an element deck that counts B from engage at `bpm`. */
export type FxClockMsg = {
  t: "clock";
  /** Frame (currentFrame scale) from which this clock applies; the node keeps the old one until then. */
  validFrom: number;
  playing: boolean;
  knots: number[] | null;
  /** The track's BPM at rate 1; null without BPM. */
  bpm: number | null;
  /** Deck playback rate. */
  rate: number;
  /** Trusted grid (`!estimated || overridden`): B counts from the bar-1 downbeat; otherwise from the engage frame. */
  trusted: boolean;
  /** True only after the media's `seeking` event: resets the wrap offset and the capture ring (a Sync nudge is not a seek). */
  seek: boolean;
};
/** Track key and key lock: rootHz = root × (keylock ? 1 : rate); `rootPc` is the pitch class 0..11 (C = 0), null when unknown. Resets the capture ring and returns an exit's dry, unless `keep` (same track: only the key or key lock changed). */
export type FxTrackMsg = { t: "track"; rootPc: number | null; minor: boolean; keylock: boolean; keep?: boolean };
/** Selected preset and its BEATS choice, as an index into `preset.beats.options` (0 when the preset has none). */
export type FxPresetMsg = { t: "preset"; id: string; beats: number };
/** Engage the selected preset; `lag` = baseLatency + outputLatency in seconds (0 when unknown). */
export type FxEngageMsg = { t: "engage"; lag: number };
/** Release: null = now, a number = at that B (also a Φ ramp's end), "bar" = the node's next multiple of 4 (untrusted grids). */
export type FxReleaseMsg = { t: "release"; atBeat: number | "bar" | null };
/** Everything the host posts to the node. Amount and fader travel as AudioParams, not messages. */
export type FxToNode = FxClockMsg | FxTrackMsg | FxPresetMsg | FxEngageMsg | FxReleaseMsg;

/** Node -> host: `ready` once rendering, `state` on change, `fault` after it has reset itself to dry. */
export type FxFromNode = { t: "ready" } | { t: "state"; engaged: boolean; tail: boolean } | { t: "fault" };

// ---- Preset data (§3) ----

/**
 * A parameter: a constant, or a curve. `L` is linear, `E` exponential (from·(to/from)^x, both ends > 0), with
 * x = driver^pow (pow defaults to 1). Drivers: `a` amount (default), `m` macro (a·ρ^1.5), `rho` the ramp ρ (0..1 over
 * BEATS, or to the Φ line), `t` beats since engage over `overBeats`.
 */
export type Curve = number | {
  c: "L" | "E"; from: number; to: number; by?: "a" | "m" | "rho" | "t"; pow?: number; overBeats?: number;
};
/** Inputs a curve reads: amount, macro value, ramp position and beats since engage. */
export type CurveInputs = { a: number; m: number; rho: number; t: number };

/** A field in beats: a number, or "beats" for the preset's selected BEATS value. */
export type BeatsRef = number | "beats";

/** Key tuning (K): the root folded into [lo, hi) Hz, times `mul`; it replaces the fixed value only when the key is known. */
export type KeyTune = { lo: number; hi: number; mul?: number };

/** Generator hit pattern (22, 23): on beats 2 and 4, every beat, or the off-beats. */
export type HitPattern = "2&4" | "every" | "off";
/**
 * One BEATS choice: a beat count, a dual-delay pair (tA, tB), Φ (ramp to the next phrase line), a Slice Gate pattern
 * index, or a generator hit pattern.
 */
export type BeatsValue = number | readonly [number, number] | "phrase" | { pattern: number } | { hits: HitPattern };
/** A preset's BEATS choices and the default index. */
export type BeatsSpec = { options: readonly BeatsValue[]; def: number };

/** LFO on a value: it sweeps between `lo` and the value itself (log scale for Hz and ms); `depth` scales the sweep (default 1). */
export type Lfo = { shape: "sine" | "triangle"; lo: number; periodBeats?: BeatsRef; hz?: number; depth?: Curve };

/** TPT SVF modes. */
export type SvfMode = "lp" | "bp" | "hp";
/** F: an SVF (or a peak EQ built on its band-pass) with an optional LFO and key tuning of the end cutoff. Q defaults to 0.707. */
export type FilterParams = { type: SvfMode | "peak"; hz: Curve; q?: Curve; gainDb?: Curve; lfo?: Lfo; key?: KeyTune };
/** F phaser: `stages` all-passes swept lo..hi Hz over `periodBeats`; `mix` is the processed share. */
export type PhaserParams = { type: "phaser"; stages: number; lo: number; hi: number; fb: Curve; periodBeats: BeatsRef; mix: Curve };

/** D short (flanger/chorus, 0.3–8 ms): delay `ms`, optionally swept by `lfo`; `mix` is the delayed share of its output. */
export type ShortDelayParams = { ms: Curve; lfo?: Lfo; fb: Curve; mix: Curve };

/**
 * D delay modes. `timeBeats` is the time (a pair for dual); comb uses `combHz` (1/f0) with `key` instead. `loop` are the
 * feedback-loop filters; `wow`/`flutter` modulate the time by ±ms; `slewMs` is the tape slew; `pan` is (A, B) for dual.
 */
export type DelayParams = {
  mode: "digital" | "pingpong" | "dual" | "tape" | "comb";
  timeBeats?: BeatsRef;
  combHz?: number;
  key?: KeyTune;
  fb: Curve;
  loop?: FilterParams[];
  drive?: Curve;
  wow?: { hz: number; ms: number };
  flutter?: { hz: number; ms: number };
  slewMs?: number;
  cross?: number;
  pan?: readonly [number, number];
};
/** D as a send: `send` is its level in the wet sum; `intoReverb` feeds the reverb from the delay instead of the voice input. */
export type DelaySend = DelayParams & { send: Curve; intoReverb?: boolean };

/** R plate: T60 in beats, size, pre-delay, damping 0..1, input HP, modulation ×, octave-up mix in the tank, and a gate on its wet. */
export type ReverbParams = {
  t60Beats: Curve | "beats";
  size?: number;
  preDelayBeats?: number;
  damp?: number;
  inHp?: Curve;
  mod?: number;
  shimmer?: Curve;
  gate?: GateParams;
};
/** R as a send: `send` is its return level. */
export type ReverbSend = ReverbParams & { send: Curve };

/**
 * G: gain = shape(step phase from B), floored at 1 − depth. One cycle lasts `stepBeats` × `stepMul`; pattern gates use
 * 16 steps per bar from the BEATS pattern; pump is 1 − d·e^(−t/τ) (`invert` swells between beats instead).
 */
export type GateParams = {
  shape: "square" | "sine" | "pattern" | "pan" | "pump";
  stepBeats: BeatsRef;
  stepMul?: number;
  duty?: number;
  edgeMs?: number;
  depth: Curve;
  tauBeats?: Curve;
  attackMs?: number;
  invert?: boolean;
};

/** C: fractional sample-and-hold rate (Hz), bit depth, and an optional post low-pass at `postLp` × rate. */
export type CrusherParams = { bits: Curve; rateHz: Curve; postLp?: number };

/** Slice step operations for the table-driven programs. */
export type SliceOp = "repeat" | "reverse" | "up" | "down" | "skip";
/** Roll size steps: `sizes[i]` (beats) from ρ ≥ `at[i]`. */
export type RollSchedule = { sizes: readonly number[]; at: readonly number[] };

/**
 * S programs (§2 S). Windows are in beats. roll: repeat the last `sizeBeats` from the step heard (or the last beat),
 * optionally only on 16th steps `steps` (1-based, inclusive). replay: the `lenBeats` from `backBeats` back, ½ b slices
 * reversed by chance. random/order/scramble: slices of the last `sourceBeats`. fractal/freeform: per-step alterations.
 * chromatic: the window laddered up by semitones. glide: slices with a pitch glide. brake/reverse/spin: tape moves.
 */
export type SlicerParams =
  | {
    prog: "roll"; sizeBeats: BeatsRef; anchor?: "step" | "beat"; schedule?: RollSchedule; pitchSt?: Curve;
    vibrato?: { st: Curve; hz: number }; repeatGain?: Curve; steps?: readonly [number, number];
  }
  | { prog: "replay"; backBeats: number; lenBeats: BeatsRef; sliceBeats: number; reverseChance: Curve }
  | { prog: "random"; sourceBeats: number; sliceBeats: BeatsRef; pan: number }
  | { prog: "order"; sourceBeats: number; sliceBeats: BeatsRef; order: readonly number[] }
  | { prog: "fractal"; stepBeats: BeatsRef; altered: Curve; tables: readonly (readonly (readonly [number, SliceOp])[])[] }
  | { prog: "chromatic"; windowBeats: BeatsRef; slots: Curve }
  | { prog: "freeform"; stepBeats: BeatsRef; chance: Curve }
  | { prog: "scramble"; sourceBeats: number; sliceBeats: BeatsRef; tables: Readonly<Record<number, readonly (readonly number[])[]>> }
  | { prog: "glide"; sliceBeats: BeatsRef; glideSt: Curve }
  | { prog: "brake"; lpFollow: Curve }
  | { prog: "reverse" }
  | { prog: "spin"; rate: Curve };

/** Inserts on the voice input, in the fixed order S→G→C→F→short D; `mix` is the processed share, `gainDb` a level change. */
export type InsertChain = {
  slicer?: SlicerParams;
  gate?: GateParams;
  crusher?: CrusherParams;
  filters?: (FilterParams | PhaserParams)[];
  shortDelay?: ShortDelayParams;
  mix?: Curve;
  gainDb?: Curve;
};

/** N sources: white noise, two alternating PolyBLEP tones (f2 = f1·2^(interval/12)), a clap, a snare. */
export type GenSource =
  | { kind: "noise" }
  | { kind: "tones"; hz: number; key: KeyTune; interval: number; q: number; stepBeats: BeatsRef; transposeSt?: Curve }
  | { kind: "clap"; bursts: number; gapMs: number; tailMs: number; hz: number }
  | {
    kind: "snare"; bodyHz: number; dropPct: number; dropMs: number; bodyDecayMs: number; noiseHz: number;
    noiseDecayMs: number;
  };
/**
 * N: a generator added to the wet sum. `level` is absolute × the live fader; `rms` scales it by the input RMS (22, 23),
 * `follow` by the input envelope; `hits` triggers it on the BEATS hit pattern. Its own filters, gate, flanger and reverb.
 */
export type GeneratorParams = {
  source: GenSource;
  level: Curve;
  rms?: boolean;
  follow?: { attackMs: number; releaseMs: number };
  hits?: "beats";
  filters?: FilterParams[];
  gate?: GateParams;
  flanger?: ShortDelayParams;
  reverb?: { t60Beats: number; wet: number };
};

/** Release (Rel): T tails ring, B stop at the next step, C cut on the beat or line, X crossfade now (or over the fade). */
export type ReleaseSpec = {
  kind: "T" | "B" | "C" | "X";
  fadeMs?: number;
  fadeBeats?: number;
  /** The sends ring out (T) while the inserts stop as `kind`. */
  sendsT?: boolean;
  /** The generators fade over this many beats (Lift's noise). */
  genFadeBeats?: number;
};

/** Exits (14–17): the dry falls to 0 over `overBeats` from the next beat. */
export type ExitSpec = { overBeats: BeatsRef };

/** Family ids, in picker order. */
export type FxFamilyId =
  | "basic" | "reverb-echo" | "noise" | "macro-up" | "macro-down" | "filters" | "cuts" | "slice" | "juggle"
  | "resonance" | "psytrance";

/** One row of the §3 table. */
export type FxPreset = {
  /** Row number in §3. */
  n: number;
  /** Stable kebab-case id (persisted). */
  id: string;
  /** Shown effect name (English). */
  name: string;
  /** Greek one-line description. */
  line: string;
  family: FxFamilyId;
  /** 1 = psytrance staple (★), 2 = owner favourite (★★), 0 otherwise. */
  star: 0 | 1 | 2;
  /** BEATS choices; null for "—". */
  beats: BeatsSpec | null;
  release: ReleaseSpec;
  /** P: with phrase release on, a latched release waits for the next phrase line. */
  phrase: boolean;
  /** K: uses the track key when known. */
  key: boolean;
  /** ∅: works without BPM (tempo presets are disabled on a BPM-less track). */
  noBpm: boolean;
  /** M: ρ ramps over BEATS (or to Φ) and m = a·ρ^1.5 drives every curve with `by: "m"`. */
  macro: boolean;
  exit?: ExitSpec;
  ins?: InsertChain;
  delay?: DelaySend;
  reverb?: ReverbSend;
  gens?: GeneratorParams[];
};

// ---- Shared by the core and the slicer ----

/** Capture length in seconds (§1 Buffers). */
export const CAPTURE_SECONDS = 8.5;

/**
 * The deck's capture ring, owned and written by the core in every path (bypass included) before any voice runs; the
 * slicer only reads it. It stores x/fader clamped to |·| ≤ 4 (`invFader` = 0 when fader < 1e-3). Ring index i counts
 * frames since the last reset, so the frame being rendered in a quantum of n is `written − n + i`.
 */
export class CaptureRing {
  /** Capacity in frames. */
  readonly size: number;
  /** Frames written since the last reset. */
  written = 0;
  private readonly l: Float32Array;
  private readonly r: Float32Array;
  private head = 0;

  constructor(sampleRate: number, seconds = CAPTURE_SECONDS) {
    this.size = Math.ceil(sampleRate * seconds);
    this.l = new Float32Array(this.size);
    this.r = new Float32Array(this.size);
  }

  /** Appends n frames of l and r (pass the same array twice for mono) scaled by `invFader`. */
  write(l: Float32Array, r: Float32Array, invFader: number, n: number): void {
    const size = this.size;
    let head = this.head;
    for (let i = 0; i < n; i++) {
      const vl = l[i] * invFader, vr = r[i] * invFader;
      this.l[head] = vl > 4 ? 4 : vl < -4 ? -4 : vl;
      this.r[head] = vr > 4 ? 4 : vr < -4 ? -4 : vr;
      head = head + 1 === size ? 0 : head + 1;
    }
    this.head = head;
    this.written += n;
  }

  /** Forgets everything captured (a `track` message or a `seek` clock); unwritten frames read as 0. */
  reset(): void {
    this.written = 0;
  }

  /** True when ring index i is still held (written since the reset and not yet overwritten). */
  has(i: number): boolean {
    return i >= 0 && i < this.written && i >= this.written - this.size;
  }

  /** Sample of channel `ch` (0 = L, 1 = R) at integer ring index i; 0 when not held. */
  at(ch: 0 | 1, i: number): number {
    if (!this.has(i)) return 0;
    let p = this.head - (this.written - i);
    if (p < 0) p += this.size;
    return ch === 0 ? this.l[p] : this.r[p];
  }
}

/** The node clock for one render quantum, read where the audio is (latency compensated). */
export type QuantumClock = {
  /** B at the quantum's first frame: beats since the bar-1 downbeat (trusted) or since engage (untrusted). */
  beat: number;
  /** B advance per frame (tempo × rate); 0 while paused or without BPM. */
  beatsPerFrame: number;
  /** Frames per beat at the current tempo × rate, also while paused; 0 without BPM. */
  framesPerBeat: number;
  /** False while paused: the clock is frozen and voices fade out. */
  playing: boolean;
  /** B moved discontinuously before this quantum (a seek, or a nudge re-phase). */
  jumped: boolean;
};

/** A stereo TPT state-variable filter. blocks.ts builds it; the slicer borrows one for Brake's low-pass. */
export interface StereoFilter {
  /** Retargets cutoff (Hz) and Q; the filter glides there in log-Hz over 15 ms unless `snap`. */
  set(hz: number, q: number, snap?: boolean): void;
  /** Filters frames [from, to) of l and r in place. */
  process(l: Float32Array, r: Float32Array, from: number, to: number): void;
  /** Clears the filter state. */
  reset(): void;
}
/** Builds one filter at the node's sample rate (blocks.ts); the core passes it to `CreateSlicer`. */
export type FilterFactory = (mode: SvfMode) => StereoFilter;

/** One slicer voice (block S). The core owns it; it reads the core's `CaptureRing` and never writes it. */
export interface SlicerVoice {
  /** Arms `params` at engage with BEATS = `beats` (in beats); `lagFrames` back from now is the step the DJ heard (§7.2). */
  start(params: SlicerParams, beats: number, clock: QuantumClock, lagFrames: number): void;
  /**
   * Renders n frames into outL/outR (separate from inL/inR), replacing them with the signal that stands in for x in the
   * insert chain. Replayed audio is ring × `fader`; `v` feeds the program's curves.
   */
  process(
    ring: CaptureRing, clock: QuantumClock, v: CurveInputs, fader: number,
    inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, n: number,
  ): void;
  /** "step" stops at the next step boundary with a 3 ms crossfade (B); "now" crossfades back to live over `fadeMs` (X). */
  release(mode: "step" | "now", fadeMs: number): void;
  /** True once released and faded: the output equals the live input. */
  readonly idle: boolean;
}
/** Builds a slicer voice (slicer.ts). */
export type CreateSlicer = (sampleRate: number, filter: FilterFactory) => SlicerVoice;
