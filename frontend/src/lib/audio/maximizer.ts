// What CrateMind knows of the Maximizer's engine. The engine itself is not part of this repository or of any release: it is
// built in only where `frontend/private/maximizer/` exists (vite.config.ts), and without it every Maximizer control is left out.
export const MAXIMIZER_BUILT = typeof __MAXIMIZER__ !== "undefined" && __MAXIMIZER__;

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
