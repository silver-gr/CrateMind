import { expect, test } from "bun:test";
import { hasMasterBus, masterInput, setMasterStereo } from "../src/lib/audio/masterBus";
import {
  createCueProbe, cueProbeSupported, PROBE_FAILURE_TEXT, PROBE_MAX_SAMPLES, PROBE_QUESTIONS, PROBE_SAMPLE_MS, probeReport, probeVerdict,
} from "../src/lib/cueProbe";

/** Every write that matters, in the order it happened. */
type Ops = string[];

class Parameter {
  value = 1;
  constructor(private owner: FakeNode, private ops: Ops) {}
  cancelAndHoldAtTime() {}
  cancelScheduledValues() {}
  setValueAtTime(value: number) { this.value = value; }
  linearRampToValueAtTime(value: number) { this.value = value; this.ops.push(`${this.owner.name}.gain→${value}`); }
}
class FakeNode {
  edges: { to: FakeNode; input: number }[] = [];
  gain: Parameter;
  count = 2;
  mode = "max";
  started = false;
  stopped = false;
  buffer: unknown = null;
  loop = false;
  constructor(public name: string, protected ops: Ops) { this.gain = new Parameter(this, ops); }
  get channelCount() { return this.count; }
  set channelCount(value: number) { this.setCount(value); }
  protected setCount(value: number) { this.count = value; }
  get channelCountMode() { return this.mode; }
  set channelCountMode(value: string) { this.mode = value; this.ops.push(`${this.name}.mode=${value}`); }
  connect(to: FakeNode, _output = 0, input = 0) { this.edges.push({ to, input }); this.ops.push(`${this.name}→${to.name}[${input}]`); return to; }
  disconnect(to?: FakeNode) {
    if (to === undefined) { this.edges = []; return; }
    if (!this.edges.some(edge => edge.to === to)) throw new Error("InvalidAccessError");
    this.edges = this.edges.filter(edge => edge.to !== to);
    this.ops.push(`${this.name}✕${to.name}`);
  }
  start() { this.started = true; }
  stop() { if (!this.started) throw new Error("InvalidStateError"); this.stopped = true; }
  targets() { return this.edges.map(edge => `${edge.to.name}[${edge.input}]`); }
}
class Destination extends FakeNode {
  maxChannelCount = 4;
  interpretation = "speakers";
  /** "ignore": writes do not stick; "throw": the count setter throws. */
  refuses: "ignore" | "throw" | null = null;
  mode = "explicit";
  protected setCount(value: number) {
    this.ops.push(`dest.count=${value}`);
    if (this.refuses === "throw") throw Object.assign(new Error("no"), { name: "IndexSizeError" });
    if (!this.refuses) this.count = value;
  }
  get channelInterpretation() { return this.interpretation; }
  set channelInterpretation(value: string) { this.ops.push(`dest.interp=${value}`); if (!this.refuses) this.interpretation = value; }
}
class Context {
  ops: Ops = [];
  state = "running";
  currentTime = 2;
  sampleRate = 8000;
  destination = new Destination("dest", this.ops);
  made: FakeNode[] = [];
  listeners = new Map<string, () => void>();
  private make(name: string) { const node = new FakeNode(name, this.ops); this.made.push(node); return node; }
  createGain() { return this.make(`gain${this.made.filter(node => node.name.startsWith("gain")).length}`); }
  createChannelSplitter() { return this.make("splitter"); }
  createChannelMerger() { return this.make("merger"); }
  createBufferSource() { return this.make("source"); }
  createBuffer(_channels: number, length: number) { const data = new Float32Array(length); return { length, getChannelData: () => data }; }
  addEventListener(type: string, fn: () => void) { this.listeners.set(type, fn); }
  removeEventListener(type: string) { this.listeners.delete(type); }
  node(name: string) { return this.made.find(node => node.name === name); }
}

function setup(options: { bus?: boolean; host?: boolean; context?: boolean } = {}) {
  const context = new Context();
  const ctx = context as unknown as AudioContext;
  if (options.bus !== false) masterInput(ctx); // gain0 = in, gain1 = out
  let now = 0;
  let tick: (() => void) | null = null;
  let everyMs = 0;
  const probe = createCueProbe({
    context: () => options.context === false ? undefined : ctx,
    hostActive: () => options.host === true,
    now: () => now,
    about: "CrateMind test",
    every: (fn, ms) => { tick = fn; everyMs = ms; return () => { tick = null; }; },
  });
  const phones = () => options.bus === false ? "gain0" : "gain2";
  return {
    context, ctx, probe, phones,
    /** 250 ms pass and the timer fires, if it is still set. */
    advance() { now += PROBE_SAMPLE_MS; (tick as (() => void) | null)?.(); },
    ticking: () => tick !== null,
    everyMs: () => everyMs,
    edges: () => Object.fromEntries(["gain0", "gain1"].map(name => [name, context.node(name)?.targets()])),
  };
}

test("on: discrete, 4 channels and stereo forcing inside one dip, then the merger, then the tone's gain", async () => {
  const { context, probe } = setup();
  context.ops.length = 0;
  await probe.start();
  expect(probe.snapshot().status).toBe("running");
  expect(probe.snapshot().failure).toBeNull();
  expect(context.ops).toEqual([
    "gain2.mode=explicit", "source→gain2[0]", "gain2→splitter[0]", "splitter→merger[2]", "splitter→merger[3]",
    "gain1.gain→0", "dest.interp=discrete", "dest.count=4", "gain1.mode=explicit", "gain1.gain→1",
    "merger→dest[0]", "gain2.gain→0.25",
    "gain1.mode=explicit", // the first sample re-asserts stereo for a bus built after the start
  ]);
  expect(context.node("source")).toMatchObject({ started: true, loop: true });
  await probe.stop();
});

test("while it runs the master keeps its own edges and the tone reaches only merger inputs 2 and 3", async () => {
  const { context, probe, edges } = setup();
  const before = edges();
  await probe.start();
  expect(edges()).toEqual(before);
  expect(before.gain1).toEqual(["dest[0]"]);
  expect(context.node("source")!.targets()).toEqual(["gain2[0]"]);
  expect(context.node("gain2")!.targets()).toEqual(["splitter[0]"]);
  expect(context.node("splitter")!.targets()).toEqual(["merger[2]", "merger[3]"]);
  expect(context.node("merger")!.targets()).toEqual(["dest[0]"]);
  await probe.stop();
});

test("off: tone gain 0, then in one dip the merger off, the count and interpretation back, stereo forcing off", async () => {
  const { context, probe, edges } = setup();
  const before = edges();
  await probe.start();
  context.ops.length = 0;
  await probe.stop();
  expect(context.ops).toEqual([
    "gain2.gain→0", "gain1.gain→0", "merger✕dest", "dest.count=2", "dest.interp=speakers", "gain1.mode=max", "gain1.gain→1",
    "gain1.mode=max",
  ]);
  expect(probe.snapshot()).toMatchObject({ status: "idle", finished: true, failure: null });
  expect(context.destination).toMatchObject({ count: 2, interpretation: "speakers", mode: "explicit" });
  expect(context.node("gain1")).toMatchObject({ mode: "max", count: 2 });
  expect(edges()).toEqual(before);
  for (const name of ["source", "gain2", "splitter", "merger"]) expect(context.node(name)!.edges).toEqual([]);
  expect(context.node("source")!.stopped).toBe(true);
  expect(context.listeners.size).toBe(0);
});

test("a destination that started as something else gets its own values back", async () => {
  const { context, probe } = setup();
  context.destination.count = 6;
  context.destination.interpretation = "discrete";
  context.destination.maxChannelCount = 6;
  await probe.start();
  expect(context.destination.count).toBe(4);
  await probe.stop();
  expect(context.destination).toMatchObject({ count: 6, interpretation: "discrete" });
});

for (const refuses of ["ignore", "throw"] as const) {
  test(`a failed read-back (${refuses}) never connects the merger and leaves everything as it was`, async () => {
    const { context, probe, edges } = setup();
    const before = edges();
    context.destination.refuses = refuses;
    await probe.start();
    expect(probe.snapshot()).toMatchObject({ status: "idle", failure: "refused", finished: false });
    expect(context.ops.some(op => op.startsWith("merger→dest"))).toBe(false);
    expect(context.ops.some(op => op === "gain1.mode=explicit")).toBe(false);
    // Put back inside the same dip that wrote: the master never comes up on a half-written destination.
    const dipUp = context.ops.lastIndexOf("gain1.gain→1");
    expect(context.ops.lastIndexOf("dest.interp=speakers")).toBeLessThan(dipUp);
    expect(context.ops.filter(op => op === "gain1.gain→0")).toHaveLength(1);
    context.destination.refuses = null;
    expect(context.destination).toMatchObject({ count: 2, interpretation: "speakers" });
    expect(context.node("gain1")!.mode).toBe("max");
    expect(edges()).toEqual(before);
    expect(context.node("merger")!.edges).toEqual([]);
    expect(context.node("source")!.started).toBe(false);
    expect(probe.snapshot().lines.some(line => line.includes("δεν ξεκίνησε"))).toBe(true);
  });
}

test("it refuses to start without touching anything: no context, VST3 slots, a stopped context, a 2-channel output", async () => {
  const cases = [
    { options: { context: false }, failure: "no-context" },
    { options: { host: true }, failure: "host" },
    { options: {}, state: "suspended", failure: "not-running" },
    { options: {}, max: 2, failure: "stereo-device" },
  ] as const;
  for (const item of cases) {
    const { context, probe, ticking } = setup(item.options);
    if ("state" in item) context.state = item.state;
    if ("max" in item) context.destination.maxChannelCount = item.max;
    context.ops.length = 0;
    const made = context.made.length;
    await probe.start();
    expect(probe.snapshot()).toMatchObject({ status: "idle", failure: item.failure, finished: false });
    expect(context.ops).toEqual([]);
    expect(context.made.length).toBe(made);
    expect(ticking()).toBe(false);
    expect(PROBE_FAILURE_TEXT[item.failure]).toMatch(/[Α-Ωα-ω]/);
  }
});

test("with no bus it builds none: the destination is written without a dip and put back", async () => {
  const { context, ctx, probe } = setup({ bus: false });
  await probe.start();
  expect(hasMasterBus(ctx)).toBe(false);
  expect(context.ops).toEqual([
    "gain0.mode=explicit", "source→gain0[0]", "gain0→splitter[0]", "splitter→merger[2]", "splitter→merger[3]",
    "dest.interp=discrete", "dest.count=4", "merger→dest[0]", "gain0.gain→0.25",
  ]);
  await probe.stop();
  expect(hasMasterBus(ctx)).toBe(false);
  expect(context.destination).toMatchObject({ count: 2, interpretation: "speakers" });
  expect(context.made.map(node => node.name)).toEqual(["gain0", "splitter", "merger", "source"]);
});

test("it logs the destination every 250 ms, marks a change, and holds the count at 4 through a device change", async () => {
  const { context, probe, advance, everyMs } = setup();
  await probe.start();
  expect(everyMs()).toBe(250);
  advance();
  context.destination.maxChannelCount = 2;
  context.state = "interrupted";
  context.listeners.get("statechange")!();
  context.ops.length = 0;
  advance();
  advance();
  expect(context.ops.filter(op => op.startsWith("dest."))).toEqual([]); // the probe only watches
  expect(probe.snapshot().status).toBe("running");
  expect(probe.snapshot().maxSeen).toEqual([4, 2]);
  const lines = probe.snapshot().lines;
  expect(lines[0]).toBe("CrateMind test");
  expect(lines[1]).toBe("+0.00s  πριν: max=4 count=2 interp=speakers state=running mode=explicit rate=8000 bus=ναι");
  expect(lines.slice(2)).toEqual([
    "+0.00s  ο ήχος δοκιμής παίζει στα κανάλια 3–4",
    "+0.00s  max=4 count=4 interp=discrete state=running",
    "+0.25s  max=4 count=4 interp=discrete state=running",
    "+0.25s  συμβάν statechange: interrupted",
    "+0.50s  max=2 count=4 interp=discrete state=interrupted  ← άλλαξε",
    "+0.75s  max=2 count=4 interp=discrete state=interrupted",
  ]);
  await probe.stop();
  expect(probe.snapshot().lines.slice(-2)).toEqual([
    "+0.75s  τέλος: πατήθηκε «Διακοπή»",
    "+0.75s  μετά: max=2 count=2 interp=speakers state=interrupted",
  ]);
  expect(probeVerdict(probe.snapshot())).toContain("4 → 2");
});

test("start and stop are no-ops in the wrong state, a stop during the start waits for it, and a new start clears the log", async () => {
  const { context, probe, advance, ticking } = setup();
  await probe.stop();
  expect(probe.snapshot().lines).toEqual([]);
  const starting = probe.start();
  const second = probe.start();
  const stopping = probe.stop("left");
  await Promise.all([starting, second, stopping]);
  expect(probe.snapshot()).toMatchObject({ status: "idle", finished: true });
  expect(context.made.filter(node => node.name === "merger")).toHaveLength(1);
  expect(probe.snapshot().lines.some(line => line.endsWith("τέλος: έκλεισε η σελίδα"))).toBe(true);
  expect(ticking()).toBe(false);
  advance(); // a late timer after the stop logs nothing
  const length = probe.snapshot().lines.length;
  probe.sample();
  expect(probe.snapshot().lines.length).toBe(length);
  await probe.start();
  expect(probe.snapshot().lines.some(line => line.includes("τέλος"))).toBe(false);
  expect(probe.snapshot().finished).toBe(false);
  await probe.stop();
});

test("a forgotten probe turns itself off after ten minutes", async () => {
  const { context, probe, advance } = setup();
  await probe.start();
  for (let i = 1; i < PROBE_MAX_SAMPLES; i++) advance();
  await probe.stop("limit"); // queued behind the probe's own stop: a no-op
  expect(probe.snapshot()).toMatchObject({ status: "idle", finished: true });
  expect(probe.snapshot().lines.some(line => line.endsWith("τέλος: πέρασαν 10 λεπτά"))).toBe(true);
  expect(context.destination).toMatchObject({ count: 2, interpretation: "speakers" });
});

test("subscribers hear every change and the snapshot is stable between changes", async () => {
  const { probe, advance } = setup();
  let calls = 0;
  const unsubscribe = probe.subscribe(() => { calls++; });
  const first = probe.snapshot();
  expect(probe.snapshot()).toBe(first);
  await probe.start();
  expect(calls).toBeGreaterThan(0);
  const running = probe.snapshot();
  expect(running).not.toBe(first);
  advance();
  expect(probe.snapshot()).not.toBe(running);
  unsubscribe();
  const heard = calls;
  await probe.stop();
  expect(calls).toBe(heard);
});

test("the verdict and the copied report are plain Greek and carry the three questions", () => {
  expect(probeVerdict({ finished: false, maxSeen: [4] })).toBeNull();
  expect(probeVerdict({ finished: true, maxSeen: [] })).toBeNull();
  expect(probeVerdict({ finished: true, maxSeen: [4] })).toContain("έμεινε 4");
  expect(probeVerdict({ finished: true, maxSeen: [4, 2, 4] })).toContain("4 → 2 → 4");
  const report = probeReport({ finished: true, maxSeen: [4, 2], lines: ["a", "b"] }).split("\n");
  expect(report.slice(0, 3)).toEqual(["CrateMind · Έλεγχος εξόδου ακουστικών", "a", "b"]);
  expect(report).toContain(probeVerdict({ finished: true, maxSeen: [4, 2] })!);
  expect(report.slice(-3)).toEqual(PROBE_QUESTIONS.map((question, i) => `${i + 1}. ${question} Απάντηση:`));
  expect(probeReport({ finished: false, maxSeen: [], lines: ["a"] }).split("\n")).toHaveLength(6);
});

test("the probe is offered only in the macOS desktop app", () => {
  expect(cueProbeSupported(true, "macos aarch64")).toBe(true);
  expect(cueProbeSupported(false, "macos aarch64")).toBe(false);
  expect(cueProbeSupported(true, "windows x86_64")).toBe(false);
  expect(cueProbeSupported(true, undefined)).toBe(false);
});

test("setMasterStereo forces out to explicit stereo and back, and never builds a bus", () => {
  const context = new Context();
  const ctx = context as unknown as AudioContext;
  setMasterStereo(ctx, true);
  expect(hasMasterBus(ctx)).toBe(false);
  expect(context.made).toEqual([]);
  masterInput(ctx);
  expect(hasMasterBus(ctx)).toBe(true);
  const [input, output] = context.made;
  setMasterStereo(ctx, true);
  expect(output).toMatchObject({ mode: "explicit", count: 2 });
  expect(input.mode).toBe("max");
  setMasterStereo(ctx, false);
  expect(output).toMatchObject({ mode: "max", count: 2 });
});
