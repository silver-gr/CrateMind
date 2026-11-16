// Master tap for the experimental VST3 master host: interleaves the bus output into 256-frame
// stereo f32 buffers and posts them (transferred) to the worker's MessagePort. Its own output stays silent.
const FRAMES = 256;

class MasterTapProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.out = null;
    this.alive = true;
    this.buffer = new Float32Array(FRAMES * 2);
    this.filled = 0;
    this.port.onmessage = event => {
      if (event.data?.port) this.out = event.data.port;
      if (event.data?.stop) {
        this.alive = false;
        this.out?.close();
        this.out = null;
      }
    };
  }

  process(inputs) {
    if (!this.out) return this.alive;
    const channels = inputs[0] ?? [];
    // No deck connected: send silence anyway, so the host does not count it as underruns.
    const left = channels[0], right = channels[1] ?? channels[0];
    const frames = left?.length ?? 128;
    for (let i = 0; i < frames; i++) {
      const at = this.filled * 2;
      this.buffer[at] = left ? left[i] : 0;
      this.buffer[at + 1] = right ? right[i] : 0;
      if (++this.filled === FRAMES) {
        this.out.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(FRAMES * 2);
        this.filled = 0;
      }
    }
    return this.alive;
  }
}

registerProcessor("cratemind-master-tap", MasterTapProcessor);
