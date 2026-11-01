import { afterEach, describe, expect, test } from "bun:test";
import { browseAddToSet, cycleFocus, focusBrowseList, getBrowseSelected, getFocusedBrowseId, moveBrowse, registerBrowseList, resetBrowseForTests, syncBrowseCursor, type BrowseListSpec } from "../src/lib/browseTarget";
import { performMidiAction, type MidiActionPlayer } from "../src/lib/midiActions";
import type { Track } from "../src/lib/types";

const tracks = (...ids: number[]) => ids.map(id => ({ id }) as Track);
function list(id: string, rows: Track[], extra: Partial<BrowseListSpec> = {}) {
  const moved: number[] = [];
  let current = rows;
  const spec: BrowseListSpec = { rows: () => current, onCursor: t => { moved.push(t.id); }, ...extra };
  const off = registerBrowseList(id, () => spec);
  return { moved, off, setRows: (r: Track[]) => { current = r; } };
}
afterEach(resetBrowseForTests);

describe("browseTarget store", () => {
  test("first registered list is focused; unregister hands focus on", () => {
    const a = list("a", tracks(1, 2));
    list("b", tracks(3));
    expect(getFocusedBrowseId()).toBe("a");
    a.off();
    expect(getFocusedBrowseId()).toBe("b");
  });

  test("moves only the focused list, clamped, first move lands on row 0", () => {
    const a = list("a", tracks(1, 2, 3));
    const b = list("b", tracks(7, 8));
    moveBrowse(-1);
    expect(getBrowseSelected()?.id).toBe(1);
    moveBrowse(10);
    expect(getBrowseSelected()?.id).toBe(3);
    expect(a.moved).toEqual([1, 3]);
    expect(b.moved).toEqual([]);
  });

  test("focus changes by explicit focus (pointerdown/wheel), not by moving", () => {
    list("a", tracks(1, 2));
    const b = list("b", tracks(7, 8));
    focusBrowseList("b");
    moveBrowse(1);
    expect(b.moved).toEqual([7]);
    focusBrowseList("missing");
    expect(getFocusedBrowseId()).toBe("b");
  });

  test("cycleFocus rotates and seeds the new list's first row", () => {
    const a = list("a", tracks(1, 2));
    const b = list("b", tracks(7, 8));
    cycleFocus();
    expect(getFocusedBrowseId()).toBe("b");
    expect(b.moved).toEqual([7]);
    cycleFocus();
    expect(getFocusedBrowseId()).toBe("a");
    expect(a.moved).toEqual([1]);
    cycleFocus();
    expect(b.moved).toEqual([7]);
  });

  test("cursor follows the track when rows are re-sorted", () => {
    const a = list("a", tracks(1, 2, 3));
    moveBrowse(1);
    moveBrowse(1);
    a.setRows(tracks(3, 2, 1));
    expect(getBrowseSelected()?.id).toBe(2);
    moveBrowse(1);
    expect(getBrowseSelected()?.id).toBe(1);
  });

  test("syncBrowseCursor adopts a page-driven selection without echoing onCursor", () => {
    const a = list("a", tracks(1, 2, 3));
    syncBrowseCursor("a", 2);
    expect(a.moved).toEqual([]);
    moveBrowse(1);
    expect(getBrowseSelected()?.id).toBe(3);
  });

  test("addToSet runs the focused list's callback on its cursor row", () => {
    const added: number[] = [];
    list("a", tracks(1, 2), { addToSet: t => { added.push(t.id); } });
    expect(browseAddToSet()).toBe(false);
    moveBrowse(2);
    expect(browseAddToSet()).toBe(true);
    expect(added).toEqual([1]);
    list("b", tracks(9));
    focusBrowseList("b");
    moveBrowse(1);
    expect(browseAddToSet()).toBe(false);
  });
});

describe("performMidiAction", () => {
  const fakePlayer = (playing: Partial<Record<"A" | "B", boolean>> = {}) => {
    const calls: unknown[][] = [];
    const player: MidiActionPlayer = {
      playRouted: t => { calls.push(["play", t.id]); },
      load: (deck, t, opts) => { calls.push(["load", deck, t.id, opts]); return !playing[deck]; },
      eject: deck => { calls.push(["eject", deck]); },
      deckIsPlaying: deck => !!playing[deck],
    };
    return { player, calls };
  };

  test("a whole batch (turns + Load + push) hits the right row before any re-render", () => {
    list("a", tracks(10, 20, 30, 40));
    const { player, calls } = fakePlayer();
    const notes: string[] = [];
    const run = (a: Parameters<typeof performMidiAction>[0]) => performMidiAction(a, player, m => { notes.push(m); });
    run({ type: "browse", delta: 1 });
    run({ type: "browse", delta: 2 });
    run({ type: "load-deck", deck: "B" });
    run({ type: "play" });
    expect(calls).toEqual([["load", "B", 30, { play: false, ifIdle: true }], ["play", 30]]);
    expect(notes).toEqual([]);
  });

  test("load on a playing deck is refused with the toast; eject is refused while playing", () => {
    list("a", tracks(1));
    const { player, calls } = fakePlayer({ A: true });
    const notes: string[] = [];
    const run = (a: Parameters<typeof performMidiAction>[0]) => performMidiAction(a, player, m => { notes.push(m); });
    run({ type: "browse", delta: 1 });
    run({ type: "load-deck", deck: "A" });
    run({ type: "eject", deck: "A" });
    run({ type: "eject", deck: "B" });
    expect(notes).toEqual(["Το Deck A παίζει — δεν φορτώθηκε", "Το Deck A παίζει — δεν έγινε εξαγωγή"]);
    expect(calls.filter(c => c[0] === "eject")).toEqual([["eject", "B"]]);
  });

  test("with no selection play/load do nothing; add-to-set without a callback notifies", () => {
    list("a", tracks(1));
    const { player, calls } = fakePlayer();
    const notes: string[] = [];
    performMidiAction({ type: "play" }, player, m => { notes.push(m); });
    performMidiAction({ type: "load-deck", deck: "A" }, player, m => { notes.push(m); });
    expect(calls).toEqual([]);
    moveBrowse(1);
    performMidiAction({ type: "add-to-set" }, player, m => { notes.push(m); });
    expect(notes).toEqual(["Εδώ δεν γίνεται προσθήκη στο set"]);
  });

  test("cycle-focus switches lists", () => {
    list("a", tracks(1));
    list("b", tracks(2));
    performMidiAction({ type: "cycle-focus" }, fakePlayer().player);
    expect(getFocusedBrowseId()).toBe("b");
  });
});
