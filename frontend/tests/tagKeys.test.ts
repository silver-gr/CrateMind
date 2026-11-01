import { describe, expect, test } from "bun:test";
import { STATUS_PAD_KEYS, isCueJumpKey, statusBankAction, tagBankAction, tagKeyAction, writeTagAction, type TagWriteIo } from "../src/lib/tagKeys";

describe("tagKeyAction (the /tag key table)", () => {
  test("digits are energy, Shift + digit is darkness, 0 is 10", () => {
    expect(tagKeyAction("3", false)).toEqual({ patch: { energy: 3 }, label: "ενέργεια 3", optimistic: false });
    expect(tagKeyAction("3", true)).toEqual({ patch: { darkness: 3 }, label: "σκοτεινότητα 3", optimistic: false });
    expect(tagKeyAction("0", false)?.patch).toEqual({ energy: 10 });
    expect(tagKeyAction("0", true)?.patch).toEqual({ darkness: 10 });
  });

  test("letters map to the same patches and labels /tag used, with optimistic merging only for roles and statuses", () => {
    const table: Record<string, [object, string, boolean]> = {
      m: [{ melody: 8 }, "μελωδικό", false],
      b: [{ set_role: "bridge" }, "ρόλος γέφυρα", true], p: [{ set_role: "peak" }, "ρόλος κορύφωση", true], r: [{ set_role: "reset" }, "ρόλος reset", true],
      w: [{ personal_status: "weapon" }, "ΟΠΛΟ", true], a: [{ personal_status: "approved" }, "εγκεκριμένο", true], x: [{ personal_status: "avoid" }, "απόφυγε", true],
    };
    for (const [key, [patch, label, optimistic]] of Object.entries(table)) {
      expect(tagKeyAction(key, false)).toEqual({ patch, label, optimistic });
      expect(tagKeyAction(key.toUpperCase(), true)).toEqual({ patch, label, optimistic }); // the old switch lower-cased the key
    }
    for (const key of ["j", "k", "z", "Enter", " ", "ArrowLeft"]) expect(tagKeyAction(key, false)).toBeNull();
  });

  test("the cue-jump guard: 1-8 without Shift while a deck owns playback keys", () => {
    expect(isCueJumpKey("1", false, true)).toBe(true);
    expect(isCueJumpKey("8", false, true)).toBe(true);
    expect(isCueJumpKey("9", false, true)).toBe(false);
    expect(isCueJumpKey("0", false, true)).toBe(false);
    expect(isCueJumpKey("1", true, true)).toBe(false);
    expect(isCueJumpKey("1", false, false)).toBe(false);
    expect(isCueJumpKey("a", false, true)).toBe(false);
  });
});

describe("bank pads", () => {
  test("tag bank: pads 0-7 energy 1-8, 8-15 darkness 1-8, nothing else", () => {
    for (let pad = 0; pad < 8; pad++) {
      expect(tagBankAction(pad)?.patch).toEqual({ energy: pad + 1 });
      expect(tagBankAction(pad + 8)?.patch).toEqual({ darkness: pad + 1 });
    }
    expect([tagBankAction(-1), tagBankAction(16), tagBankAction(1.5)]).toEqual([null, null, null]);
  });

  test("status bank: pads 0-6 are a w x b p r m, the same as the /tag keys", () => {
    expect(STATUS_PAD_KEYS).toEqual(["a", "w", "x", "b", "p", "r", "m"]);
    STATUS_PAD_KEYS.forEach((key, pad) => expect(statusBankAction(pad)).toEqual(tagKeyAction(key, false)));
    expect([statusBankAction(7), statusBankAction(-1)]).toEqual([null, null]);
  });
});

describe("writeTagAction", () => {
  function io(over: Partial<TagWriteIo> = {}) {
    const log: unknown[][] = [];
    const out: TagWriteIo = {
      track: () => ({ id: 7, title: "Song" }),
      update: async (id, patch) => { log.push(["update", id, patch]); },
      toast: { success: m => log.push(["ok", m]), error: m => log.push(["err", m]) },
      emit: id => log.push(["emit", id]),
      ...over,
    };
    return { out, log };
  }

  test("writes the energy to the track held at the press, confirms with a toast and announces the profile update", async () => {
    const { out, log } = io();
    expect(await writeTagAction(tagBankAction(4), out)).toBe(true);
    expect(log).toEqual([["update", 7, { energy: 5 }], ["ok", "Song: ενέργεια 5"], ["emit", 7]]);
  });

  test("the track is snapshotted before the write: a deck reloaded mid-request still reports the original id", async () => {
    let current = { id: 7, title: "Song" };
    const { out, log } = io({ track: () => current, update: async id => { current = { id: 8, title: "Other" }; log.push(["update", id]); } });
    await writeTagAction(statusBankAction(1), out);
    expect(log).toEqual([["update", 7], ["ok", "Song: ΟΠΛΟ"], ["emit", 7]]);
  });

  test("an empty deck, a missing action or a failed write does nothing / reports the error without announcing", async () => {
    const empty = io({ track: () => null });
    expect(await writeTagAction(tagBankAction(0), empty.out)).toBe(false);
    expect(empty.log).toEqual([]);
    const none = io();
    expect(await writeTagAction(null, none.out)).toBe(false);
    expect(none.log).toEqual([]);
    const failing = io({ update: async () => { throw new Error("offline"); } });
    expect(await writeTagAction(tagBankAction(0), failing.out)).toBe(false);
    expect(failing.log).toEqual([["err", "offline"]]);
  });
});
