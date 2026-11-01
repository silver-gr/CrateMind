import { describe, expect, test } from "bun:test";
import { padDelete, padPress, type PadIo } from "../src/lib/padActions";
import type { TrackCue } from "../src/lib/types";

const cue = (id: number, position_ms: number, kind: TrackCue["kind"] = "cue", label: string | null = null): TrackCue =>
  ({ id, track_id: 1, position_ms, kind, label, created_at: "", updated_at: "" });

function world(initial: { cues: TrackCue[]; slots?: (number | null)[] }) {
  const w = {
    track: 1, cues: [...initial.cues], slots: initial.slots ?? Array(8).fill(null), open: false, pending: false,
    nextId: 100, seeks: [] as number[], toasts: [] as string[], errors: [] as string[], undo: null as null | (() => void),
    assigns: [] as [number, number | null][], created: [] as unknown[], captureResult: "ok" as "ok" | "refused",
  };
  const io: PadIo = {
    trackId: () => w.track, cues: () => w.cues, slots: () => w.slots, surfaceOpen: () => w.open,
    seek: ms => { w.seeks.push(ms); },
    capturePending: () => w.pending,
    capture: async () => {
      if (w.captureResult === "refused") return undefined;
      const c = cue(w.nextId++, 5000);
      w.cues.push(c);
      return c;
    },
    assign: (slot, id) => { w.assigns.push([slot, id]); w.slots = w.slots.map((s, i) => i === slot ? id : s === id ? null : s); },
    deleteCue: async id => { w.cues = w.cues.filter(c => c.id !== id); w.slots = w.slots.map(s => s === id ? null : s); },
    createCue: async input => { const c = cue(w.nextId++, input.position_ms, input.kind, input.label); w.created.push(input); w.cues.push(c); return c; },
    toast: { info: m => { w.toasts.push(m); }, error: m => { w.errors.push(m); }, undo: (_m, fn) => { w.undo = fn; } },
  };
  return { w, io };
}

describe("padPress", () => {
  test("a filled pad jumps to its cue", async () => {
    const { w, io } = world({ cues: [cue(10, 12_000)], slots: [10, ...Array(7).fill(null)] });
    await padPress(io, 0);
    expect(w.seeks).toEqual([12_000]);
    expect(w.assigns).toEqual([]);
  });

  test("an empty pad saves a cue and assigns it to that pad", async () => {
    const { w, io } = world({ cues: [] });
    await padPress(io, 3);
    expect(w.assigns).toEqual([[3, 100]]);
    expect(w.slots[3]).toBe(100);
  });

  test("an empty pad does nothing while a dialog is open", async () => {
    const { w, io } = world({ cues: [] });
    w.open = true;
    await padPress(io, 3);
    expect(w.cues).toEqual([]);
    expect(w.assigns).toEqual([]);
  });

  test("a jump still works with a dialog open (only create/delete are guarded)", async () => {
    const { w, io } = world({ cues: [cue(10, 1000)], slots: [10, ...Array(7).fill(null)] });
    w.open = true;
    await padPress(io, 0);
    expect(w.seeks).toEqual([1000]);
  });

  test("a second capture while one is pending shows a toast instead of being dropped", async () => {
    const { w, io } = world({ cues: [] });
    w.pending = true;
    await padPress(io, 1);
    expect(w.toasts.length).toBe(1);
    expect(w.cues).toEqual([]);
  });

  test("a refused capture assigns nothing", async () => {
    const { w, io } = world({ cues: [] });
    w.captureResult = "refused";
    await padPress(io, 1);
    expect(w.assigns).toEqual([]);
  });

  test("a slot pointing at a vanished cue counts as empty", async () => {
    const { w, io } = world({ cues: [], slots: [55, ...Array(7).fill(null)] });
    await padPress(io, 0);
    expect(w.assigns).toEqual([[0, 100]]);
  });
});

describe("padDelete", () => {
  const one = () => world({ cues: [cue(10, 12_000, "cue", "drop")], slots: [null, 10, ...Array(6).fill(null)] });

  test("deletes through the cue store and offers undo", async () => {
    const { w, io } = one();
    await padDelete(io, 1);
    expect(w.cues).toEqual([]);
    expect(w.slots[1]).toBeNull();
    expect(w.undo).not.toBeNull();
  });

  test("undo recreates position and label and puts it back in its slot", async () => {
    const { w, io } = one();
    await padDelete(io, 1);
    w.undo!();
    await Bun.sleep(0);
    expect(w.created).toEqual([{ position_ms: 12_000, kind: "cue", label: "drop" }]);
    expect(w.slots[1]).toBe(100);
  });

  test("undo with the slot reused leaves the restored cue unassigned and the newcomer in place", async () => {
    const { w, io } = one();
    await padDelete(io, 1);
    w.cues.push(cue(77, 500));
    w.slots[1] = 77;
    w.undo!();
    await Bun.sleep(0);
    expect(w.slots[1]).toBe(77);
    expect(w.cues.some(c => c.id === 100)).toBe(true);
    expect(w.assigns).toEqual([]);
  });

  test("undo after switching tracks restores the cue unassigned", async () => {
    const { w, io } = one();
    await padDelete(io, 1);
    w.track = 2;
    w.slots = Array(8).fill(null);
    w.undo!();
    await Bun.sleep(0);
    expect(w.created.length).toBe(1);
    expect(w.assigns).toEqual([]);
  });

  test("an entry or exit cue is only unassigned, never deleted", async () => {
    for (const kind of ["entry", "exit"] as const) {
      const { w, io } = world({ cues: [cue(20, 1000, kind)], slots: [20, ...Array(7).fill(null)] });
      await padDelete(io, 0);
      expect(w.assigns).toEqual([[0, null]]);
      expect(w.cues.length).toBe(1);
      expect(w.undo).toBeNull();
    }
  });

  test("an empty pad does nothing, and a dialog blocks deletion", async () => {
    const empty = world({ cues: [] });
    await padDelete(empty.io, 0);
    expect(empty.w.toasts).toEqual([]);
    const { w, io } = one();
    w.open = true;
    await padDelete(io, 1);
    expect(w.cues.length).toBe(1);
  });

  test("a failed delete reports an error and offers no undo", async () => {
    const { w, io } = one();
    io.deleteCue = async () => { throw new Error("x"); };
    await padDelete(io, 1);
    expect(w.errors.length).toBe(1);
    expect(w.undo).toBeNull();
  });
});
