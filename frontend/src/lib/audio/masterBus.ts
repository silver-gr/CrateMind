/**
 * One shared master bus per context: each deck → its deck input → in → [insert, else the safety limiter] → out → destination,
 * and out → each tap. While the VST3 slots run, the deck inputs feed the host's tap instead (A → input 0, B → input 1) and out
 * leaves the speakers.
 */
export type BusDeck = "A" | "B";

interface Bus {
  input: GainNode;
  output: GainNode;
  insert: AudioNode | null;
  /** The always-on safety limiter; it steps aside while an insert (the Maximizer) runs. Null until its worklet loads. */
  limiter: AudioNode | null;
  /** Listeners on `out` (the set recorder); they survive sink changes. */
  taps: Set<AudioNode>;
  /** Overlapping dips: only the last one to finish brings the bus back up. */
  dips: number;
  /** Per-deck unity gains, built on first use. */
  decks: Partial<Record<BusDeck, GainNode>>;
  /** Overlapping `{decks: true}` dips, counted apart: only the last of them brings the deck inputs back. */
  deckDips: number;
  /** The tap the deck inputs feed instead of `in`; null = the normal path. */
  sink: AudioNode | null;
}

const buses = new WeakMap<BaseAudioContext, Bus>();
const DIP_S = 0.015;
const DIP_MAX_WAIT_MS = 2000;
const TAP_INPUT: Record<BusDeck, number> = { A: 0, B: 1 };

function busFor(ctx: BaseAudioContext): Bus {
  let bus = buses.get(ctx);
  if (!bus) {
    bus = { input: ctx.createGain(), output: ctx.createGain(), insert: null, limiter: null, taps: new Set(), dips: 0, decks: {},
      deckDips: 0, sink: null };
    bus.input.connect(bus.output);
    bus.output.connect(ctx.destination);
    buses.set(ctx, bus);
    addSafetyLimiter(ctx, bus);
  }
  return bus;
}

/**
 * Loads the deck limiter's worklet (5 ms look-ahead, -1 dBFS sample-peak ceiling) as the bus's safety limiter, so the speakers
 * and every tap hear two summed decks limited instead of clipped. It acts only on what is already on the bus: a single deck
 * that plays natively stays off it (deliberately outside the gate in prepare()). Its 5 ms delay reaches both decks alike and is
 * compensated nowhere (nor is the Maximizer's). No worklet or a failed load: no safety limiter and in → out as before; never the
 * ScriptProcessor fallback (~21 ms more). The URL is the AppShell marker, so tests without a document never load it.
 */
function addSafetyLimiter(ctx: BaseAudioContext, bus: Bus) {
  const url = globalThis.document?.querySelector<HTMLMetaElement>('meta[name="cratemind-audio-worklet"]')?.content;
  if (!url || !ctx.audioWorklet || !globalThis.AudioWorkletNode) return;
  ctx.audioWorklet.addModule(url).then(() => {
    const node = new AudioWorkletNode(ctx, "cratemind-peak-limiter", {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      channelCount: 2, channelCountMode: "clamped-max", channelInterpretation: "speakers",
    });
    // A faulted processor outputs silence: take it off the bus.
    node.onprocessorerror = () => { void withMasterDip(ctx, () => rewire(bus, bus.insert, null)).catch(() => {}); };
    return withMasterDip(ctx, () => rewire(bus, bus.insert, node));
  }).catch(() => { /* no safety limiter this session */ });
}

/** Where a deck connects when it has no deck input yet; built on first use. */
export function masterInput(ctx: BaseAudioContext): AudioNode {
  return busFor(ctx).input;
}

function connectDeck(bus: Bus, deck: BusDeck, node: GainNode) {
  if (bus.sink) node.connect(bus.sink, 0, TAP_INPUT[deck]);
  else node.connect(bus.input);
}

/** A deck's own unity gain into the bus (or into the host's tap while sunk); built on first use. */
export function deckInput(ctx: BaseAudioContext, deck: BusDeck): AudioNode {
  const bus = busFor(ctx);
  let node = bus.decks[deck];
  if (!node) {
    node = bus.decks[deck] = ctx.createGain();
    connectDeck(bus, deck, node);
  }
  return node;
}

/** `in → stage → out` with the insert as the stage, else the limiter, else `in → out`. */
function rewire(bus: Bus, insert: AudioNode | null, limiter: AudioNode | null) {
  bus.input.disconnect();
  for (const node of [bus.insert, bus.limiter]) {
    // Only our own edge: the insert's owner may keep other outputs (meters), or may have disconnected it already.
    if (node) try { node.disconnect(bus.output); } catch { /* not connected to the bus any more */ }
  }
  bus.insert = insert;
  bus.limiter = limiter;
  const stage = insert ?? limiter;
  bus.input.connect(stage ?? bus.output);
  stage?.connect(bus.output);
}

/**
 * `in → node → out` (the safety limiter steps aside, so the two never stack their delay), or back to the limiter (else
 * `in → out`) for null. Rewires at once; wrap in withMasterDip for a click-free change.
 */
export function setMasterInsert(ctx: BaseAudioContext, node: AudioNode | null): void {
  const bus = busFor(ctx);
  rewire(bus, node, bus.limiter);
}

/**
 * A tap: deck A → its input 0, deck B → its input 1, and `out` off the speakers. Null: the decks back into `in` and
 * `out → destination`. Only the destination edge of `out` is cut and restored, so the taps keep theirs. Rewires at once.
 */
export function setDeckSink(ctx: BaseAudioContext, tap: AudioNode | null): void {
  const bus = busFor(ctx);
  if (bus.sink === tap) return;
  const wasSunk = bus.sink !== null;
  bus.sink = tap;
  for (const deck of Object.keys(bus.decks) as BusDeck[]) {
    const node = bus.decks[deck]!;
    node.disconnect(); // a deck input's only edge is the one made here
    connectDeck(bus, deck, node);
  }
  if (tap && !wasSunk) {
    try { bus.output.disconnect(ctx.destination); } catch { /* not connected */ }
  } else if (!tap) {
    bus.output.connect(ctx.destination);
  }
}

/** Adds `out → node` beside the speakers: it hears exactly what goes to them. */
export function addMasterTap(ctx: BaseAudioContext, node: AudioNode): void {
  const bus = busFor(ctx);
  if (bus.taps.has(node)) return;
  bus.taps.add(node);
  bus.output.connect(node);
}

export function removeMasterTap(ctx: BaseAudioContext, node: AudioNode): void {
  const bus = busFor(ctx);
  if (!bus.taps.delete(node)) return;
  try { bus.output.disconnect(node); } catch { /* already disconnected */ }
}

function ramp(ctx: BaseAudioContext, parameter: AudioParam, value: number) {
  parameter.cancelAndHoldAtTime(ctx.currentTime);
  parameter.linearRampToValueAtTime(value, ctx.currentTime + DIP_S);
}

function rampDecks(ctx: BaseAudioContext, bus: Bus, value: number) {
  for (const node of Object.values(bus.decks)) ramp(ctx, node!.gain, value);
}

export interface DipOptions {
  /** Also fade the deck inputs: only for the VST3 host's own switch and stop drain, so no other dip cuts the plugin path. */
  decks?: boolean;
}

/** Fades the bus out (~15 ms), runs fn (waiting at most 2 s), and always fades back in. Errors from fn propagate. */
export async function withMasterDip(ctx: BaseAudioContext, fn: () => void | Promise<void>, options: DipOptions = {}): Promise<void> {
  if (ctx.state !== "running") { await fn(); return; }
  const bus = busFor(ctx);
  const decks = options.decks === true;
  bus.dips++;
  if (decks) bus.deckDips++;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    ramp(ctx, bus.output.gain, 0);
    if (decks) rampDecks(ctx, bus, 0);
    await new Promise(resolve => setTimeout(resolve, DIP_S * 1000));
    const work = Promise.resolve().then(fn);
    work.catch(() => {}); // a late failure after the max wait must not go unhandled
    await Promise.race([work, new Promise<void>(resolve => { timer = setTimeout(resolve, DIP_MAX_WAIT_MS); })]);
  } finally {
    clearTimeout(timer);
    if (--bus.dips === 0) ramp(ctx, bus.output.gain, 1);
    if (decks && --bus.deckDips === 0) rampDecks(ctx, bus, 1);
  }
}
