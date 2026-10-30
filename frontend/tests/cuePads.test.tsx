import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { CuePads } from "../src/components/CuePads";
import { assignCuePad, loadCuePadSlots, saveCuePadSlots } from "../src/lib/cuePads";
import { cuePadIndex, suppressPlaybackShortcut } from "../src/lib/keyboardGuard";
import { activateAudio, hasPlaybackKeyOwner, ownsPlaybackKeys, releaseAudio, reportPlayback } from "../src/lib/player";
import { CueList, CueMarkers, cueColor, cuePresentation, type CueState } from "../src/components/PlayerCues";
import type { TrackCue } from "../src/lib/types";

const cue = (id: number, position_ms = id * 1000, kind: TrackCue["kind"] = "cue"): TrackCue => ({
  id, track_id: 42, position_ms, kind, label: null, created_at: "", updated_at: "",
});
function storage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

describe("persistent eight cue pads", () => {
  test("initial order includes entry and exit chronologically without removing overflow", () => {
    const cues = [cue(3, 1000, "entry"), cue(2, 1000), cue(1, 10000, "exit"), ...Array.from({ length: 8 }, (_, i) => cue(i + 4, 2000 + i * 1000))];
    const before = structuredClone(cues);
    expect(loadCuePadSlots(storage(), 42, cues)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(cues).toEqual(before);
    expect(cues).toHaveLength(11);
  });
  test("time edits and restart preserve pad identity; deletion leaves a hole", () => {
    const db = storage();
    const cues = [cue(1, 1000, "entry"), cue(2), cue(3, 3000, "exit")];
    saveCuePadSlots(db, 42, loadCuePadSlots(db, 42, cues));
    const edited = cues.map(cue => cue.id === 3 ? { ...cue, position_ms: 0 } : cue);
    expect(loadCuePadSlots(db, 42, edited)).toEqual([1, 2, 3, null, null, null, null, null]);
    const deleted = loadCuePadSlots(db, 42, edited.filter(cue => cue.id !== 2));
    saveCuePadSlots(db, 42, deleted);
    expect(loadCuePadSlots(db, 42, [...edited.filter(cue => cue.id !== 2), cue(99)])).toEqual([1, null, 3, null, null, null, null, null]);
  });
  test("assigning overflow and clearing a pad never deletes cues or shifts neighbors", () => {
    const cues = Array.from({ length: 10 }, (_, i) => cue(i + 1));
    const original = loadCuePadSlots(storage(), 42, cues);
    const assigned = assignCuePad(original, 2, 10);
    expect(assigned).toEqual([1, 2, 10, 4, 5, 6, 7, 8]);
    expect(assignCuePad(assigned, 0, 10)).toEqual([10, 2, null, 4, 5, 6, 7, 8]);
    expect(assignCuePad(assigned, 2, null)).toEqual([1, 2, null, 4, 5, 6, 7, 8]);
    expect(original).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(cues).toHaveLength(10);
  });
  test("per-track writes merge and invalid stored layouts recover without cue writes", () => {
    const db = storage();
    saveCuePadSlots(db, 42, [1, null, null, null, null, null, null, null]);
    saveCuePadSlots(db, 58, [2, null, null, null, null, null, null, null]);
    expect(loadCuePadSlots(db, 42, [cue(1)])).toEqual([1, null, null, null, null, null, null, null]);
    expect(loadCuePadSlots(db, 58, [cue(2)])).toEqual([2, null, null, null, null, null, null, null]);
    expect(db.values.size).toBe(1);
    db.setItem("cm:cue-pads:v1:10", '{"42":[1,1,1,1,1,1,1,1]}');
    expect(loadCuePadSlots(db, 42, [cue(3)])).toEqual([3, null, null, null, null, null, null, null]);
  });
  test("mapped pad, waveform and full list share stable numbering and three colors after time edits", () => {
    const slots = [null, 2, null, 1, null, null, 4, null];
    const cues = [cue(1, 5000), cue(2, 2000, "entry"), cue(3, 500), cue(4, 4000, "exit"), cue(5, 3500)];
    const edited = cues.map(item => item.id === 1 ? { ...item, position_ms: 0 } : item);
    for (const items of [cues, edited]) {
      const assigned = cuePresentation(items, slots).filter(item => slots.includes(item.cue.id));
      expect(assigned.find(item => item.cue.id === 1)).toMatchObject({ ordinal: 4, colorClass: "text-cm-cyan" });
      expect(assigned.find(item => item.cue.id === 2)).toMatchObject({ ordinal: 2, colorClass: "text-cm-chartreuse" });
      const overflow = cuePresentation(items, slots).filter(item => !slots.includes(item.cue.id));
      expect(overflow.map(item => [item.cue.id, item.ordinal])).toEqual([[3, 9], [5, 10]]);
      expect(new Set(cuePresentation(items, slots).map(item => item.ordinal)).size).toBe(items.length);
    }
    const state: CueState = { cues: edited, loading: false, loaded: true, error: null, pendingKinds: new Set(), pendingCueIds: new Set(),
      createCue: async () => cue(3), updateCue: async () => cue(3), deleteCue: async () => {}, refresh: async () => {} };
    const pads = renderToString(<CuePads trackId={42} state={state} slots={slots} canCapture canSeek onCapture={() => {}} onSeek={() => {}} onAssign={() => {}} onCreate={async () => {}} />);
    const list = renderToString(<CueList state={state} canSeek onSeek={() => {}} slots={slots} />);
    const markers = renderToString(<CueMarkers cues={edited} duration={10} canSeek onSeek={() => {}} slots={slots} />);
    for (const item of cuePresentation(edited, slots).filter(item => slots.includes(item.cue.id))) {
      const listItem = list.match(new RegExp(`<li[^>]*data-cue-id="${item.cue.id}"[^>]*>.*?</li>`))?.[0] ?? "";
      const marker = markers.match(new RegExp(`<button[^>]*data-cue-id="${item.cue.id}"[^>]*>.*?</button>`))?.[0] ?? "";
      const pad = pads.match(new RegExp(`<div[^>]*data-cue-id="${item.cue.id}"[^>]*>.*?</div>`))?.[0] ?? "";
      for (const html of [listItem, marker, pad]) expect(html).toContain(`data-cue-number="${item.ordinal}"`);
      expect(listItem).toContain(item.colorClass);
      expect(marker).toContain(item.colorClass);
      expect(pad).toContain(`--pad-color:${cueColor(item.ordinal).colorValue}`);
    }
    expect(pads).not.toContain("--color-cm-blue");
    expect(slots).toEqual([null, 2, null, 1, null, null, 4, null]);
  });
  test("renders eight numbered pads with settings and assigned entry/exit, without an extra control strip", () => {
    const cues = [cue(1, 1000, "entry"), cue(2, 2000, "exit")];
    const state: CueState = { cues, loading: false, loaded: true, error: null, pendingKinds: new Set(), pendingCueIds: new Set(),
      createCue: async () => cue(3), updateCue: async () => cue(3), deleteCue: async () => {}, refresh: async () => {} };
    const html = renderToString(<CuePads trackId={42} state={state} slots={loadCuePadSlots(storage(), 42, cues)} canCapture canSeek onCapture={() => {}} onSeek={() => {}} onAssign={() => {}} onCreate={async () => {}} />);
    expect(html.match(/data-cue-pad="true"/g) ?? html.match(/data-cue-pad=""/g)).toHaveLength(8);
    for (let i = 1; i <= 8; i++) expect(html).toContain(`Ρυθμίσεις pad ${i}`);
    expect(html).toContain("Pad 1: Entry 0:01.000");
    expect(html).toContain("Pad 2: Exit 0:02.000");
    expect(html).not.toContain("Προβολή cues (2)");
    expect(html).toContain('role="group" aria-label="Cue pads 1–8"');
    expect(html).toContain("grid-cols-4");
  });
});

describe("playback keyboard ownership", () => {
  test("digit and numpad keys address the same slots, never a rating index", () => {
    for (let i = 1; i <= 8; i++) {
      expect(cuePadIndex(`Digit${i}`)).toBe(i - 1);
      expect(cuePadIndex(`Numpad${i}`)).toBe(i - 1);
    }
    for (const code of ["Digit0", "Digit9", "KeyI", "Space", "Digit18"]) expect(cuePadIndex(code)).toBeNull();
  });
  test("Space remains global on a focused row/action button but suppresses typing and cue controls", () => {
    const target = (tagName: string, matching = false) => ({ tagName, closest: () => matching ? {} : null }) as unknown as EventTarget;
    expect(suppressPlaybackShortcut(target("BUTTON"), "Space")).toBe(false);
    expect(suppressPlaybackShortcut(target("A"), "Space")).toBe(false);
    for (const tag of ["INPUT", "TEXTAREA", "SELECT"]) expect(suppressPlaybackShortcut(target(tag), "Space")).toBe(true);
    expect(suppressPlaybackShortcut(target("BUTTON", true), "Space")).toBe(true);
  });
  test("Space and pad digits work after player range, volume, pads and closed cue controls", () => {
    const target = (tagName: string, selectors: string[], type = "") => ({
      tagName, type,
      closest: (selector: string) => selector.split(",").some(part => selectors.includes(part.trim())) ? {} : null,
    }) as unknown as EventTarget;
    const seek = target("INPUT", ['[data-playback-shortcuts]'], "range");
    const volume = target("SPAN", ['[data-playback-shortcuts]', '[role="slider"]']);
    const assignedPad = target("BUTTON", ['[data-player-cues]', 'button', '[data-cue-pad]']);
    const emptyPad = target("BUTTON", ['[data-player-cues]', 'button', '[data-cue-pad]']);
    const closedCueCog = target("BUTTON", ['[data-player-cues]', 'button', '[aria-haspopup="dialog"]']);
    const addEntryOrExit = target("BUTTON", ['[data-player-cues]', 'button']);
    for (const control of [seek, volume, assignedPad, emptyPad, closedCueCog, addEntryOrExit]) {
      expect(suppressPlaybackShortcut(control, "Space")).toBe(false);
      expect(suppressPlaybackShortcut(control, "Digit1")).toBe(false);
      expect(suppressPlaybackShortcut(control, "Numpad8")).toBe(false);
      // Enter is left to the focused control, including empty-pad assignment.
      expect(suppressPlaybackShortcut(control, "Enter")).toBe(true);
    }
    expect(suppressPlaybackShortcut(seek, "ArrowRight")).toBe(true);
    expect(suppressPlaybackShortcut(volume, "ArrowLeft")).toBe(true);
    const editor = target("INPUT", ['[data-player-cues]', 'form', '[role="dialog"]'], "text");
    const editorButton = target("BUTTON", ['[data-player-cues]', 'button', 'form', '[role="dialog"]']);
    const sidebarSettings = target("BUTTON", ['[aria-haspopup="dialog"]']);
    const nativeSelectTrigger = target("BUTTON", ['[role="combobox"]']);
    for (const control of [editor, editorButton, sidebarSettings, nativeSelectTrigger]) {
      expect(suppressPlaybackShortcut(control, "Space")).toBe(true);
      expect(suppressPlaybackShortcut(control, "Digit1")).toBe(true);
    }
    const original = Object.getOwnPropertyDescriptor(globalThis, "document");
    try {
      Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: () => ({}) } });
      for (const control of [seek, volume, assignedPad, emptyPad, closedCueCog]) {
        expect(suppressPlaybackShortcut(control, "Space")).toBe(true);
        expect(suppressPlaybackShortcut(control, "Digit1")).toBe(true);
      }
    } finally {
      if (original) Object.defineProperty(globalThis, "document", original);
      else Reflect.deleteProperty(globalThis, "document");
    }
  });
  test("a loaded Flow reference owns Space before any playback when the primary is empty", () => {
    const primary = { pause: () => {} } as HTMLAudioElement;
    const reference = { pause: () => {} } as HTMLAudioElement;
    reportPlayback(primary, { trackId: null, playing: false, primary: true, status: "" });
    reportPlayback(reference, { trackId: 73, playing: false, primary: false, status: "" });
    expect(hasPlaybackKeyOwner()).toBe(true);
    expect(ownsPlaybackKeys(primary, true)).toBe(false);
    expect(ownsPlaybackKeys(reference, false)).toBe(true);
    reportPlayback(primary, { trackId: 42, playing: false, primary: true, status: "" });
    expect(ownsPlaybackKeys(primary, true)).toBe(true);
    expect(ownsPlaybackKeys(reference, false)).toBe(false);
    releaseAudio(reference);
    releaseAudio(primary);
  });
  test("a second deck pauses the first and exclusively owns shortcuts even while paused", () => {
    let pauses = 0;
    const first = { pause: () => { pauses++; } } as HTMLAudioElement;
    const second = { pause: () => {} } as HTMLAudioElement;
    reportPlayback(first, { trackId: 42, playing: false, primary: true, status: "" });
    expect(hasPlaybackKeyOwner()).toBe(true);
    expect(ownsPlaybackKeys(first, true)).toBe(true);
    activateAudio(first);
    activateAudio(second);
    expect(pauses).toBe(1);
    expect(ownsPlaybackKeys(first, true)).toBe(false);
    expect(ownsPlaybackKeys(second, false)).toBe(true);
    releaseAudio(second);
    releaseAudio(first);
    expect(hasPlaybackKeyOwner()).toBe(false);
  });
});
