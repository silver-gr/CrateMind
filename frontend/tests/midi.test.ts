import { describe, expect, test } from "bun:test";
import { JOG_TICKS_PER_STEP, decodeMidi, createMidiState } from "../src/lib/midi";

const k = (key: string, code: string, shiftKey = false) => ({ kind: "key", key, code, shiftKey });

describe("decodeMidi", () => {
  test("play, pads, browse", () => {
    const s = createMidiState();
    expect(decodeMidi([0x90, 0, 127], s)).toEqual([k(" ", "Space")]);
    expect(decodeMidi([0x94, 0x16, 127], s)).toEqual([k("3", "Digit3")]);
    expect(decodeMidi([0x94, 0x1e, 127], s)).toEqual([k("3", "Digit3", true)]);
    expect(decodeMidi([0x95, 0x14, 127], s)).toEqual([k("a", "KeyA")]);
    expect(decodeMidi([0xbf, 0, 1], s)).toEqual([k("j", "KeyJ")]);
    expect(decodeMidi([0xbf, 0, 0x7f], s)).toEqual([k("k", "KeyK")]);
  });

  test("jog accumulates, resets on direction change, honours shift", () => {
    const s = createMidiState();
    for (let i = 0; i < JOG_TICKS_PER_STEP - 1; i++) expect(decodeMidi([0xb0, 6, 1], s)).toEqual([]);
    expect(decodeMidi([0xb0, 6, 1], s)).toEqual([k("ArrowRight", "ArrowRight")]);
    for (let i = 0; i < JOG_TICKS_PER_STEP - 1; i++) decodeMidi([0xb0, 6, 1], s);
    expect(decodeMidi([0xb0, 6, 0x7f], s)).toEqual([]); // direction change resets
    decodeMidi([0x90, 0x20, 127], s);
    for (let i = 0; i < JOG_TICKS_PER_STEP - 2; i++) decodeMidi([0xb0, 6, 0x7f], s);
    expect(decodeMidi([0xb0, 6, 0x7f], s)).toEqual([k("ArrowLeft", "ArrowLeft", true)]);
  });

  test("load button, release and unmapped controls", () => {
    const s = createMidiState();
    expect(decodeMidi([0x9f, 0x02, 127], s)).toEqual([{ kind: "action", type: "add-to-set" }]);
    expect(decodeMidi([0x90, 0, 0], s)).toEqual([]);
    expect(decodeMidi([0xbf, 0x08, 64], s)).toEqual([]);
  });
});
