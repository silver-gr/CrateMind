// Master tap for the experimental VST3 master host and the set recorder: interleaves the bus output into stereo
// f32 blocks (256 frames by default; `processorOptions.frames` for the recorder) for the worker, either through a
// shared ring (SharedArrayBuffer, the main thread never touches it) or as buffers posted (transferred) to a
// MessagePort. Its own output stays silent.
// RING_FRAMES, CHUNK_FRAMES and the ring layout are copies of masterRing.ts: keep them in step.
const FRAMES = 256; // CHUNK_FRAMES
const RING_FRAMES = 65536;

class MasterTapProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    // Port path only; the ring path and its wake-up threshold stay at FRAMES.
    this.frames = options?.processorOptions?.frames ?? FRAMES;
    this.out = null;
    this.ring = null; // { h: Int32Array [write, read, overruns, reserved], data: Float32Array }
    this.alive = true;
    this.buffer = new Float32Array(this.frames * 2);
    this.filled = 0;
    this.port.onmessage = event => {
      const message = event.data ?? {};
      // One output at a time: a port replaces the ring, and a ring is refused once a port is set.
      if (message.port) {
        this.out = message.port;
        this.ring = null;
      }
      if ("ring" in message) {
        const ok = !this.out && typeof SharedArrayBuffer === "function" && message.ring instanceof SharedArrayBuffer;
        if (ok) this.ring = { h: new Int32Array(message.ring, 0, 4), data: new Float32Array(message.ring, 16, RING_FRAMES * 2) };
        this.port.postMessage({ ring: ok });
      }
      if (message.stop) {
        this.alive = false;
        this.out?.close();
        this.out = null;
        this.ring = null;
      }
    };
  }

  process(inputs) {
    if (!this.out && !this.ring) return this.alive;
    const channels = inputs[0] ?? [];
    // No deck connected: send silence anyway, so the host does not count it as underruns.
    const left = channels[0], right = channels[1] ?? channels[0];
    const frames = left?.length ?? 128;
    if (this.ring) {
      this.write(left, right, frames);
      return this.alive;
    }
    for (let i = 0; i < frames; i++) {
      const at = this.filled * 2;
      this.buffer[at] = left ? left[i] : 0;
      this.buffer[at + 1] = right ? right[i] : 0;
      if (++this.filled === this.frames) {
        this.out.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(this.frames * 2);
        this.filled = 0;
      }
    }
    return this.alive;
  }

  // Allocates nothing and never waits: a block that does not fit is dropped and counted.
  write(left, right, frames) {
    const { h, data } = this.ring;
    const read = Atomics.load(h, 1), write = Atomics.load(h, 0);
    if (((write - read) | 0) + frames > RING_FRAMES) {
      Atomics.add(h, 2, 1);
      return;
    }
    for (let i = 0, slot = write & (RING_FRAMES - 1); i < frames; i++, slot = (slot + 1) & (RING_FRAMES - 1)) {
      data[slot * 2] = left ? left[i] : 0;
      data[slot * 2 + 1] = right ? right[i] : 0;
    }
    const next = (write + frames) | 0;
    Atomics.store(h, 0, next);
    // Wake the worker once a whole chunk waits (not at multiples of 256: its read can sit at a 128 phase).
    if (((next - read) | 0) >= FRAMES) Atomics.notify(h, 0);
  }
}

registerProcessor("cratemind-master-tap", MasterTapProcessor);
