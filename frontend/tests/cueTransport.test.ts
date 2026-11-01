import { describe, expect, test } from "bun:test";
import { CUE_TOLERANCE_S, createCueMachine } from "../src/lib/cueTransport";

// A deck whose pause rewrites its position like the engine's anchor does: seeking before pausing would be lost.
function fakeDeck(entry: number | null = null) {
  const log: string[] = [];
  const d = { pos: 0, playing: false, entry, id: "1:7:engine", jogCleared: 0 };
  const machine = createCueMachine({
    position: () => d.pos,
    playing: () => d.playing,
    play: () => { d.playing = true; log.push("play"); },
    pause: () => { d.playing = false; log.push("pause"); },
    seek: s => { d.pos = s; log.push(`seek:${s}`); },
    clearJog: () => { d.jogCleared++; log.push("jog"); },
    entryCue: () => d.entry,
    identity: () => d.id,
  });
  return { d, machine, log };
}

describe("cue state machine", () => {
  test("paused away from the cue sets it at the playhead", () => {
    const { d, machine } = fakeDeck();
    d.pos = 12.5;
    machine.press(false);
    expect(machine.mainCue()).toBe(12.5);
    expect(machine.hasCue()).toBe(true);
    expect(d.playing).toBe(false);
    expect(machine.previewing()).toBe(false);
  });

  test("the main cue defaults to the entry cue, else 0:00", () => {
    expect(fakeDeck().machine.mainCue()).toBe(0);
    expect(fakeDeck().machine.hasCue()).toBe(false);
    const { machine, d } = fakeDeck(3.2);
    expect(machine.mainCue()).toBe(3.2);
    expect(machine.hasCue()).toBe(true);
    d.pos = 9; machine.press(false);
    expect(machine.mainCue()).toBe(9); // a cue set on the deck overrides the entry cue
    machine.resetSession();
    expect(machine.mainCue()).toBe(3.2);
  });

  test("paused at the cue previews on press and returns paused on release", () => {
    const { d, machine, log } = fakeDeck(4);
    d.pos = 4 + CUE_TOLERANCE_S / 2;
    machine.press(false);
    expect(d.playing).toBe(true);
    expect(machine.previewing()).toBe(true);
    d.pos = 6;
    log.length = 0;
    machine.release();
    expect(d.playing).toBe(false);
    expect(d.pos).toBe(4);
    expect(log.filter(l => l !== "jog")).toEqual(["pause", "seek:4"]); // pause first, then seek
    expect(machine.previewing()).toBe(false);
    machine.release(); // a second release does nothing
    expect(d.pos).toBe(4);
  });

  test("the 20 ms tolerance: just outside it sets a new cue instead of previewing", () => {
    const { d, machine } = fakeDeck(4);
    d.pos = 4 + CUE_TOLERANCE_S + 0.005;
    machine.press(false);
    expect(machine.previewing()).toBe(false);
    expect(d.playing).toBe(false);
    expect(machine.mainCue()).toBeCloseTo(4.025);
  });

  test("playing: jump to the cue and pause", () => {
    const { d, machine, log } = fakeDeck(2);
    d.pos = 30; d.playing = true;
    log.length = 0;
    machine.press(false);
    expect(d.playing).toBe(false);
    expect(d.pos).toBe(2);
    expect(log.filter(l => l !== "jog")).toEqual(["pause", "seek:2"]);
    expect(machine.previewing()).toBe(false);
  });

  test("Shift + Cue goes to 0:00 and pauses, without touching the cue", () => {
    const { d, machine } = fakeDeck(5);
    d.pos = 40; d.playing = true;
    machine.press(true);
    expect(d.playing).toBe(false);
    expect(d.pos).toBe(0);
    expect(machine.mainCue()).toBe(5);
  });

  test("every press clears a pending jog first", () => {
    const { d, machine, log } = fakeDeck();
    machine.press(false);
    machine.press(true);
    d.pos = 9; d.playing = true;
    machine.press(false);
    expect(d.jogCleared).toBe(3);
    expect(log[0]).toBe("jog");
  });

  test("Play during a preview keeps it playing and the release then does nothing", () => {
    const { d, machine } = fakeDeck();
    machine.press(false); // at 0 = at the cue -> preview
    expect(machine.previewing()).toBe(true);
    d.pos = 3;
    expect(machine.latch()).toBe(true);
    expect(machine.previewing()).toBe(false);
    machine.release();
    expect(d.playing).toBe(true);
    expect(d.pos).toBe(3);
    expect(machine.latch()).toBe(false); // nothing to latch outside a preview
  });

  test("Shift pressed mid-hold: the 05 release still ends the preview (release is one command)", () => {
    const { d, machine } = fakeDeck();
    machine.press(false);
    d.pos = 2;
    machine.release(); // decoded from 80 05 as well as 80 01
    expect(d.playing).toBe(false);
    expect(d.pos).toBe(0);
  });

  test("a preview is cancelled back to the cue on disconnect", () => {
    const { d, machine } = fakeDeck(1);
    d.pos = 1; machine.press(false);
    d.pos = 5;
    machine.cancel("disconnect");
    expect(d.playing).toBe(false);
    expect(d.pos).toBe(1);
    machine.release();
    expect(d.pos).toBe(1);
  });

  test("replace and eject drop the preview without seeking the next load", () => {
    for (const reason of ["replace", "eject"] as const) {
      const { d, machine, log } = fakeDeck(1);
      d.pos = 1; machine.press(false);
      d.pos = 0; d.playing = false; // the new load starts from the top, paused
      log.length = 0;
      machine.cancel(reason);
      machine.release();
      expect(machine.previewing()).toBe(false);
      expect(log).toEqual([]);
      expect(d.pos).toBe(0);
    }
  });

  test("a release after the load changed under it does not seek the new load", () => {
    const { d, machine } = fakeDeck();
    machine.press(false);
    d.id = "2:8:engine"; // new token, no cancel delivered
    d.pos = 7; d.playing = false;
    machine.release();
    expect(d.pos).toBe(7);
    expect(machine.previewing()).toBe(false);
  });

  test("a stray press during a preview is ignored", () => {
    const { d, machine } = fakeDeck();
    machine.press(false);
    d.pos = 4;
    machine.press(false);
    expect(machine.previewing()).toBe(true);
    expect(d.pos).toBe(4);
  });
});
