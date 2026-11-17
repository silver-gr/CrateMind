// Shared ring between the master tap worklet (writer) and the master tap worker (reader). The worklet
// stays self-contained and copies RING_FRAMES and CHUNK_FRAMES; keep master-tap.worklet.js in step.
// Layout: Int32Array(sab, 0, 4) = [write, read, overruns, reserved], then Float32Array(sab, 16, RING_FRAMES * 2)
// of interleaved stereo frames. Positions are free-running int32 frame counts: fill = (w - r) | 0, slot = pos & (RING_FRAMES - 1).
export const RING_FRAMES = 65536; // 512 KB: 1.49 s at 44.1 kHz, 171 ms at 384 kHz
export const CHUNK_FRAMES = 256;
const HEADER_BYTES = 16;

export interface RingViews { h: Int32Array; data: Float32Array }

/** Atomics.waitAsync (ES2024, missing from this project's ES2020 lib); undefined where the engine lacks it. */
type WaitAsync = (typed: Int32Array, index: number, value: number, timeoutMs?: number) => { async: boolean; value: Promise<string> | string };
export const waitAsync = () => (Atomics as unknown as { waitAsync?: WaitAsync }).waitAsync;

export function createRing(): SharedArrayBuffer {
  return new SharedArrayBuffer(HEADER_BYTES + RING_FRAMES * 2 * Float32Array.BYTES_PER_ELEMENT);
}

export function ringViews(sab: SharedArrayBuffer): RingViews {
  return { h: new Int32Array(sab, 0, 4), data: new Float32Array(sab, HEADER_BYTES, RING_FRAMES * 2) };
}

/** Sends every whole chunk up to write position `w` as a new 256-frame stereo buffer, storing read after each. Returns the fill before draining. */
export function drainRing({ h, data }: RingViews, w: number, send: (chunk: Float32Array<ArrayBuffer>) => void): number {
  let r = Atomics.load(h, 1);
  const fill = (w - r) | 0;
  while (((w - r) | 0) >= CHUNK_FRAMES) {
    const chunk = new Float32Array(CHUNK_FRAMES * 2);
    const at = (r & (RING_FRAMES - 1)) * 2, end = Math.min(at + chunk.length, data.length);
    chunk.set(data.subarray(at, end));
    if (end - at < chunk.length) chunk.set(data.subarray(0, chunk.length - (end - at)), end - at); // split at the wrap
    r = (r + CHUNK_FRAMES) | 0;
    Atomics.store(h, 1, r);
    send(chunk);
  }
  return fill;
}
