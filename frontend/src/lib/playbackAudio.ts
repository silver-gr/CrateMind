import { PeakLimiterDSP } from "./audio/peak-limiter-core.js";
import peakLimiterWorkletUrl from "./audio/peak-limiter.worklet.js?worker&url";
import { FILTER_Q_DB, eqDb, filterParams, type DeckFx } from "./mixer";
export { peakLimiterWorkletUrl };

/** Desired EQ and filter for a deck (mixer values, -1..1). */
export type PlaybackTone = Pick<DeckFx, "eq" | "filter">;

/** Optional playback-only DSP. Nodes stay associated with their media element for its lifetime. */
export interface PlaybackProcessing {
  gainDb: number;
  limiterEnabled: boolean;
  immediate?: boolean;
}

interface Limiter {
  node: AudioNode;
  engine: "worklet" | "compatibility";
  ready: boolean;
  reset(): void;
  release(): void;
}

interface PlaybackGraph {
  desired: PlaybackProcessing;
  revision: number;
  lifecycle: number;
  source?: MediaElementAudioSourceNode;
  gain?: GainNode;
  master?: GainNode;
  lo?: BiquadFilterNode;
  mid?: BiquadFilterNode;
  hi?: BiquadFilterNode;
  hp?: BiquadFilterNode;
  lp?: BiquadFilterNode;
  limiter?: Limiter;
  connected: boolean;
  limiterFailed: boolean;
  workletFailed?: boolean;
}

const graphs = new WeakMap<HTMLAudioElement, PlaybackGraph>();
// Kept apart from the graph so a tone set before the graph exists is applied when it is created.
const tones = new WeakMap<HTMLAudioElement, PlaybackTone>();
const FLAT_TONE: PlaybackTone = { eq: { hi: 0, mid: 0, lo: 0 }, filter: 0 };
const TONE_TIME_CONSTANT = 0.015;
// setTargetAtTime never arrives; a neutral filter is snapped exactly after ~7 time constants.
const TONE_SNAP_S = 0.1;
let context: AudioContext | undefined;
let workletLoading: Promise<void> | undefined;

function loadWorklet(audioContext: AudioContext): Promise<void> {
  // Some hosts leave module loading paused indefinitely. Switch to the compatible DSP path.
  const loading = audioContext.audioWorklet.addModule(peakLimiterWorkletUrl);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Audio worklet loading timed out")), 1500);
    loading.then(() => { clearTimeout(timeout); resolve(); }, error => { clearTimeout(timeout); reject(error); });
  });
}

function stateFor(audio: HTMLAudioElement): PlaybackGraph {
  let state = graphs.get(audio);
  if (!state) {
    state = { desired: { gainDb: 0, limiterEnabled: false }, revision: 0, lifecycle: 0,
      connected: false, limiterFailed: false };
    graphs.set(audio, state);
  }
  return state;
}

/** Invoke before awaiting anything in an actual play/toggle gesture. */
export async function unlockPlaybackAudio(): Promise<void> {
  if (!context) {
    const Constructor = globalThis.AudioContext;
    if (!Constructor) return;
    context = new Constructor();
    // Sleep/wake or a device change suspends the context; try to get back without a new gesture.
    const created = context;
    created.addEventListener("statechange", () => {
      if (created.state === "suspended" || (created.state as string) === "interrupted") void created.resume().catch(() => {});
    });
  }
  if (context.state === "suspended" || (context.state as string) === "interrupted") await context.resume();
}

export function hasPlaybackGraph(audio: HTMLAudioElement): boolean {
  return Boolean(graphs.get(audio)?.source);
}

export function playbackProcessingStatus(audio: HTMLAudioElement) {
  const state = graphs.get(audio);
  const active = Boolean(state?.connected && context?.state === "running");
  return { active, limiterReady: Boolean(active && state?.limiter?.ready && !state.limiterFailed && state.desired.limiterEnabled),
    limiterUnavailable: Boolean(state?.limiterFailed), limiterEngine: state?.limiter?.engine ?? null };
}

function route(state: PlaybackGraph) {
  const { source, gain, lo, mid, hi, hp, lp, master } = state;
  if (!context || !source || !gain || !lo || !mid || !hi || !hp || !lp || !master) return;
  const chain = [gain, lo, mid, hi, hp, lp];
  source.disconnect();
  chain.forEach(node => node.disconnect());
  master.disconnect();
  state.limiter?.node.disconnect();
  source.connect(gain);
  chain.slice(1).forEach((node, i) => chain[i].connect(node));
  if (state.desired.limiterEnabled && state.limiter && !state.limiterFailed) {
    lp.connect(state.limiter.node);
    state.limiter.node.connect(master);
  } else {
    lp.connect(master);
  }
  master.connect(context.destination);
  state.connected = true;
}

function applyTone(audio: HTMLAudioElement, state: PlaybackGraph, ramp: boolean) {
  const { lo, mid, hi, hp, lp } = state;
  if (!context || !lo || !mid || !hi || !hp || !lp) return;
  const tone = tones.get(audio) ?? FLAT_TONE;
  const filter = filterParams(tone.filter, context.sampleRate);
  const now = context.currentTime;
  const set = (parameter: AudioParam, value: number, snap = false) => {
    if (!ramp) { parameter.value = value; return; }
    parameter.cancelScheduledValues(now);
    parameter.setTargetAtTime(value, now, TONE_TIME_CONSTANT);
    if (snap) parameter.setValueAtTime(value, now + TONE_SNAP_S);
  };
  set(lo.gain, eqDb(tone.eq.lo));
  set(mid.gain, eqDb(tone.eq.mid));
  set(hi.gain, eqDb(tone.eq.hi));
  set(lp.frequency, filter.lpHz, filter.neutral);
  set(hp.frequency, filter.hpHz, filter.neutral);
}

/** Stores the tone (even before a graph exists) and ramps the nodes when they do. False = no graph yet. */
export function setPlaybackTone(audio: HTMLAudioElement, tone: PlaybackTone): boolean {
  tones.set(audio, tone);
  const state = graphs.get(audio);
  if (!state?.source) return false;
  applyTone(audio, state, true);
  return true;
}

function createFilters(audioContext: AudioContext, state: PlaybackGraph) {
  const filter = (type: BiquadFilterType, frequency: number, q?: number) => {
    const node = audioContext.createBiquadFilter();
    node.type = type;
    node.frequency.value = frequency;
    if (q !== undefined) node.Q.value = q;
    return node;
  };
  state.lo = filter("lowshelf", 250);
  state.mid = filter("peaking", 1000, 0.7);
  state.hi = filter("highshelf", 4000);
  state.hp = filter("highpass", 0, FILTER_Q_DB);
  state.lp = filter("lowpass", audioContext.sampleRate / 2, FILTER_Q_DB);
}

function setGain(state: PlaybackGraph) {
  if (!context || !state.gain) return;
  const parameter = state.gain.gain;
  parameter.cancelAndHoldAtTime(context.currentTime);
  const value = Math.pow(10, state.desired.gainDb / 20);
  if (state.desired.immediate) parameter.setValueAtTime(value, context.currentTime);
  else parameter.linearRampToValueAtTime(value, context.currentTime + 0.1);
}

function processingChanged(audio: HTMLAudioElement) {
  audio.dispatchEvent(new Event("cratemind-processing-change"));
}

function markReady(audio: HTMLAudioElement, state: PlaybackGraph, limiter: Limiter) {
  if (state.limiter !== limiter || limiter.ready) return;
  limiter.ready = true;
  if (state.connected && state.desired.limiterEnabled) processingChanged(audio);
}

function installCompatibilityLimiter(audio: HTMLAudioElement, state: PlaybackGraph): boolean {
  if (!context) return false;
  state.limiter?.release();
  state.limiter = undefined;
  try {
    // Deprecated, but retained only for hosts whose preferred AudioWorklet path cannot start.
    // 1024-frame blocks balance main-thread callback overhead with playback latency.
    const node = context.createScriptProcessor(1024, 2, 2);
    const dsp = new PeakLimiterDSP(context.sampleRate);
    const limiter: Limiter = { node, engine: "compatibility", ready: false,
      reset: () => dsp.reset(),
      release: () => { node.disconnect(); node.onaudioprocess = null; dsp.reset(); },
    };
    node.onaudioprocess = event => {
      const output = Array.from({ length: event.outputBuffer.numberOfChannels }, (_, channel) =>
        event.outputBuffer.getChannelData(channel));
      if (state.limiter !== limiter || !state.connected || !state.desired.limiterEnabled) {
        output.forEach(channel => channel.fill(0));
        dsp.reset();
        return;
      }
      const input = Array.from({ length: event.inputBuffer.numberOfChannels }, (_, channel) =>
        event.inputBuffer.getChannelData(channel));
      dsp.process(input, output);
      markReady(audio, state, limiter);
    };
    state.limiter = limiter;
    state.limiterFailed = false;
  } catch {
    state.limiterFailed = true;
  }
  route(state);
  processingChanged(audio);
  return !state.limiterFailed;
}

function installWorkletLimiter(audio: HTMLAudioElement, state: PlaybackGraph, audioContext: AudioContext) {
  const node = new AudioWorkletNode(audioContext, "cratemind-peak-limiter", {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    channelCount: 2, channelCountMode: "clamped-max", channelInterpretation: "speakers",
  });
  const limiter: Limiter = { node, engine: "worklet", ready: false,
    reset: () => node.port.postMessage({ type: "reset" }),
    release: () => { node.disconnect(); node.onprocessorerror = null; node.port.onmessage = null; },
  };
  node.port.onmessage = ({ data }) => { if (data?.type === "ready") markReady(audio, state, limiter); };
  node.onprocessorerror = () => {
    if (state.limiter !== limiter) return;
    state.workletFailed = true;
    if (state.connected) installCompatibilityLimiter(audio, state);
    else { limiter.release(); state.limiter = undefined; }
  };
  state.limiter = limiter;
  route(state);
  processingChanged(audio);
}

export async function preparePlayback(audio: HTMLAudioElement): Promise<void> {
  const state = stateFor(audio);
  const lifecycle = state.lifecycle;
  try {
    await unlockPlaybackAudio();
    // Until the context runs, leave the element's native output untouched.
    if (!context || context.state !== "running" || state.lifecycle !== lifecycle) return;
    if (!state.source) {
      state.gain = context.createGain();
      state.master = context.createGain();
      state.master.gain.value = audio.muted ? 0 : audio.volume;
      createFilters(context, state);
      applyTone(audio, state, false);
      state.source = context.createMediaElementSource(audio);
      route(state);
      audio.volume = 1;
      audio.muted = false;
    } else if (!state.connected) {
      route(state);
    }
    await configurePlayback(audio, state.desired);
  } catch {
    // Before attachment native playback remains available; existing graphs retain their bypass.
  }
}

/** False means requested limiting is unavailable; normalization keeps an audible bypass. */
export async function configurePlayback(audio: HTMLAudioElement, processing: PlaybackProcessing): Promise<boolean> {
  const state = stateFor(audio);
  state.desired = {
    gainDb: Number.isFinite(processing.gainDb) ? Math.min(12, processing.gainDb) : 0,
    limiterEnabled: Boolean(processing.limiterEnabled),
    immediate: processing.immediate,
  };
  const revision = ++state.revision;
  if (!state.source || !context || !state.connected) return !state.desired.limiterEnabled;
  setGain(state);
  if (!state.desired.limiterEnabled) {
    state.limiter?.reset();
    route(state);
    return true;
  }
  if (state.limiterFailed) return false;
  if (state.limiter) { route(state); return true; }
  if (state.workletFailed || !context.audioWorklet || !globalThis.AudioWorkletNode) {
    return installCompatibilityLimiter(audio, state);
  }
  try {
    // Static same-origin asset works under desktop script-src 'self', with no blob URL or dependency.
    workletLoading ??= loadWorklet(context);
    await workletLoading;
    if (revision !== state.revision || !state.connected) return false;
    installWorkletLimiter(audio, state, context);
    return true;
  } catch {
    if (revision !== state.revision || !state.connected) return false;
    state.workletFailed = true;
    return installCompatibilityLimiter(audio, state);
  }
}

export function setPlaybackVolume(audio: HTMLAudioElement, volume: number): void {
  const value = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0;
  const state = graphs.get(audio);
  if (state?.master && state.source) {
    state.master.gain.value = value;
    audio.volume = 1;
    audio.muted = false;
  } else {
    audio.muted = false;
    audio.volume = value;
  }
}

/** Drop lookahead audio at seeks/source changes without changing track normalization. */
export function resetLimiter(audio: HTMLAudioElement): void {
  graphs.get(audio)?.limiter?.reset();
}

/** Keep source/context ownership so React's cleanup/remount cycle can safely reconnect. */
export function disposePlayback(audio: HTMLAudioElement): void {
  const state = graphs.get(audio);
  if (!state) return;
  ++state.revision;
  ++state.lifecycle;
  state.source?.disconnect();
  state.gain?.disconnect();
  [state.lo, state.mid, state.hi, state.hp, state.lp].forEach(node => node?.disconnect());
  state.master?.disconnect();
  state.limiter?.node.disconnect();
  state.limiter?.reset();
  state.connected = false;
}
