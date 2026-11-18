// Master tap for the set recorder and the experimental VST3 slots. Its own output stays silent.
// - Default (the recorder): one stereo input, interleaved into stereo f32 blocks of `processorOptions.frames`
//   (256 by default), posted (transferred) to a MessagePort as Float32Array.
// - `processorOptions.decks: true` (the VST3 host): input 0 is deck A, input 1 deck B. Each frame of N frames is a
//   32-byte header (reserved for the decks' clocks, zero for now) and then f32 AL, AR, BL, BR × N, either posted
//   (transferred) as an ArrayBuffer or written into a shared 4-channel ring (SharedArrayBuffer, the main thread never
//   touches it) that the worker frames itself.
// RING_FRAMES, CHUNK_FRAMES, CH, the header size and the ring layout are copies of masterRing.ts: keep them in step.
const FRAMES = 256; // CHUNK_FRAMES
const RING_FRAMES = 65536;
const CH = 4;
const HEADER_BYTES = 32;

class MasterTapProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options?.processorOptions ?? {};
    this.decks = opts.decks === true;
    // Port path only; the ring path and its wake-up threshold stay at FRAMES.
    this.frames = opts.frames ?? FRAMES;
    this.out = null;
    this.ring = null; // decks only: { h: Int32Array [write, read, overruns, reserved], data: Float32Array }
    this.alive = true;
    this.filled = 0;
    if (this.decks) this.newFrame();
    else this.buffer = new Float32Array(this.frames * 2);
    this.port.onmessage = event => {
      const message = event.data ?? {};
      // One output at a time: a port replaces the ring, and a ring is refused once a port is set.
      if (message.port) {
        this.out = message.port;
        this.ring = null;
      }
      if ("ring" in message) {
        const ok = this.decks && !this.out && typeof SharedArrayBuffer === "function" && message.ring instanceof SharedArrayBuffer;
        if (ok) this.ring = { h: new Int32Array(message.ring, 0, 4), data: new Float32Array(message.ring, 16, RING_FRAMES * CH) };
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

  // A fresh headed frame for the port path (zeroed, so the header stays zero).
  newFrame() {
    this.frame = new ArrayBuffer(HEADER_BYTES + this.frames * CH * 4);
    this.samples = new Float32Array(this.frame, HEADER_BYTES);
  }

  process(inputs) {
    if (!this.out && !this.ring) return this.alive;
    if (this.decks) return this.processDecks(inputs);
    const channels = inputs[0] ?? [];
    // No deck connected: send silence anyway, so the reader does not count it as a gap.
    const left = channels[0], right = channels[1] ?? channels[0];
    const frames = left?.length ?? 128;
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

  processDecks(inputs) {
    // A missing input is silence; a mono one feeds both sides.
    const a = inputs[0] ?? [], b = inputs[1] ?? [];
    const al = a[0], ar = a[1] ?? a[0], bl = b[0], br = b[1] ?? b[0];
    const frames = al?.length ?? bl?.length ?? 128;
    if (this.ring) {
      this.write(al, ar, bl, br, frames);
      return this.alive;
    }
    for (let i = 0; i < frames; i++) {
      const at = this.filled * CH;
      this.samples[at] = al ? al[i] : 0;
      this.samples[at + 1] = ar ? ar[i] : 0;
      this.samples[at + 2] = bl ? bl[i] : 0;
      this.samples[at + 3] = br ? br[i] : 0;
      if (++this.filled === this.frames) {
        this.out.postMessage(this.frame, [this.frame]);
        this.newFrame();
        this.filled = 0;
      }
    }
    return this.alive;
  }

  // Allocates nothing and never waits: a block that does not fit is dropped and counted.
  write(al, ar, bl, br, frames) {
    const { h, data } = this.ring;
    const read = Atomics.load(h, 1), write = Atomics.load(h, 0);
    if (((write - read) | 0) + frames > RING_FRAMES) {
      Atomics.add(h, 2, 1);
      return;
    }
    for (let i = 0, slot = write & (RING_FRAMES - 1); i < frames; i++, slot = (slot + 1) & (RING_FRAMES - 1)) {
      const at = slot * CH;
      data[at] = al ? al[i] : 0;
      data[at + 1] = ar ? ar[i] : 0;
      data[at + 2] = bl ? bl[i] : 0;
      data[at + 3] = br ? br[i] : 0;
    }
    const next = (write + frames) | 0;
    Atomics.store(h, 0, next);
    // Wake the worker once a whole chunk waits (not at multiples of 256: its read can sit at a 128 phase).
    if (((next - read) | 0) >= FRAMES) Atomics.notify(h, 0);
  }
}

registerProcessor("cratemind-master-tap", MasterTapProcessor);
