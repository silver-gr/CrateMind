import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  createDeckTransportGetter, deckTransportOf, registerDeckTransport, setTransportOwner, transportOwnerOf, type DeckTransport, type TransportRefs,
} from "../src/lib/mix/deckTransport";
import type { MediaLike } from "../src/lib/media";
import type { StretchDeck } from "../src/lib/audio/stretchDeck";
import type { Track, TrackCue } from "../src/lib/types";
import { installLocation, setup, teardown } from "./stretchDeckFakes";

// player.tsx pulls in playbackAudio, whose worklet URL import only resolves under Vite.
mock.module("../src/lib/audio/peak-limiter.worklet.js?worker&url", () => ({ default: "/test/peak-limiter.worklet.js" }));
const { activateAudio, deckIsPlaying, emptySlots, ownsPlaybackKeys, releaseAudio, reportPlayback, routePlay } = await import("../src/lib/player");

const URL_7 = "http://app.test/api/tracks/7/audio";
const track = (id: number) => ({ id, title: `t${id}`, file_name: `t${id}.mp3` }) as unknown as Track;

type FakeMedia = { src: string; currentSrc: string; readyState: number; error: unknown; paused: boolean; currentTime: number; duration: number; playbackRate: number; pauses: number; pause(): void };
const fakeMedia = (over: Partial<FakeMedia> = {}): FakeMedia => ({
  src: URL_7, currentSrc: URL_7, readyState: 4, error: null, paused: true, currentTime: 12.5, duration: 200, playbackRate: 1.04, pauses: 0,
  pause() { this.pauses++; this.paused = true; },
  ...over,
});

function harness(over: { media?: FakeMedia; engine?: "same" | "other" | null; loadedTrackId?: number | null; loadedSourceUrl?: string | null; current?: Track | null } = {}) {
  const state = {
    media: over.media ?? fakeMedia(),
    engineMode: over.engine === undefined ? "same" as const : over.engine,
    otherEngine: fakeMedia(),
    loadedTrackId: over.loadedTrackId === undefined ? 7 : over.loadedTrackId,
    loadedSourceUrl: over.loadedSourceUrl === undefined ? URL_7 : over.loadedSourceUrl,
    current: over.current === undefined ? track(7) : over.current,
    calls: [] as (string | number)[][],
  };
  const cues = [{ id: 1, kind: "entry", position_ms: 4000 }] as unknown as TrackCue[];
  const refs: TransportRefs = {
    engine: () => (state.engineMode === "same" ? state.media : state.engineMode === "other" ? state.otherEngine : null) as unknown as StretchDeck | null,
    media: () => state.media as unknown as MediaLike,
    loadedTrackId: () => state.loadedTrackId,
    loadedSourceUrl: () => state.loadedSourceUrl,
    current: () => state.current,
    grid: () => ({ kind: "straight", anchor: 0.5, period: 60 / 140, downIndex: 0, estimated: false }) as never,
    cues: () => cues,
    bpm: () => 140,
    play: () => { state.calls.push(["play"]); },
    seek: s => { state.calls.push(["seek", s]); },
  };
  return { state, refs, get: createDeckTransportGetter(refs) };
}

describe("deck transport registry", () => {
  afterEach(() => { setTransportOwner("A", null); setTransportOwner("B", null); });

  test("a registered getter is read live; unregistering only removes its own getter", () => {
    expect(deckTransportOf("A")).toBeNull();
    let calls = 0;
    const first = () => { calls++; return { trackId: 1 } as DeckTransport; };
    const off = registerDeckTransport("A", first);
    expect(deckTransportOf("A")?.trackId).toBe(1);
    expect(deckTransportOf("A")?.trackId).toBe(1);
    expect(calls).toBe(2);
    expect(deckTransportOf("B")).toBeNull();
    const offSecond = registerDeckTransport("A", () => ({ trackId: 2 }) as DeckTransport);
    off(); // stale cleanup (StrictMode remount order) leaves the newer registration alone
    expect(deckTransportOf("A")?.trackId).toBe(2);
    offSecond();
    expect(deckTransportOf("A")).toBeNull();
  });

  test("owners are per deck and clear with null", () => {
    expect(transportOwnerOf("A")).toBeNull();
    setTransportOwner("B", "mix");
    expect(transportOwnerOf("B")).toBe("mix");
    expect(transportOwnerOf("A")).toBeNull();
    setTransportOwner("B", null);
    expect(transportOwnerOf("B")).toBeNull();
  });
});

describe("createDeckTransportGetter", () => {
  test("a decoded engine deck holding the current track is ready and reports its transport", () => {
    const { get, state } = harness();
    const t = get();
    expect(t.trackId).toBe(7);
    expect(t.onEngine).toBe(true);
    expect(t.ready).toBe(true);
    expect(t.playing).toBe(false);
    expect(t.rate).toBe(1.04);
    expect(t.duration).toBe(200);
    expect(t.position()).toBe(12.5);
    state.media.currentTime = 20;
    expect(t.position()).toBe(20); // live, not a snapshot
    expect(t.bpm).toBe(140);
    expect(t.cues).toHaveLength(1);
    expect(t.grid).not.toBeNull();
    expect(t.engine).toBe(state.media as never);
    expect(t.media).toBe(state.media as never);
    state.media.paused = false;
    expect(get().playing).toBe(true);
  });

  test("not ready while the loaded track id differs from the slot's track", () => {
    const { get, state } = harness({ loadedTrackId: 6 });
    expect(get().ready).toBe(false);
    state.loadedTrackId = null;
    expect(get().ready).toBe(false);
    state.loadedTrackId = 7;
    expect(get().ready).toBe(true);
  });

  test("an engine deck needs readyState 4 (decoded)", () => {
    const { get, state } = harness({ media: fakeMedia({ readyState: 1 }) });
    expect(get().ready).toBe(false);
    state.media.readyState = 3;
    expect(get().ready).toBe(false);
    state.media.readyState = 4;
    expect(get().ready).toBe(true);
  });

  test("after an element fallback onEngine is false, ready needs only metadata and the rate is 1", () => {
    const { get, state } = harness({ engine: "other", media: fakeMedia({ readyState: 1, playbackRate: 1 }) });
    const t = get();
    expect(t.onEngine).toBe(false);
    expect(t.ready).toBe(true);
    expect(t.rate).toBe(1);
    state.media.readyState = 0;
    expect(get().ready).toBe(false);
  });

  test("an engine that exists but is not the active media does not count as onEngine", () => {
    const { get } = harness({ engine: "other" });
    expect(get().onEngine).toBe(false);
    expect(harness({ engine: null }).get().onEngine).toBe(false);
  });

  test("a same-track reload (new source URL) is not ready until src and currentSrc match again", () => {
    const { get, state } = harness();
    const reload = `${URL_7}?r=2`;
    state.loadedSourceUrl = reload;
    expect(get().ready).toBe(false);
    state.media.src = reload; // currentSrc still the old load
    expect(get().ready).toBe(false);
    state.media.currentSrc = reload;
    expect(get().ready).toBe(true);
  });

  test("a matching src with a stale currentSrc is not ready", () => {
    expect(harness({ media: fakeMedia({ currentSrc: "http://app.test/api/tracks/6/audio" }) }).get().ready).toBe(false);
  });

  test("an errored, empty or source-less deck is not ready", () => {
    expect(harness({ media: fakeMedia({ error: { code: 3 } }) }).get().ready).toBe(false);
    expect(harness({ current: null }).get().ready).toBe(false);
    expect(harness({ current: null }).get().trackId).toBeNull();
    expect(harness({ loadedSourceUrl: null }).get().ready).toBe(false);
  });

  test("play, pause and seekTo go through the deck's own operations", () => {
    const { get, state } = harness({ media: fakeMedia({ paused: false }) });
    const t = get();
    t.play();
    t.seekTo(33);
    t.pause();
    expect(state.calls).toEqual([["play"], ["seek", 33]]);
    expect(state.media.pauses).toBe(1);
  });
});

describe("armed = playing (Decision 6b)", () => {
  beforeAll(installLocation);
  afterEach(teardown);

  test("after playAt the play event reports deck B as playing and makes it the key owner before T0", async () => {
    const { deck, ctx, load } = setup();
    await load("/api/tracks/7/audio");
    // MiniPlayer's `play` handler, reduced to what it does with the registry.
    deck.addEventListener("play", () => {
      reportPlayback(deck, { trackId: 7, playing: true, status: "", primary: false, deck: "B" });
      activateAudio(deck);
    });
    try {
      expect(deckIsPlaying("B")).toBe(false);
      expect(deck.playAt(12, 30, 1)).toBe(12);
      expect(ctx.currentTime).toBeLessThan(12);
      expect(deckIsPlaying("B")).toBe(true);
      expect(ownsPlaybackKeys(deck, false)).toBe(true);
      // Routing never loads onto an armed deck: with A playing too, both are busy.
      const slots = { ...emptySlots(), A: { track: track(1), token: 1, autoPlay: true }, B: { track: track(7), token: 1, autoPlay: false } };
      expect(routePlay(slots, d => d === "A" || deckIsPlaying(d), "A", true)).toBeNull();
    } finally {
      releaseAudio(deck);
    }
  });
});

describe("MiniPlayer integration (source contract)", () => {
  const mini = readFileSync(new URL("../src/components/MiniPlayer.tsx", import.meta.url), "utf8");
  const between = (start: string, end: string) => {
    const i = mini.indexOf(start);
    const j = mini.indexOf(end, i);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(j).toBeGreaterThan(i);
    return mini.slice(i, j);
  };

  test("registers the deck transport once, keyed on the deck", () => {
    expect(mini.match(/registerDeckTransport\(deck/g)).toHaveLength(1);
    expect(mini).toContain("createDeckTransportGetter({");
    expect(mini).toMatch(/import \{[^}]*registerDeckTransport[^}]*\} from "\.\.\/lib\/mix\/deckTransport";/);
  });

  test("the command handler ignores everything but notes and cue releases while a transition owns the deck", () => {
    const handler = between("deckCommandRef.current = ({ cmd, value }) => {", "if (cmd === \"note\")");
    expect(handler).toContain('if (transportOwnerOf(deck) && cmd !== "note" && cmd !== "cue-release") return;');
  });

  test("the keyboard handler guards the pad, Space and arrow branches", () => {
    const onKey = between("function onKey(e: KeyboardEvent) {", "window.addEventListener(\"keydown\", onKey, true);");
    expect(onKey.match(/if \(transportOwnerOf\(deck\)\) return;/g)?.length).toBe(4);
    const pad = onKey.slice(onKey.indexOf("if (padIndex !== null"), onKey.indexOf("const kind ="));
    expect(pad).toContain("if (transportOwnerOf(deck)) return;");
    const space = onKey.slice(onKey.indexOf('e.code === "Space") {'), onKey.indexOf('e.key === "ArrowRight"'));
    expect(space).toContain("if (transportOwnerOf(deck)) return;");
  });

  test("the load effect keeps its dependencies", () => {
    expect(mini).toContain("}, [current?.id, token, autoPlay]);");
  });
});
