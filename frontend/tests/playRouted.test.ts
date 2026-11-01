import { describe, expect, test } from "bun:test";
import { activateAudio, emptySlots, getLastActiveDeck, releaseAudio, reportPlayback, routePlay, type DeckId } from "../src/lib/player";
import type { MediaLike } from "../src/lib/media";
import type { Track } from "../src/lib/types";

const track = (id: number) => ({ id }) as Track;
const slots = (a: boolean, b: boolean) => {
  const s = emptySlots();
  if (a) s.A.track = track(1);
  if (b) s.B.track = track(2);
  return s;
};
const playing = (...d: DeckId[]) => (deck: DeckId) => d.includes(deck);

describe("routePlay", () => {
  test("single-deck mode always plays on A", () => {
    expect(routePlay(slots(true, true), playing("A"), "B", false)).toEqual({ deck: "A", play: true });
  });
  test("two-deck: empty deck first, A before B", () => {
    expect(routePlay(slots(false, false), playing(), null, true)).toEqual({ deck: "A", play: true });
    expect(routePlay(slots(true, false), playing(), "A", true)).toEqual({ deck: "B", play: true });
    expect(routePlay(slots(false, true), playing("B"), "B", true)).toEqual({ deck: "A", play: false });
  });
  test("two-deck, both loaded: a non-playing deck; tie avoids the last active deck", () => {
    expect(routePlay(slots(true, true), playing("A"), "A", true)).toEqual({ deck: "B", play: false });
    expect(routePlay(slots(true, true), playing("B"), "B", true)).toEqual({ deck: "A", play: false });
    expect(routePlay(slots(true, true), playing(), "A", true)).toEqual({ deck: "B", play: true });
    expect(routePlay(slots(true, true), playing(), "B", true)).toEqual({ deck: "A", play: true });
    expect(routePlay(slots(true, true), playing(), null, true)).toEqual({ deck: "A", play: true });
  });
  test("A playing, B paused but last active -> B (cued, since A is playing)", () => {
    expect(routePlay(slots(true, true), playing("A"), "B", true)).toEqual({ deck: "B", play: false });
  });
  test("both playing -> refuse", () => {
    expect(routePlay(slots(true, true), playing("A", "B"), "A", true)).toBeNull();
  });
});

describe("lastActiveDeck", () => {
  const fakeAudio = () => Object.assign(new EventTarget(), { pause() {} }) as unknown as MediaLike;
  test("recorded from the reported deck and survives releaseAudio", () => {
    const b = fakeAudio();
    reportPlayback(b, { trackId: 2, playing: true, status: "", primary: false, deck: "B" });
    activateAudio(b);
    expect(getLastActiveDeck()).toBe("B");
    releaseAudio(b);
    expect(getLastActiveDeck()).toBe("B");
    const a = fakeAudio();
    reportPlayback(a, { trackId: 1, playing: true, status: "", primary: true, deck: "A" });
    activateAudio(a);
    expect(getLastActiveDeck()).toBe("A");
    releaseAudio(a);
    expect(getLastActiveDeck()).toBe("A");
  });
});
