/* Stereo-linked sample-peak limiter. This does not measure reconstructed true peaks. */
export class PeakLimiterDSP {
  constructor(sampleRate) {
    this.delay = Math.max(1, Math.round(sampleRate * 0.005));
    this.ceiling = Math.pow(10, -1 / 20);
    this.attack = Math.exp(-1 / (sampleRate * 0.001));
    this.release = Math.exp(-1 / (sampleRate * 0.06));
    this.left = new Float32Array(this.delay);
    this.right = new Float32Array(this.delay);
    this.capacity = this.delay + 2;
    this.peaks = new Float64Array(this.capacity);
    this.indices = new Float64Array(this.capacity);
    this.reset();
  }

  reset() {
    this.left.fill(0);
    this.right.fill(0);
    this.position = 0;
    this.frame = 0;
    this.head = 0;
    this.count = 0;
    this.gain = 1;
  }

  process(input, output) {
    if (!output?.length) return true;
    const left = input?.[0];
    const right = input?.[1] ?? left;
    for (let i = 0; i < output[0].length; i++) {
      const l = Number.isFinite(left?.[i]) ? left[i] : 0;
      const r = Number.isFinite(right?.[i]) ? right[i] : 0;
      const delayedL = this.left[this.position];
      const delayedR = this.right[this.position];
      this.left[this.position] = l;
      this.right[this.position] = r;
      this.position = (this.position + 1) % this.delay;

      // Monotonic queue: each peak enters and leaves once, independent of delay length.
      while (this.count && this.indices[this.head] < this.frame - this.delay) {
        this.head = (this.head + 1) % this.capacity;
        this.count--;
      }
      const peak = Math.max(Math.abs(l), Math.abs(r));
      while (this.count) {
        const tail = (this.head + this.count - 1) % this.capacity;
        if (this.peaks[tail] > peak) break;
        this.count--;
      }
      const tail = (this.head + this.count) % this.capacity;
      this.peaks[tail] = peak;
      this.indices[tail] = this.frame++;
      this.count++;
      const maximum = this.peaks[this.head];
      const target = maximum > this.ceiling ? this.ceiling / maximum : 1;
      const coefficient = target < this.gain ? this.attack : this.release;
      this.gain = target + coefficient * (this.gain - target);
      // The smooth envelope has finite attack; this final linked guard enforces the ceiling.
      const outputPeak = Math.max(Math.abs(delayedL), Math.abs(delayedR));
      const gain = Math.min(this.gain, outputPeak > this.ceiling ? this.ceiling / outputPeak : 1);
      output[0][i] = delayedL * gain;
      if (output[1]) output[1][i] = delayedR * gain;
      for (let channel = 2; channel < output.length; channel++) output[channel][i] = 0;
    }
    return true;
  }
}
