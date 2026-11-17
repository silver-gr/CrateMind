// Deck FX rack processor: a thin wrapper around the pure engine in ./core (§1 Files). The port feeds the engine;
// a thrown error copies the dry input, resets the engine and posts `fault`. process() always returns true.
import { FxRackEngine } from "./core";
import { createSlicer } from "./slicer";
import { FX_RACK_PARAMS, FX_RACK_PROCESSOR } from "./types";

function copyDry(input, output) {
  for (let c = 0; c < output.length; c++) {
    const src = input[c] ?? input[0];
    if (src) output[c].set(src);
    else output[c].fill(0);
  }
}

class FxRackProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return FX_RACK_PARAMS.map(p => ({ ...p }));
  }

  constructor() {
    super();
    this.engine = new FxRackEngine(sampleRate, msg => this.port.postMessage(msg), { createSlicer });
    this.port.onmessage = ({ data }) => {
      try {
        if (data && typeof data.t === "string") this.engine.message(data);
      } catch {
        this.fault();
      }
    };
  }

  fault() {
    this.engine.reset();
    this.port.postMessage({ t: "fault" });
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output?.length) return true;
    const input = inputs[0] ?? [];
    try {
      this.engine.process(input, output, parameters, currentFrame);
    } catch {
      copyDry(input, output);
      this.fault();
    }
    return true;
  }
}

registerProcessor(FX_RACK_PROCESSOR, FxRackProcessor);
