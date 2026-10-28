import { PeakLimiterDSP } from "./peak-limiter-core.js";

class PeakLimiter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.dsp = new PeakLimiterDSP(sampleRate);
    this.ready = false;
    this.port.onmessage = ({ data }) => { if (data?.type === "reset") this.dsp.reset(); };
  }

  process(inputs, outputs) {
    this.dsp.process(inputs[0], outputs[0]);
    if (!this.ready && outputs[0]?.length) {
      this.ready = true;
      this.port.postMessage({ type: "ready" });
    }
    return true;
  }
}

registerProcessor("cratemind-peak-limiter", PeakLimiter);
