import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { effectiveBpm } from "../src/lib/tempo";
import type { Track } from "../src/lib/types";

// player.tsx pulls in playbackAudio, whose worklet URL import only resolves under Vite.
mock.module("../src/lib/audio/peak-limiter.worklet.js?worker&url", () => ({ default: "/test/peak-limiter.worklet.js" }));
const {
  activateAudio, clearSlots, ejectFromSlots, emptySlots, getPlaybackSnapshot, loadIntoSlots, patchSlotsTrack, releaseAudio, reportPlayback,
} = await import("../src/lib/player");

const t = (id: number) => ({ id }) as Track;

describe("deck slots", () => {
  test("load bumps the token per deck and eject empties only that slot", () => {
    let s = emptySlots();
    s = loadIntoSlots(s, "A", t(1), { play: false }, false)!;
    s = loadIntoSlots(s, "B", t(2), {}, false)!;
    s = loadIntoSlots(s, "A", t(1), { play: true }, false)!;
    expect(s.A).toEqual({ track: t(1), token: 2, autoPlay: true });
    expect(s.B).toEqual({ track: t(2), token: 1, autoPlay: true });
    s = ejectFromSlots(s, "B");
    expect(s.B.track).toBeNull();
    expect(s.A.track).toEqual(t(1));
  });
  test("clear empties both slots", () => {
    let s = loadIntoSlots(emptySlots(), "A", t(1), {}, false)!;
    s = loadIntoSlots(s, "B", t(2), {}, false)!;
    const cleared = clearSlots(s);
    expect(cleared.A.track).toBeNull();
    expect(cleared.B.track).toBeNull();
  });
  test("ifIdle onto a playing deck refuses and changes nothing; a plain load still replaces", () => {
    const s = loadIntoSlots(emptySlots(), "A", t(1), {}, false)!;
    const before = structuredClone(s);
    expect(loadIntoSlots(s, "A", t(9), { play: false, ifIdle: true }, true)).toBeNull();
    expect(s).toEqual(before);
    expect(loadIntoSlots(s, "A", t(9), { play: false, ifIdle: true }, false)!.A.track).toEqual(t(9));
    expect(loadIntoSlots(s, "A", t(9), { play: true }, true)!.A).toEqual({ track: t(9), token: 2, autoPlay: true });
  });
});

describe("patching a loaded track", () => {
  const manual = { bpm_consensus: 72.5, bpm_consensus_sources: "manual:octave" };
  test("patches only the matching slot and keeps its token, so the deck does not reload", () => {
    let s = loadIntoSlots(emptySlots(), "A", { ...t(1), bpm: 145 }, {}, false)!;
    s = loadIntoSlots(s, "B", t(2), { play: false }, false)!;
    const next = patchSlotsTrack(s, 1, track => ({ ...track, ...manual }));
    expect(next.A.token).toBe(s.A.token);
    expect(next.A.autoPlay).toBe(s.A.autoPlay);
    expect(next.B).toBe(s.B);
    expect(next.A.track).toEqual({ ...t(1), bpm: 145, ...manual });
    // effectiveBpm of the slot's track feeds Sync and new loops.
    expect(effectiveBpm(next.A.track)).toBe(72.5);
  });
  test("no matching slot returns the same slots object", () => {
    const s = loadIntoSlots(emptySlots(), "A", t(1), {}, false)!;
    expect(patchSlotsTrack(s, 9, track => ({ ...track, ...manual }))).toBe(s);
  });
  test("the provider follows BPM_UPDATED and ANALYSIS_FINISHED through patchSlotsTrack", () => {
    const player = readFileSync(new URL("../src/lib/player.tsx", import.meta.url), "utf8");
    expect(player).toContain("addEventListener(BPM_UPDATED");
    expect(player).toContain("addEventListener(ANALYSIS_FINISHED");
    expect(player.match(/patchSlotsTrack\(slotsRef\.current/g)?.length).toBe(2);
  });
});

describe("publishPlayback with two decks", () => {
  test("A plays, B starts, B pauses: A still counts as playing", () => {
    const a = { pause: () => {} } as HTMLAudioElement;
    const b = { pause: () => {} } as HTMLAudioElement;
    reportPlayback(a, { trackId: 1, playing: true, primary: true, status: "", deck: "A" });
    activateAudio(a);
    expect(getPlaybackSnapshot().playingTrackId).toBe(1);
    reportPlayback(b, { trackId: 2, playing: true, primary: false, status: "", deck: "B" });
    activateAudio(b);
    expect(getPlaybackSnapshot().playingTrackId).toBe(2);
    reportPlayback(b, { trackId: 2, playing: false, primary: false, status: "", deck: "B" });
    expect(getPlaybackSnapshot().playingTrackId).toBe(1);
    releaseAudio(b);
    releaseAudio(a);
    expect(getPlaybackSnapshot().playingTrackId).toBeNull();
  });
});
