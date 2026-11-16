// The built-in Maximizer: master_me (Faust → wasm, see ./master_me/README.md), no Faust runtime.
// Messages in: {wasm, params} once, then {set: {symbol: value}} and {active: bool}; out: {ready}, {meters}, {error}.
const BLOCK = 128;
const env = { _expf: Math.exp, _logf: Math.log, _log10f: Math.log10, _powf: Math.pow, _tanf: Math.tan };
// The patched build reports both gain reductions in dB (≤ 0); loudness is short-term LUFS.
const METERS = { lufsOut: "lufs_out", limiterDb: "limiter_gain_reduction", brickwallDb: "brickwall_limit" };
const METER_FLOOR = -70;

function copy(target, source) {
  if (!target) return;
  if (source) target.set(source);
  else target.fill(0);
}

class MasterMe extends AudioWorkletProcessor {
  constructor() {
    super();
    this.dsp = null;
    this.index = null;
    this.active = true;
    this.failed = false;
    // Faust's init() resets every parameter, so anything sent before it is applied afterwards.
    this.queue = [];
    this.blocks = 0;
    this.meterEvery = Math.max(1, Math.round(sampleRate / BLOCK / 30));
    this.meters = { lufsOut: METER_FLOOR, limiterDb: 0, brickwallDb: 0 };
    this.message = { meters: this.meters };
    this.port.onmessage = ({ data }) => {
      if (data?.wasm) void this.load(data.wasm, data.params);
      else if (this.dsp) this.apply(data);
      else this.queue.push(data);
    };
  }

  async load(bytes, { size, params }) {
    try {
      const { instance } = await WebAssembly.instantiate(bytes, { env });
      const dsp = instance.exports;
      // Layout after the DSP state: 2 input + 2 output pointers, then 4 blocks of float samples.
      const base = Math.ceil(size / 16) * 16;
      this.pointers = base;
      this.offsets = [0, 1, 2, 3].map(i => base + 16 + i * BLOCK * 4);
      const need = this.offsets[3] + BLOCK * 4;
      if (dsp.memory.buffer.byteLength < need) dsp.memory.grow(Math.ceil((need - dsp.memory.buffer.byteLength) / 65536));
      new Int32Array(dsp.memory.buffer, base, 4).set(this.offsets);
      this.index = params;
      dsp.init(0, sampleRate);
      this.dsp = dsp;
      this.views();
      this.queue.forEach(message => this.apply(message));
      this.queue = [];
      this.port.postMessage({ ready: true });
    } catch (error) {
      this.fail(error);
    }
  }

  views() {
    this.heap = this.dsp.memory.buffer;
    this.io = this.offsets.map(offset => new Float32Array(this.heap, offset, BLOCK));
  }

  apply(message) {
    if (message?.set) {
      for (const [symbol, value] of Object.entries(message.set)) {
        if (symbol in this.index && Number.isFinite(value)) this.dsp.setParamValue(0, this.index[symbol], value);
      }
    }
    if (typeof message?.active === "boolean" && message.active !== this.active) {
      // Re-enabling must not bring back stale leveler gain or limiter state.
      if (message.active) this.dsp.instanceClear(0);
      this.active = message.active;
    }
  }

  fail(error) {
    if (this.failed) return;
    this.failed = true;
    this.port.postMessage({ error: String(error?.message ?? error) });
  }

  process(inputs, outputs) {
    const input = inputs[0] ?? [];
    const output = outputs[0];
    const left = input[0];
    const right = input[1] ?? left;
    const n = output[0]?.length ?? 0;
    if (!this.dsp || this.failed || !this.active || n !== BLOCK) {
      copy(output[0], left);
      copy(output[1], right);
      return true;
    }
    try {
      if (this.heap !== this.dsp.memory.buffer) this.views();
      const [inL, inR, outL, outR] = this.io;
      for (let i = 0; i < BLOCK; i++) {
        const l = left ? left[i] : 0;
        const r = right ? right[i] : 0;
        // A NaN would poison the DSP's feedback state for good.
        inL[i] = Number.isFinite(l) ? l : 0;
        inR[i] = Number.isFinite(r) ? r : 0;
      }
      this.dsp.compute(0, BLOCK, this.pointers, this.pointers + 8);
      output[0].set(outL);
      output[1]?.set(outR);
      if (++this.blocks % this.meterEvery === 0) {
        for (const key in METERS) {
          const value = this.dsp.getParamValue(0, this.index[METERS[key]]);
          this.meters[key] = Number.isFinite(value) ? value : key === "lufsOut" ? METER_FLOOR : 0;
        }
        this.port.postMessage(this.message);
      }
    } catch (error) {
      this.fail(error);
      copy(output[0], left);
      copy(output[1], right);
    }
    return true;
  }
}

registerProcessor("cratemind-master-me", MasterMe);
