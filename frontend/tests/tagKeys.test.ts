import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  STATUS_PAD_KEYS, cuePadKeysEnabled, digitFromEvent, isCueJumpKey, optionDigitAction, optionKeyName, queueShortcuts, statusBankAction,
  tagBankAction, tagKeyAction, undoPatch, writeLabel, writeTagAction, type TagWriteIo,
} from "../src/lib/tagKeys";

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
      l: [{ set_role: "closer" }, "ρόλος κλείσιμο", true],
      w: [{ personal_status: "weapon" }, "BANGER", true], a: [{ personal_status: "approved" }, "εγκεκριμένο", true], x: [{ personal_status: "avoid" }, "απόφυγε", true],
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
    expect(log).toEqual([["update", 7], ["ok", "Song: BANGER"], ["emit", 7]]);
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

  test("therapy: the «A» status pad on a DJ weapon (shown as approved) writes nothing, like the «A» key", async () => {
    const weapon = io({ status: async id => { weapon.log.push(["status", id]); return "weapon"; } });
    expect(await writeTagAction(statusBankAction(0, "therapy"), weapon.out, "therapy")).toBe(false);
    expect(weapon.log).toEqual([["status", 7]]);
    const dj = io({ status: async () => "weapon" });
    expect(await writeTagAction(statusBankAction(0, "dj"), dj.out, "dj")).toBe(true);
    expect(dj.log[0]).toEqual(["update", 7, { personal_status: "approved" }]);
    for (const current of ["approved", "testing", null]) {
      const other = io({ status: async () => current });
      expect(await writeTagAction(statusBankAction(0, "therapy"), other.out, "therapy")).toBe(true);
      expect(other.log[0]).toEqual(["update", 7, { personal_status: "approved" }]);
    }
    const unread = io({ status: async () => { throw new Error("offline"); } });
    expect(await writeTagAction(statusBankAction(0, "therapy"), unread.out, "therapy")).toBe(false);
    expect(unread.log).toEqual([["err", "offline"]]);
  });
});

describe("fast rating writes («6 → 8» and «Αναίρεση»)", () => {
  function io(values?: TagWriteIo extends { track: () => infer T } ? NonNullable<T>["values"] : never) {
    const log: unknown[][] = [];
    const undos: (() => void)[] = [];
    const out: TagWriteIo = {
      track: () => ({ id: 7, title: "Song", values }),
      update: async (id, patch) => { log.push(["update", id, patch]); },
      toast: {
        success: m => log.push(["ok", m]),
        error: m => log.push(["err", m]),
        undo: (m, onUndo) => { log.push(["undo-toast", m]); undos.push(onUndo); },
      },
      emit: (id, patch) => log.push(["emit", id, patch]),
    };
    return { out, log, undos };
  }

  test("a write over a value names both numbers and its undo writes the old value back", async () => {
    const { out, log, undos } = io({ energy: 6, darkness: 3 });
    expect(await writeTagAction(tagKeyAction("8", false), out)).toBe(true);
    expect(log).toEqual([["update", 7, { energy: 8 }], ["undo-toast", "Song: ενέργεια 6 → 8"], ["emit", 7, { energy: 8 }]]);
    undos[0]();
    await Bun.sleep(0);
    expect(log.slice(3)).toEqual([["update", 7, { energy: 6 }], ["ok", "Song: αναιρέθηκε"], ["emit", 7, { energy: 6 }]]);
  });

  test("a first write undoes to empty; a status undoes to «unknown», the column's empty value", async () => {
    expect(undoPatch({ energy: 8 }, { energy: null })).toEqual({ energy: null });
    expect(undoPatch({ darkness: 5 }, {})).toEqual({ darkness: null });
    expect(undoPatch({ personal_status: "approved" }, { personal_status: null })).toEqual({ personal_status: "unknown" });
    expect(undoPatch({ personal_status: "unknown" }, { personal_status: "weapon" })).toEqual({ personal_status: "weapon" });
    const { out, log } = io({ energy: null });
    await writeTagAction(tagKeyAction("0", false), out);
    expect(log[1]).toEqual(["undo-toast", "Song: ενέργεια 10"]);
  });

  test("the label names a replaced number only; the same value again writes without an undo", async () => {
    expect(writeLabel(tagKeyAction("4", true)!, { darkness: 9 })).toBe("σκοτεινότητα 9 → 4");
    expect(writeLabel(tagKeyAction("4", true)!, { darkness: null })).toBe("σκοτεινότητα 4");
    expect(writeLabel(tagKeyAction("4", true)!)).toBe("σκοτεινότητα 4");
    expect(writeLabel(tagKeyAction("a", false)!, { personal_status: "testing" })).toBe("εγκεκριμένο");
    expect(writeLabel(tagKeyAction("4", false, "therapy")!, { energy: 2 }, "therapy")).toBe("διέγερση 2 → 4");
    const { out, log } = io({ energy: 6 });
    await writeTagAction(tagKeyAction("6", false), out);
    expect(log[1]).toEqual(["ok", "Song: ενέργεια 6"]);
  });

  test("without shown values (the pad banks) nothing changes: a plain confirmation and no undo", async () => {
    const { out, log, undos } = io();
    await writeTagAction(tagBankAction(4), out);
    expect(log).toEqual([["update", 7, { energy: 5 }], ["ok", "Song: ενέργεια 5"], ["emit", 7, { energy: 5 }]]);
    expect(undos).toEqual([]);
  });
});

describe("/tag Option + digit", () => {
  const ev = (over: Partial<Parameters<typeof optionDigitAction>[0]>) =>
    ({ key: "¡", code: "Digit1", altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, ...over });

  test("Option + digit is energy 1–10 from the physical key (the Mac types «¡» for Option + 1)", () => {
    expect(optionDigitAction(ev({}))?.patch).toEqual({ energy: 1 });
    expect(optionDigitAction(ev({ key: "º", code: "Digit0" }))?.patch).toEqual({ energy: 10 });
    expect(optionDigitAction(ev({ key: "8", code: "Numpad8" }))?.label).toBe("ενέργεια 8");
  });

  test("Ctrl + Alt (AltGr), Cmd, Shift, no Alt or a letter write nothing", () => {
    for (const over of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: false }, { key: "å", code: "KeyA" }]) {
      expect(optionDigitAction(ev(over))).toBeNull();
    }
  });

  test("a plain digit still belongs to the cue pads while a deck owns the keys", () => {
    expect(isCueJumpKey("3", false, true)).toBe(true);
    const queue = readFileSync(new URL("../src/pages/TaggingQueue.tsx", import.meta.url), "utf8");
    // The Alt branch returns before the cue-jump guard, so a plain digit takes the same path as before.
    expect(queue.indexOf("optionDigitAction(e)")).toBeLessThan(queue.indexOf("isCueJumpKey(k, e.shiftKey, hasPlaybackKeyOwner())"));
  });
});

describe("therapy profile keys", () => {
  test("digits set arousal, Shift + digit sets valence, role and weapon keys are off", () => {
    expect(tagKeyAction("3", false, "therapy")).toEqual({ patch: { energy: 3 }, label: "διέγερση 3", optimistic: false });
    expect(tagKeyAction("3", true, "therapy")).toEqual({ patch: { valence: 3 }, label: "συναισθηματικό σθένος 3", optimistic: false });
    expect(tagKeyAction("0", false, "therapy")?.patch).toEqual({ energy: 10 });
    expect(tagKeyAction("0", true, "therapy")?.patch).toEqual({ valence: 10 });
    for (const key of ["b", "l", "p", "r", "w"]) expect(tagKeyAction(key, false, "therapy")).toBeNull();
    for (const key of ["a", "x", "m"]) expect(tagKeyAction(key, false, "therapy")).toEqual(tagKeyAction(key, false, "dj"));
  });

  test("pad banks follow the profile", () => {
    expect(tagBankAction(8, "therapy")?.patch).toEqual({ valence: 1 });
    expect(tagBankAction(0, "therapy")?.patch).toEqual({ energy: 1 });
    expect(statusBankAction(3, "therapy")).toBeNull();
    expect(statusBankAction(0, "therapy")).toEqual(tagKeyAction("a", false, "therapy"));
  });

  test("cue-jump digits are off in therapy", () => {
    expect(isCueJumpKey("3", false, true, "therapy")).toBe(false);
    expect(isCueJumpKey("3", false, true, "dj")).toBe(true);
    expect(cuePadKeysEnabled("therapy")).toBe(false);
    expect(cuePadKeysEnabled("dj")).toBe(true);
  });

  test("digitFromEvent reads the physical digit, so Shift + digit reaches the key table", () => {
    expect(digitFromEvent({ key: "#", code: "Digit3" })).toBe("3");
    expect(digitFromEvent({ key: "3", code: "Numpad3" })).toBe("3");
    expect(digitFromEvent({ key: "3" })).toBe("3");
    expect(digitFromEvent({ key: "γ", code: "KeyG" })).toBeNull();
  });
});

describe("queueShortcuts", () => {
  const DJ = [
    { section: "Ακρόαση", rows: [
      { keys: ["Space"], label: "αναπαραγωγή / παύση" },
      { keys: ["1–8"], label: "μετάβαση στα cue pads του επιλεγμένου track" },
    ] },
    { section: "Βαθμολογία", rows: [
      { keys: ["1–9", "0"], label: "ενέργεια 1–10 (1–8 μόνο χωρίς επιλεγμένο track)" },
      { keys: ["Option", "1–0"], label: "ενέργεια 1–10, και με επιλεγμένο track" },
      { keys: ["Shift", "1–0"], label: "σκοτεινότητα 1–10" },
      { keys: ["M"], label: "μελωδικό" },
    ] },
    { section: "Κατάσταση", rows: [
      { keys: ["W"], label: "banger" },
      { keys: ["A"], label: "εγκεκριμένο" },
      { keys: ["X"], label: "απόφυγε" },
    ] },
    { section: "Ρόλος", rows: [
      { keys: ["B"], label: "γέφυρα" },
      { keys: ["P"], label: "κορύφωση" },
      { keys: ["R"], label: "reset" },
      { keys: ["L"], label: "κλείσιμο" },
    ] },
    { section: "Πλοήγηση", rows: [
      { keys: ["J"], label: "επόμενο" },
      { keys: ["K"], label: "προηγούμενο" },
    ] },
  ];

  test("the DJ table, with Option + digit and «L»; «Alt» outside a Mac", () => {
    expect(queueShortcuts("dj", "Option")).toEqual(DJ);
    expect(optionKeyName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("Option");
    expect(optionKeyName("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("Alt");
    expect(queueShortcuts("dj", "Alt").flatMap(s => s.rows).some(r => r.keys[0] === "Alt")).toBe(true);
  });

  test("the therapy table has no roles, no cue pads, arousal/valence ratings and only A and X statuses", () => {
    const table = queueShortcuts("therapy");
    expect(table.map(s => s.section)).not.toContain("Ρόλος");
    expect(table.flatMap(s => s.rows).some(r => r.label.includes("cue pads"))).toBe(false);
    const ratings = table.find(s => s.section === "Βαθμολογία")!.rows.map(r => r.label);
    expect(ratings).toContain("διέγερση 1–10");
    expect(ratings).toContain("συναισθηματικό σθένος 1–10");
    expect(table.find(s => s.section === "Κατάσταση")!.rows.map(r => r.keys)).toEqual([["A"], ["X"]]);
  });
});

describe("source contracts", () => {
  const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

  test("MiniPlayer gates cue-pad keys on the profile with one condition", () => {
    const mini = source("components/MiniPlayer.tsx");
    expect(mini).toContain("if (padIndex !== null && !e.shiftKey && cuePadKeysEnabled()) {");
    expect(mini).toMatch(/import \{[^}]*cuePadKeysEnabled[^}]*\} from "\.\.\/lib\/tagKeys";/);
  });

  test("the shortcuts dialog builds its tagging rows from queueShortcuts", () => {
    expect(source("components/ShortcutsDialog.tsx")).toContain("queueShortcuts(");
  });
});
