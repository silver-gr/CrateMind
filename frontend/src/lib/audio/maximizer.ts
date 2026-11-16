// The Maximizer's engine: master_me in an AudioWorklet. The one file to swap for an own DSP later.
import workletUrl from "./master-me.worklet.js?worker&url";
import wasmUrl from "./master_me/master_me.wasm?url";
import dspParams from "./master_me/params.json";

/** master_me's «MUSIC GENERAL» preset, applied explicitly: the DSP's own defaults match no preset. Target and ceiling come from the prefs. */
export const MUSIC_GENERAL: Record<string, number> = {
  global_bypass: 0, in_gain: 0, phase_l: 0, phase_r: 0, mono: 0, dc_blocker: 0, stereo_correct: 0,
  gate_bypass: 1, gate_threshold: -90, gate_attack: 0, gate_hold: 50, gate_release: 430.5,
  eq_bypass: 0, eq_highpass_freq: 5, eq_tilt_gain: 0, eq_side_gain: 1, eq_side_freq: 600, eq_side_bandwidth: 1,
  leveler_bypass: 0, leveler_speed: 20, leveler_brake_threshold: -10, leveler_max_plus: 10, leveler_max_minus: 10,
  kneecomp_bypass: 0, kneecomp_strength: 20, kneecomp_threshold: -4, kneecomp_attack: 20, kneecomp_release: 340,
  kneecomp_knee: 6, kneecomp_link: 60, kneecomp_fffb: 50, kneecomp_makeup: 0, kneecomp_drywet: 50,
  mscomp_bypass: 0, mscomp_low_strength: 10, mscomp_low_threshold: -3, mscomp_low_attack: 15, mscomp_low_release: 150,
  mscomp_low_knee: 12, mscomp_low_link: 70, mscomp_low_crossover: 60, mscomp_high_strength: 30, mscomp_high_threshold: -12,
  mscomp_high_attack: 8, mscomp_high_release: 30, mscomp_high_knee: 12, mscomp_high_link: 30, mscomp_high_crossover: 8000,
  mscomp_output_gain: 1,
  limiter_bypass: 0, limiter_strength: 80, limiter_threshold: 6, limiter_attack: 3, limiter_release: 40, limiter_knee: 3,
  limiter_fffb: 50, limiter_makeup: 0,
  brickwall_bypass: 0, brickwall_release: 75,
};

/** Short-term output loudness (LUFS) and the two gain reductions (dB, ≤ 0). */
export interface MaximizerMeters { lufsOut: number; limiterDb: number; brickwallDb: number }
export interface MaximizerLevels { targetDb: number; ceilingDb: number }

export interface Maximizer {
  node: AudioWorkletNode;
  /** Resolves once the DSP runs; rejects on a load error or a processor error. */
  ready: Promise<void>;
  set(levels: MaximizerLevels): void;
  /** Inactive passes audio through without computing; re-activation clears the DSP state first. */
  setActive(active: boolean): void;
  onMeters(callback: (meters: MaximizerMeters) => void): void;
  /** A load error, a wasm trap or a processor error; the node then passes audio through (or goes silent). */
  onError(callback: () => void): void;
}

/** Module loading paused or slow: not a failure. `loading` settles when the load finally ends. */
export class MaximizerNotYet extends Error {
  loading: Promise<unknown>;
  constructor(loading: Promise<unknown>) {
    super("Maximizer still loading");
    this.loading = loading;
  }
}

const LOAD_TIMEOUT_MS = 1500;
const loads = new WeakMap<BaseAudioContext, Promise<ArrayBuffer>>();

/** Fetches the wasm and registers the processor, once per context; rejects with MaximizerNotYet after 1.5 s. */
export function loadMaximizer(ctx: AudioContext): Promise<ArrayBuffer> {
  const loading = loads.get(ctx) ?? Promise.all([
    fetch(wasmUrl).then(response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.arrayBuffer();
    }),
    // Static same-origin module, as the limiter: fine under the desktop CSP (no blob or data URL).
    ctx.audioWorklet.addModule(workletUrl),
  ]).then(([bytes]) => bytes);
  loads.set(ctx, loading);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new MaximizerNotYet(loading)), LOAD_TIMEOUT_MS); });
  return Promise.race([loading, timeout]).finally(() => clearTimeout(timer));
}

/** One per session: the node starts active and runs `init()` (tens of ms on the render thread) before `ready`. */
export function createMaximizer(ctx: AudioContext, wasm: ArrayBuffer): Maximizer {
  const node = new AudioWorkletNode(ctx, "cratemind-master-me", {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    channelCount: 2, channelCountMode: "explicit", channelInterpretation: "speakers",
  });
  let meters: ((meters: MaximizerMeters) => void) | undefined;
  let error: (() => void) | undefined;
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  ready.catch(() => {});
  const failed = (message: string) => { reject(new Error(message)); error?.(); };
  node.port.onmessage = ({ data }) => {
    if (data?.meters) meters?.(data.meters);
    else if (data?.ready) resolve();
    else if (data?.error) failed(data.error);
  };
  node.onprocessorerror = () => failed("processorerror");
  node.port.postMessage({ wasm, params: dspParams });
  node.port.postMessage({ set: MUSIC_GENERAL });
  return {
    node, ready,
    set: ({ targetDb, ceilingDb }) => node.port.postMessage({ set: { target: targetDb, brickwall_ceiling: ceilingDb } }),
    setActive: active => node.port.postMessage({ active }),
    onMeters: callback => { meters = callback; },
    onError: callback => { error = callback; },
  };
}
