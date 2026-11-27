import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
// Vite supplies these emitted module URLs in-app; the Maximizer flag and stand-in engine match tests/masterHost.test.ts, which
// shares this process and expects a build that has the Maximizer whichever file loads the audio modules first.
mock.module("../src/lib/audio/peak-limiter.worklet.js?worker&url", () => ({ default: "/test/peak-limiter.worklet.js" }));
mock.module("../src/lib/audio/master-tap.worklet.js?worker&url", () => ({ default: "/test/master-tap.worklet.js" }));
mock.module("../src/lib/audio/masterTap.worker.ts?worker&url", () => ({ default: "/test/masterTap.worker.js" }));
(globalThis as { __MAXIMIZER__?: boolean }).__MAXIMIZER__ = true;
mock.module("virtual:maximizer-engine", () => ({ loadMaximizer: async () => new ArrayBuffer(8), createMaximizer: () => { throw new Error("not stubbed"); } }));
const { toast } = await import("sonner");
const { registerDeckTransport } = await import("../src/lib/mix/deckTransport");
const recorder = await import("../src/lib/recorder");
const { OUTSIDE_MASTER_REFUSAL, playsOutsideMaster, recordingActive, startRecording } = recorder;
import type { DeckTransport } from "../src/lib/mix/deckTransport";
import type { MediaLike } from "../src/lib/media";

// An <audio> element that never went through the processing graph.
const element = { src: "", currentSrc: "", paused: false } as unknown as MediaLike;
const deck = (over: Partial<DeckTransport> = {}) => ({ trackId: 7, media: element, onEngine: false, ...over });

describe("a single deck playing outside the master bus", () => {
  test("only a loaded single deck without a playback graph counts", () => {
    expect(playsOutsideMaster(false, deck())).toBe(true);
    expect(playsOutsideMaster(true, deck())).toBe(false); // two decks always go through the bus
    expect(playsOutsideMaster(false, deck({ trackId: null }))).toBe(false); // no track: REC starts, the next track joins
    expect(playsOutsideMaster(false, deck({ media: null }))).toBe(false);
    expect(playsOutsideMaster(false, deck({ onEngine: true }))).toBe(false);
    expect(playsOutsideMaster(false, null)).toBe(false);
  });

  let unregister = () => {};
  afterEach(() => unregister());

  test("REC refuses with a toast instead of recording silence", async () => {
    unregister = registerDeckTransport("A", () => deck() as unknown as DeckTransport);
    const error = spyOn(toast, "error").mockImplementation(() => 0);
    await startRecording({ twoDeck: false });
    expect(error).toHaveBeenCalledWith(OUTSIDE_MASTER_REFUSAL);
    expect(recordingActive()).toBe(false);
    error.mockRestore();
  });
});
