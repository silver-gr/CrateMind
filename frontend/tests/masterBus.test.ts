import { expect, jest, test } from "bun:test";
import { masterInput, setMasterInsert, setMasterSink, withMasterDip } from "../src/lib/audio/masterBus";

class Parameter {
  value = 1;
  events: unknown[][] = [];
  cancelAndHoldAtTime(time: number) { this.events.push(["hold", time]); }
  linearRampToValueAtTime(value: number, time: number) { this.value = value; this.events.push(["ramp", value, time]); }
}
class Node {
  connections: unknown[] = [];
  gain = new Parameter();
  connect(node: unknown) { this.connections.push(node); return node; }
  disconnect(node?: unknown) {
    if (node === undefined) { this.connections = []; return; }
    if (!this.connections.includes(node)) throw new Error("InvalidAccessError");
    this.connections = this.connections.filter(other => other !== node);
  }
}
class Context {
  state = "running";
  currentTime = 2;
  destination = new Node();
  gains: Node[] = [];
  createGain() { const node = new Node(); this.gains.push(node); return node; }
}

function bus(state = "running") {
  const context = Object.assign(new Context(), { state });
  const ctx = context as unknown as BaseAudioContext;
  const input = masterInput(ctx) as unknown as Node;
  const [, output] = context.gains;
  return { context, ctx, input, output };
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test("the bus is built once per context: in → out → destination", () => {
  const { context, ctx, input, output } = bus();
  expect(masterInput(ctx)).toBe(input as unknown as AudioNode);
  expect(context.gains).toEqual([input, output]);
  expect(input.connections).toEqual([output]);
  expect(output.connections).toEqual([context.destination]);
  expect(masterInput(new Context() as unknown as BaseAudioContext)).not.toBe(input as unknown as AudioNode);
});

test("an insert sits between in and out, is replaced cleanly and keeps its owner's other outputs", () => {
  const { ctx, input, output } = bus();
  const meter = new Node();
  const first = new Node();
  first.connect(meter);
  setMasterInsert(ctx, first as unknown as AudioNode);
  expect(input.connections).toEqual([first]);
  expect(first.connections).toEqual([meter, output]);
  const second = new Node();
  setMasterInsert(ctx, second as unknown as AudioNode);
  expect(input.connections).toEqual([second]);
  expect(first.connections).toEqual([meter]);
  expect(second.connections).toEqual([output]);
  second.disconnect(); // its owner already tore it down
  setMasterInsert(ctx, null);
  expect(input.connections).toEqual([output]);
});

test("a sink replaces the speakers, null restores them, and insert and sink do not disturb each other", () => {
  const { context, ctx, input, output } = bus();
  const tap = new Node();
  const insert = new Node();
  setMasterSink(ctx, tap as unknown as AudioNode);
  expect(output.connections).toEqual([tap]);
  setMasterInsert(ctx, insert as unknown as AudioNode);
  expect(input.connections).toEqual([insert]);
  expect(insert.connections).toEqual([output]);
  expect(output.connections).toEqual([tap]);
  setMasterSink(ctx, null);
  expect(output.connections).toEqual([context.destination]);
  expect(input.connections).toEqual([insert]);
  setMasterInsert(ctx, null);
  expect(input.connections).toEqual([output]);
  expect(output.connections).toEqual([context.destination]);
});

test("a dip fades out over ~15 ms, runs fn, then fades back in", async () => {
  const { ctx, output } = bus();
  const insert = new Node();
  const order: string[] = [];
  jest.useFakeTimers();
  try {
    const done = withMasterDip(ctx, () => { order.push(`fn at gain ${output.gain.value}`); setMasterInsert(ctx, insert as unknown as AudioNode); })
      .then(() => { order.push("done"); });
    await flush();
    expect(output.gain.events).toEqual([["hold", 2], ["ramp", 0, 2.015]]);
    expect(order).toEqual([]);
    jest.advanceTimersByTime(15);
    await flush();
    await done;
    expect(order).toEqual(["fn at gain 0", "done"]);
    expect(output.gain.events.slice(2)).toEqual([["hold", 2], ["ramp", 1, 2.015]]);
    expect(insert.connections).toEqual([output]);
    expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});

test("without a running context the dip just runs fn", async () => {
  const { ctx, output } = bus("suspended");
  let ran = false;
  await withMasterDip(ctx, async () => { ran = true; });
  expect(ran).toBe(true);
  expect(output.gain.events).toEqual([]);
});

test("a failing fn still fades back in and its error reaches the caller", async () => {
  const { ctx, output } = bus();
  jest.useFakeTimers();
  try {
    const failed = withMasterDip(ctx, () => { throw new Error("boom"); }).then(() => null, (error: Error) => error.message);
    await flush();
    jest.advanceTimersByTime(15);
    expect(await failed).toBe("boom");
    expect(output.gain.value).toBe(1);
    expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});

test("a stuck fn releases the dip after 2 s, and its late failure stays handled", async () => {
  const { ctx, output } = bus();
  let fail!: (error: Error) => void;
  jest.useFakeTimers();
  try {
    let settled = false;
    const done = withMasterDip(ctx, () => new Promise<void>((_, reject) => { fail = reject; })).then(() => { settled = true; });
    await flush();
    jest.advanceTimersByTime(15);
    await flush();
    jest.advanceTimersByTime(1999);
    await flush();
    expect(settled).toBe(false);
    expect(output.gain.value).toBe(0);
    jest.advanceTimersByTime(1);
    await done;
    expect(output.gain.value).toBe(1);
    fail(new Error("late"));
    await flush();
  } finally { jest.useRealTimers(); }
});

test("an older dip that finishes first does not bring the bus back while a newer one is still working", async () => {
  const { ctx, output } = bus();
  let finishNewer!: () => void;
  jest.useFakeTimers();
  try {
    const older = withMasterDip(ctx, () => {});
    const newer = withMasterDip(ctx, () => new Promise<void>(resolve => { finishNewer = resolve; }));
    await flush();
    jest.advanceTimersByTime(15);
    await older;
    expect(output.gain.value).toBe(0);
    finishNewer();
    await newer;
    expect(output.gain.value).toBe(1);
    expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});
