/** Bounded, stereo-linked sample-peak limiter shared by both browser processing paths. */
export class PeakLimiterDSP {
  constructor(sampleRate: number);
  readonly delay: number;
  readonly ceiling: number;
  readonly count: number;
  reset(): void;
  process(input: readonly Float32Array[] | undefined, output: readonly Float32Array[] | undefined): boolean;
}
