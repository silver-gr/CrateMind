// FX rack CPU bench (§8): run with `bun tests/fxRackBench.ts`, outside `bun test`. Every preset at amount 1, at 48 and
// 96 kHz, on a 145 BPM clock: steady state with one voice, and with a ringing tail beside it. It fails (exit code 1)
// above 250 ns/frame (500 with a tail) or above 10 ns/frame in bypass.
import { FxRackEngine } from "../src/lib/fxRack/core";
import { FX_PRESETS } from "../src/lib/fxRack/presets";
import { createSlicer } from "../src/lib/fxRack/slicer";

const N = 128;
const BPM = 145;
const LIMIT = 250;
const LIMIT_TAIL = 500;
const LIMIT_BYPASS = 10;

type Rig = { e: FxRackEngine; frame: number; oL: Float32Array; oR: Float32Array };
const params = { amount: new Float32Array([1]), fader: new Float32Array([1]) };
/** One second of seeded noise at −10 dBFS per rate, as stereo quanta made once and cycled. */
const noise = new Map<number, Float32Array[][]>();

function rig(fs: number): Rig {
  const e = new FxRackEngine(fs, undefined, { createSlicer });
  const fpb = (fs * 60) / BPM;
  e.message({ t: "clock", validFrom: 0, playing: true, knots: [0, 0, fpb * 1e5, 1e5], bpm: BPM, rate: 1, trusted: true, seek: false });
  e.message({ t: "track", rootPc: 9, minor: true, keylock: true });
  if (!noise.has(fs)) {
    const quanta: Float32Array[][] = [];
    let seed = 1;
    for (let k = 0; k < Math.ceil(fs / N); k++) {
      const buf = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
        buf[i] = 0.3 * (seed / 2147483648);
      }
      quanta.push([buf, buf]);
    }
    noise.set(fs, quanta);
  }
  return { e, frame: 0, oL: new Float32Array(N), oR: new Float32Array(N) };
}

/** Renders `seconds` of noise; returns ns per frame (wall time of the whole run). */
function run(r: Rig, fs: number, seconds: number): number {
  const src = noise.get(fs)!, quanta = Math.ceil((fs * seconds) / N), out = [r.oL, r.oR];
  const t0 = performance.now();
  for (let k = 0; k < quanta; k++) {
    r.e.process(src[k % src.length], out, params, r.frame);
    r.frame += N;
  }
  return ((performance.now() - t0) * 1e6) / (quanta * N);
}

function preset(r: Rig, id: string, beats: number) {
  r.e.message({ t: "preset", id, beats });
}

/**
 * The engine's own cost on a shared machine: three fresh setups, each timed in ten 0.1 s slices, and the 10th
 * percentile of those 30 slices (a busy machine moves the process between performance and efficiency cores, which
 * swings single runs by 2–3×).
 */
function cost(setup: () => Rig, fs: number, warm: number, between?: (r: Rig) => void): number {
  const slices: number[] = [];
  for (let k = 0; k < 3; k++) {
    // Each engine holds ~10 MB of lines; collect the previous ones outside the timed slices.
    Bun.gc(true);
    const r = setup();
    run(r, fs, warm);
    between?.(r);
    for (let s = 0; s < 10; s++) slices.push(run(r, fs, 0.1));
  }
  slices.sort((a, b) => a - b);
  return slices[2];
}

function engaged(fs: number, id: string, beats: number): Rig {
  const r = rig(fs);
  preset(r, id, beats);
  r.e.message({ t: "engage", lag: 0 });
  return r;
}

const failures: string[] = [];
console.log(`Load average at start: ${(await import("node:os")).loadavg().map(v => v.toFixed(2)).join(" ")}`);
for (const fs of [48000, 96000]) {
  // Warm the JIT on every preset and on bypass first.
  for (const p of FX_PRESETS) run(engaged(fs, p.id, p.beats?.def ?? 0), fs, 0.3);
  run(rig(fs), fs, 3);
  let bypass = cost(() => rig(fs), fs, 0.2);
  for (let retry = 0; retry < 2 && bypass > LIMIT_BYPASS; retry++) bypass = Math.min(bypass, cost(() => rig(fs), fs, 0.2));
  console.log(`\n${fs / 1000} kHz — bypass ${bypass.toFixed(1)} ns/frame (limit ${LIMIT_BYPASS})`);
  if (bypass > LIMIT_BYPASS) failures.push(`bypass at ${fs}: ${bypass.toFixed(1)}`);
  console.log("preset".padEnd(22) + "one voice".padStart(11) + "with tail".padStart(11));
  const measure = (id: string, beats: number) => [
    cost(() => engaged(fs, id, beats), fs, 0.5),
    // A tail: release, then engage again while the first instance still rings.
    cost(() => engaged(fs, id, beats), fs, 0.5, r => {
      r.e.message({ t: "release", atBeat: null });
      run(r, fs, 0.02);
      r.e.message({ t: "engage", lag: 0 });
    }),
  ];
  const rows = FX_PRESETS.map(p => {
    const [one, tail] = measure(p.id, p.beats?.def ?? 0);
    return { id: p.id, beats: p.beats?.def ?? 0, one, tail };
  });
  // A busy spell on a shared machine can last seconds and lands where the allocations put it, so an over-limit preset
  // is re-measured after the whole pass, up to twice, keeping the lowest.
  for (const row of rows) {
    for (let retry = 0; retry < 2 && (row.one > LIMIT || row.tail > LIMIT_TAIL); retry++) {
      const [o, t] = measure(row.id, row.beats);
      row.one = Math.min(row.one, o);
      row.tail = Math.min(row.tail, t);
    }
  }
  for (const { id, one, tail } of rows) {
    const flag = one > LIMIT || tail > LIMIT_TAIL ? "  FAIL" : "";
    console.log(id.padEnd(22) + one.toFixed(0).padStart(11) + tail.toFixed(0).padStart(11) + flag);
    if (flag) failures.push(`${id} at ${fs}: ${one.toFixed(0)} / ${tail.toFixed(0)}`);
  }
}
if (failures.length) {
  console.log(`\nOver the limit:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\nAll presets within the limits.");
