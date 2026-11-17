// The deck FX rack's worklet module: the only importer of its URL, loaded by fxRackHost through import().
import workletUrl from "./fxRack/fx-rack.worklet.js?worker&url";
import { FX_RACK_NODE_OPTIONS, FX_RACK_PROCESSOR } from "./fxRack/types";

/** Module loading paused or slow: not a failure. `loading` settles when the load finally ends. */
export class FxRackNotYet extends Error {
  loading: Promise<unknown>;
  constructor(loading: Promise<unknown>) {
    super("FX rack still loading");
    this.loading = loading;
  }
}

const LOAD_TIMEOUT_MS = 1500;
const loads = new WeakMap<BaseAudioContext, Promise<void>>();

/** Registers the processor once per context; rejects with FxRackNotYet after 1.5 s. */
export function loadFxRack(ctx: AudioContext): Promise<void> {
  // Static same-origin module, as the limiter: fine under the desktop CSP (no blob or data URL).
  const loading = loads.get(ctx) ?? ctx.audioWorklet.addModule(workletUrl);
  loads.set(ctx, loading);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new FxRackNotYet(loading)), LOAD_TIMEOUT_MS); });
  return Promise.race([loading, timeout]).finally(() => clearTimeout(timer));
}

/** One rack node; the module must be loaded. */
export const createFxRackNode = (ctx: AudioContext) => new AudioWorkletNode(ctx, FX_RACK_PROCESSOR, FX_RACK_NODE_OPTIONS);
