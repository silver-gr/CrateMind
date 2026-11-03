import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ANALYSIS_FINISHED, applyBpmFields, bpmChangeText, createOctaveController, followAnalysisJob, queryHasBpmFilter, undoPlan } from "../src/lib/bpmUpdates";
import { effectiveBpm } from "../src/lib/tempo";
import type { BpmUpdate, Job, Track } from "../src/lib/types";

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const track: Track = {
  id: 7, file_name: "7.mp3", absolute_path: "/7.mp3", extension: "mp3", play_count: 0, missing: false,
  bpm: 145, bpm_analyzed: 190, bpm_consensus: 145, bpm_consensus_sources: "metadata+local", title: "T",
};
const update = (bpm: number): BpmUpdate => ({ track_id: 7, bpm_consensus: bpm, bpm_consensus_sources: "manual:octave", effective_bpm: bpm });

describe("BPM fields", () => {
  test("applyBpmFields changes only the two consensus fields and the manual value wins", () => {
    const next = applyBpmFields(track, { bpm_consensus: 72.5, bpm_consensus_sources: "manual:octave" });
    expect(next).toEqual({ ...track, bpm_consensus: 72.5, bpm_consensus_sources: "manual:octave" });
    expect(track.bpm_consensus).toBe(145);
    expect(effectiveBpm(next)).toBe(72.5);
  });

  test("undo: a manual old source gets the inverse factor, anything else resets", () => {
    expect(undoPlan("manual:octave", 2)).toEqual({ kind: "factor", factor: 0.5 });
    expect(undoPlan("manual:reccobeats", 0.5)).toEqual({ kind: "factor", factor: 2 });
    expect(undoPlan("metadata", 0.5)).toEqual({ kind: "reset" });
    expect(undoPlan(null, 2)).toEqual({ kind: "reset" });
  });

  test("the toast text rounds to one decimal", () => {
    expect(bpmChangeText(190, 95)).toBe("BPM 190 → 95");
    expect(bpmChangeText(147.33, 73.665)).toBe("BPM 147.3 → 73.7");
    expect(bpmChangeText(null, 95)).toBe("BPM — → 95");
  });

  test("only a bpm: token makes the Library reload", () => {
    expect(queryHasBpmFilter("bpm:140-150 status:approved")).toBe(true);
    expect(queryHasBpmFilter("-BPM:140-150")).toBe(true);
    expect(queryHasBpmFilter("energy:7-9 bpm")).toBe(false);
    expect(queryHasBpmFilter("")).toBe(false);
  });
});

describe("octave controller", () => {
  test("three rapid triggers against one pending request send exactly one", async () => {
    const sent: number[] = [];
    let resolve!: (value: BpmUpdate) => void;
    const done: BpmUpdate[] = [];
    const ctrl = createOctaveController<number>({
      send: factor => { sent.push(factor); return new Promise(r => { resolve = r; }); },
      onDone: result => { done.push(result); },
      onError: () => {},
      cooldownMs: 0,
    });
    expect(ctrl.trigger(2)).toBe(true);
    expect(ctrl.trigger(2)).toBe(false);
    expect(ctrl.trigger(2)).toBe(false);
    expect(sent).toEqual([2]);
    expect(ctrl.pending).toBe(true);
    resolve(update(380));
    await Promise.resolve(); await Promise.resolve();
    expect(done).toHaveLength(1);
    expect(ctrl.pending).toBe(false);
  });

  test("a fast request stays locked through the double-click gap, then sends again", async () => {
    const sent: number[] = [];
    const ctrl = createOctaveController<number>({
      send: factor => { sent.push(factor); return Promise.resolve(update(95)); },
      onDone: () => {},
      onError: () => {},
      cooldownMs: 30,
    });
    expect(ctrl.trigger(0.5)).toBe(true);
    await Promise.resolve(); await Promise.resolve();
    expect(ctrl.trigger(0.5)).toBe(false); // the settled request no longer pends, but the second click is ignored
    expect(sent).toEqual([0.5]);
    await new Promise(r => setTimeout(r, 40));
    expect(ctrl.trigger(0.5)).toBe(true);
    expect(sent).toEqual([0.5, 0.5]);
  });

  test("a rejected request leaves the controller idle and the next trigger sends again", async () => {
    const sent: number[] = [];
    const errors: unknown[] = [];
    let fail = true;
    const ctrl = createOctaveController<number>({
      send: factor => { sent.push(factor); return fail ? Promise.reject(new Error("422: x")) : Promise.resolve(update(95)); },
      onDone: () => {},
      onError: e => { errors.push(e); },
    });
    ctrl.trigger(0.5);
    await Promise.resolve(); await Promise.resolve();
    expect(errors).toHaveLength(1);
    expect(ctrl.pending).toBe(false);
    fail = false;
    expect(ctrl.trigger(0.5)).toBe(true);
    expect(sent).toEqual([0.5, 0.5]);
  });
});

describe("source contracts", () => {
  test("MiniPlayer keeps its load effect and renders the buttons once", () => {
    const mini = source("components/MiniPlayer.tsx");
    expect(mini).toContain("}, [current?.id, token, autoPlay]);");
    expect(mini.match(/<BpmOctaveButtons/g)).toHaveLength(1);
  });

  test("the tagging queue and the Library card render the buttons", () => {
    expect(source("pages/TaggingQueue.tsx")).toContain("<BpmOctaveButtons");
    expect(source("components/ProfileEditor.tsx")).toContain("<BpmOctaveButtons");
  });

  test("the Library and the tagging queue follow BPM_UPDATED", () => {
    for (const page of ["pages/Library.tsx", "pages/TaggingQueue.tsx"]) {
      expect([page, source(page).includes("addEventListener(BPM_UPDATED")]).toEqual([page, true]);
    }
  });

  test("the buttons keep keyboard focus: aria-disabled in flight, and «×½» takes focus after a reset", () => {
    const buttons = source("components/BpmOctaveButtons.tsx");
    expect(buttons).not.toMatch(/disabled=\{busy/);
    expect(buttons.match(/aria-disabled=\{inFlight\}/g)).toHaveLength(3);
    expect(buttons).toContain('if (request.action === "reset" && document.activeElement === resetRef.current) halfRef.current?.focus();');
    // Focus moves before publish(): the patched track then unmounts the reset button.
    expect(buttons.indexOf("halfRef.current?.focus()")).toBeLessThan(buttons.indexOf("publish(result);\n      toast("));
  });

  test("the buttons carry the Greek labels and the data-safety tooltip", () => {
    const buttons = source("components/BpmOctaveButtons.tsx");
    for (const text of ["Μισό BPM", "Διπλό BPM", "Επαναφορά BPM", "Επιστροφή στο αυτόματο BPM",
      "Αποθηκεύεται μόνο στο CrateMind, όχι στα tags ή στο djay", "Αναίρεση"]) {
      expect([text, buttons.includes(text)]).toEqual([text, true]);
    }
  });
});

describe("analysis job follower", () => {
  test("a Settings job is followed to its end outside the page and announces ANALYSIS_FINISHED once", async () => {
    const savedWindow = globalThis.window;
    const events: string[] = [];
    globalThis.window = { dispatchEvent: (event: Event) => { events.push(event.type); return true; } } as any;
    try {
      const reads: (number | undefined)[] = [];
      const read = async (jobId?: number): Promise<Job> => { reads.push(jobId); return { id: 41, kind: "analyze", status: "done", processed: 3 }; };
      followAnalysisJob({ id: 41, kind: "analyze", status: "running" }, read);
      followAnalysisJob({ id: 41, kind: "analyze", status: "running" }, read);
      followAnalysisJob({ id: 42, kind: "fingerprint", status: "running" }, read);
      followAnalysisJob({ id: 43, kind: "scan", status: "done" }, read);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(reads).toEqual([41]);
      expect(events).toEqual([ANALYSIS_FINISHED]);
    } finally {
      globalThis.window = savedWindow;
    }
  });

  test("Settings hands its jobs to the follower instead of dispatching from the page", () => {
    const settings = source("pages/Settings.tsx");
    expect(settings).not.toContain("dispatchEvent(new Event(ANALYSIS_FINISHED))");
    expect(settings.match(/followAnalysisJob\(current, api\.scanStatus\)/g)).toHaveLength(2);
  });
});
