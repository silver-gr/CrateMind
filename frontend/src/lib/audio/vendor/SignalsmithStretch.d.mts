export interface StretchSchedule { active?: boolean; input?: number; outputTime?: number; rate?: number; semitones?: number; loopStart?: number; loopEnd?: number }
export interface StretchNode extends AudioWorkletNode {
  /** Position within the stored audio, updated by the worklet. */
  inputTime: number;
  latency(): Promise<number>;
  schedule(event: StretchSchedule): unknown;
  addBuffers(channels: Float32Array[], transfer?: Transferable[]): Promise<number>;
  dropBuffers(): Promise<unknown>;
}
interface CreateNode {
  (context: BaseAudioContext, options?: AudioWorkletNodeOptions): Promise<StretchNode>;
  moduleUrl?: string;
}
declare const SignalsmithStretch: CreateNode;
export default SignalsmithStretch;
