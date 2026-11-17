/** One shared master bus per context: every deck → in → [insert] → out → destination (or a sink), and out → each tap. */
interface Bus {
  input: GainNode;
  output: GainNode;
  insert: AudioNode | null;
  /** Listeners on `out` (the set recorder); they survive sink changes. */
  taps: Set<AudioNode>;
  /** Overlapping dips: only the last one to finish brings the bus back up. */
  dips: number;
}

const buses = new WeakMap<BaseAudioContext, Bus>();
const DIP_S = 0.015;
const DIP_MAX_WAIT_MS = 2000;

function busFor(ctx: BaseAudioContext): Bus {
  let bus = buses.get(ctx);
  if (!bus) {
    bus = { input: ctx.createGain(), output: ctx.createGain(), insert: null, taps: new Set(), dips: 0 };
    bus.input.connect(bus.output);
    bus.output.connect(ctx.destination);
    buses.set(ctx, bus);
  }
  return bus;
}

/** Where every deck connects; built on first use. */
export function masterInput(ctx: BaseAudioContext): AudioNode {
  return busFor(ctx).input;
}

/** `in → node → out`, or `in → out` for null. Rewires at once; wrap in withMasterDip for a click-free change. */
export function setMasterInsert(ctx: BaseAudioContext, node: AudioNode | null): void {
  const bus = busFor(ctx);
  bus.input.disconnect();
  if (bus.insert) {
    // Only our own edge: the insert's owner may keep other outputs (meters), or may have disconnected it already.
    try { bus.insert.disconnect(bus.output); } catch { /* not connected to the bus any more */ }
  }
  bus.insert = node;
  if (node) {
    bus.input.connect(node);
    node.connect(bus.output);
  } else {
    bus.input.connect(bus.output);
  }
}

/** `out → node` instead of the speakers; null restores `out → destination`. Rewires at once. */
export function setMasterSink(ctx: BaseAudioContext, node: AudioNode | null): void {
  const bus = busFor(ctx);
  bus.output.disconnect();
  bus.output.connect(node ?? ctx.destination);
  bus.taps.forEach(tap => bus.output.connect(tap));
}

/** Adds `out → node` beside the sink: it hears exactly what goes to the speakers (or to the sink). */
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

function rampOutput(ctx: BaseAudioContext, bus: Bus, value: number) {
  const parameter = bus.output.gain;
  parameter.cancelAndHoldAtTime(ctx.currentTime);
  parameter.linearRampToValueAtTime(value, ctx.currentTime + DIP_S);
}

/** Fades the bus out (~15 ms), runs fn (waiting at most 2 s), and always fades back in. Errors from fn propagate. */
export async function withMasterDip(ctx: BaseAudioContext, fn: () => void | Promise<void>): Promise<void> {
  if (ctx.state !== "running") { await fn(); return; }
  const bus = busFor(ctx);
  bus.dips++;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    rampOutput(ctx, bus, 0);
    await new Promise(resolve => setTimeout(resolve, DIP_S * 1000));
    const work = Promise.resolve().then(fn);
    work.catch(() => {}); // a late failure after the max wait must not go unhandled
    await Promise.race([work, new Promise<void>(resolve => { timer = setTimeout(resolve, DIP_MAX_WAIT_MS); })]);
  } finally {
    clearTimeout(timer);
    if (--bus.dips === 0) rampOutput(ctx, bus, 1);
  }
}
