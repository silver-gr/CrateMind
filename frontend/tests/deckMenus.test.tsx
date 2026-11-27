import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToString } from "react-dom/server";
import { CueEditor, type CueState } from "../src/components/PlayerCues";
import type { MenuEntry } from "../src/lib/menus/entries";
import { deckMenuEntries } from "../src/lib/menus/deckMenu";
import { cuePadMenuEntries, PAD_REASONS, type CuePadMenuContext } from "../src/lib/menus/cuePadMenu";
import { MENU_REASONS, type TrackMenuContext } from "../src/lib/menus/trackMenu";
import type { DJSet, Track, TrackCue } from "../src/lib/types";

type Calls = { name: string; args: unknown[] }[];
const recorder = (calls: Calls) => (name: string) => (...args: unknown[]) => { calls.push({ name, args }); };

const track = (over: Partial<Track> = {}): Track => ({
  id: 1, absolute_path: "/Music/Psy/Astrix - Deep Jungle Walk.flac", file_name: "Astrix - Deep Jungle Walk.flac", extension: ".flac",
  artist: "Astrix", title: "Deep Jungle Walk", bpm: 145, play_count: 0, missing: false, personal_status: "approved", ...over,
});
const cue = (id: number, position_ms = id * 1000, kind: TrackCue["kind"] = "cue"): TrackCue => ({
  id, track_id: 42, position_ms, kind, label: null, created_at: "", updated_at: "",
});

function trackContext(over: Partial<TrackMenuContext> = {}, calls: Calls = []): TrackMenuContext {
  const rec = recorder(calls);
  return {
    profile: "dj", deckPlaying: { A: false, B: false }, mixRunning: false, sets: [{ id: 1, title: "Old" } as DJSet], ownSetId: null,
    play: rec("play"), load: rec("load"), addToOwnSet: rec("addToOwnSet"), addToSet: rec("addToSet"), newSet: rec("newSet"),
    edit: rec("edit"), setStatus: rec("setStatus"), bpm: rec("bpm"), analyze: rec("analyze"), flowFinder: rec("flowFinder"),
    openArtist: rec("openArtist"), reveal: rec("reveal"), copy: rec("copy"),
    ...over,
  };
}

const labels = (entries: MenuEntry[]) => entries.map(e => (e.type === "separator" ? "—" : e.label));
function find(entries: MenuEntry[], label: string): MenuEntry {
  const hit = entries.find(e => e.type !== "separator" && e.label === label);
  if (!hit) throw new Error(`no entry «${label}» in ${labels(entries).join(" | ")}`);
  return hit;
}
const select = (entry: MenuEntry) => { if ("onSelect" in entry) entry.onSelect(); };
const state = (entry: MenuEntry) => ({ disabled: "disabled" in entry ? !!entry.disabled : false, reason: "reason" in entry ? entry.reason : undefined });

describe("deck menu", () => {
  test("eject and the other deck first, then the track menu's set, status, BPM, artist, folder and copy items", () => {
    expect(labels(deckMenuEntries("A", track(), trackContext(), () => {}))).toEqual([
      "Deck A", "Αφαίρεση από το Deck", "Φόρτωση και στο Deck B",
      "—", "Προσθήκη σε set",
      "—", "Κατάσταση", "BPM",
      "—", "Κομμάτια του καλλιτέχνη", "Εμφάνιση στον φάκελο", "Αντιγραφή",
    ]);
    expect(labels(deckMenuEntries("B", track(), trackContext(), () => {})).slice(0, 3)).toEqual(["Deck B", "Αφαίρεση από το Deck", "Φόρτωση και στο Deck A"]);
  });

  test("eject ejects; the other deck loads the same track", () => {
    const calls: Calls = [];
    let ejected = 0;
    const entries = deckMenuEntries("A", track(), trackContext({}, calls), () => { ejected++; });
    select(find(entries, "Αφαίρεση από το Deck"));
    select(find(entries, "Φόρτωση και στο Deck B"));
    expect(ejected).toBe(1);
    expect(calls).toEqual([{ name: "load", args: ["B", track()] }]);
  });

  test("the other deck is disabled while it plays, while a set mix runs and for a missing file; eject never is", () => {
    const other = (ctx: Partial<TrackMenuContext>, t = track()) => state(find(deckMenuEntries("A", t, trackContext(ctx), () => {}), "Φόρτωση και στο Deck B"));
    expect(other({})).toEqual({ disabled: false, reason: undefined });
    expect(other({ deckPlaying: { A: true, B: false } })).toEqual({ disabled: false, reason: undefined });
    expect(other({ deckPlaying: { A: false, B: true } })).toEqual({ disabled: true, reason: MENU_REASONS.playing });
    expect(other({ mixRunning: true })).toEqual({ disabled: true, reason: MENU_REASONS.mix });
    expect(other({}, track({ missing: true }))).toEqual({ disabled: true, reason: MENU_REASONS.missing });
    const entries = deckMenuEntries("A", track(), trackContext({ mixRunning: true, deckPlaying: { A: true, B: true } }), () => {});
    expect(state(find(entries, "Αφαίρεση από το Deck")).disabled).toBe(false);
  });

  test("no folder item without the desktop's native dialogs", () => {
    expect(labels(deckMenuEntries("A", track(), trackContext({ reveal: undefined }), () => {}))).not.toContain("Εμφάνιση στον φάκελο");
  });
});

describe("cue pad menu", () => {
  function padContext(over: Partial<CuePadMenuContext> = {}, calls: Calls = []): CuePadMenuContext {
    const rec = recorder(calls);
    return {
      cue: null, ghost: null, cues: [{ id: 7, label: "Cue 0:07.000" }], canSeek: true, canCapture: true, pending: false,
      jump: rec("jump"), keep: rec("keep"), capture: rec("capture"), assign: rec("assign"), settings: rec("settings"), deleteCue: rec("deleteCue"),
      ...over,
    };
  }
  const ghost = { slot: 2, label: "Drop", time_s: 96, source_s: 96, beat_s: 0.41 };

  test("a set pad: jump with its digit, settings, then clear the pad and delete the cue (rose)", () => {
    const entries = cuePadMenuEntries(padContext({ cue: cue(7), shortcut: "3" }));
    expect(labels(entries)).toEqual(["Μετάβαση", "Ρυθμίσεις pad…", "—", "Άδειασμα pad (το cue διατηρείται)", "Διαγραφή cue…"]);
    expect(find(entries, "Μετάβαση")).toMatchObject({ shortcut: "3" });
    expect(find(entries, "Διαγραφή cue…")).toMatchObject({ danger: true });
    expect(find(cuePadMenuEntries(padContext({ cue: cue(7) })), "Μετάβαση")).toMatchObject({ shortcut: undefined });
  });

  test("a set pad's items call the pad's own actions", () => {
    const calls: Calls = [];
    const entries = cuePadMenuEntries(padContext({ cue: cue(7) }, calls));
    for (const label of ["Μετάβαση", "Ρυθμίσεις pad…", "Άδειασμα pad (το cue διατηρείται)", "Διαγραφή cue…"]) select(find(entries, label));
    expect(calls).toEqual([
      { name: "jump", args: [] }, { name: "settings", args: [] }, { name: "assign", args: [null] }, { name: "deleteCue", args: [] },
    ]);
  });

  test("an empty pad: a cue here, a saved cue, settings", () => {
    const calls: Calls = [];
    const entries = cuePadMenuEntries(padContext({}, calls));
    expect(labels(entries)).toEqual(["Cue στο τρέχον σημείο", "Ανάθεση αποθηκευμένου cue", "Ρυθμίσεις pad…"]);
    const saved = find(entries, "Ανάθεση αποθηκευμένου cue");
    if (saved.type !== "sub") throw new Error("not a submenu");
    expect(labels(saved.entries)).toEqual(["Cue 0:07.000"]);
    select(saved.entries[0]);
    select(find(entries, "Cue στο τρέχον σημείο"));
    expect(calls).toEqual([{ name: "assign", args: [7] }, { name: "capture", args: [] }]);
    const none = find(cuePadMenuEntries(padContext({ cues: [] })), "Ανάθεση αποθηκευμένου cue");
    expect(none.type === "sub" && labels(none.entries)).toEqual(["Δεν υπάρχουν αποθηκευμένα cues."]);
  });

  test("a suggested (ghost) pad offers jump and keep first", () => {
    const calls: Calls = [];
    const entries = cuePadMenuEntries(padContext({ ghost }, calls));
    expect(labels(entries)).toEqual(["Μετάβαση", "Κράτα ως cue", "—", "Cue στο τρέχον σημείο", "Ανάθεση αποθηκευμένου cue", "Ρυθμίσεις pad…"]);
    select(find(entries, "Μετάβαση"));
    select(find(entries, "Κράτα ως cue"));
    expect(calls).toEqual([{ name: "jump", args: [] }, { name: "keep", args: [] }]);
    expect(labels(cuePadMenuEntries(padContext({ ghost, keep: undefined })))).not.toContain("Κράτα ως cue");
  });

  test("not ready or saving: the items are disabled with a reason, never hidden", () => {
    const set = cuePadMenuEntries(padContext({ cue: cue(7), canSeek: false }));
    expect(state(find(set, "Μετάβαση"))).toEqual({ disabled: true, reason: PAD_REASONS.notReady });
    const empty = cuePadMenuEntries(padContext({ canCapture: false }));
    expect(state(find(empty, "Cue στο τρέχον σημείο"))).toEqual({ disabled: true, reason: PAD_REASONS.notReady });
    const saving = cuePadMenuEntries(padContext({ ghost, pending: true }));
    expect(state(find(saving, "Κράτα ως cue"))).toEqual({ disabled: true, reason: PAD_REASONS.saving });
    expect(state(find(saving, "Cue στο τρέχον σημείο"))).toEqual({ disabled: true, reason: PAD_REASONS.saving });
    expect(state(find(saving, "Ρυθμίσεις pad…"))).toEqual({ disabled: true, reason: PAD_REASONS.saving });
  });
});

describe("pad editor and wiring", () => {
  const cueState = (cues: TrackCue[]): CueState => ({ cues, loading: false, loaded: true, error: null, pendingKinds: new Set(), pendingCueIds: new Set(),
    createCue: async () => cues[0], updateCue: async () => cues[0], deleteCue: async () => {}, refresh: async () => {} });

  test("the cue editor opens on its delete confirmation only when asked", () => {
    const editor = (confirmDelete?: boolean) => renderToString(<CueEditor cue={cue(7)} ordinal={3} state={cueState([cue(7)])} onClose={() => {}} confirmDelete={confirmDelete} />);
    expect(editor(true)).toContain("Επιβεβαίωση διαγραφής cue");
    expect(editor(true)).not.toContain("<form");
    expect(editor()).toContain("<form");
    expect(editor()).not.toContain("Επιβεβαίωση διαγραφής cue");
  });

  const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

  test("a Control-click (the Mac's right-click) never presses a pad", () => {
    expect(source("components/CuePads.tsx")).toMatch(/onClick=\{event => \{\s*\/\/[^\n]*\n\s*if \(event\.ctrlKey\) return;/);
  });

  test("a Control-click never seeks an overview, and a right or Control press never drags a knob", () => {
    expect(source("components/DeckHeader.tsx")).toContain("onMouseDown={event => { if (event.ctrlKey) event.preventDefault(); }}");
    expect(source("components/MiniPlayer.tsx")).toContain("onMouseDown={(e) => { if (e.ctrlKey) e.preventDefault(); }}");
    expect(source("components/ui/Knob.tsx")).toContain("onPointerDown={e => { if (e.button !== 0 || e.ctrlKey) return;");
  });

  test("the deck menu is on the header, the facts half and the one-deck info, overview and time; not on the scrolling lane", () => {
    const player = source("components/MiniPlayer.tsx");
    expect(player).toContain("const deckMenu = useDeckMenu(deck, current);");
    expect(player.match(/<ActionContextMenu pick=\{pickDeck\} menu=\{deckMenu\.menu\}>/g)?.length).toBe(3);
    expect(player).toMatch(/<DeckHeader [\s\S]*?menu=\{deckMenu\.menu\} \/>/);
    expect(player).toMatch(/<DeckFacts [^\n]*menu=\{deckMenu\.menu\}/);
    expect(player).not.toMatch(/<ActionContextMenu[^>]*>\s*<DeckScrollWaveform/);
    expect(source("components/DeckHeader.tsx").match(/<ActionContextMenu pick=\{pickDeck\} menu=\{menu\}>/g)?.length).toBe(2);
    expect(source("components/DeckFacts.tsx")).toMatch(/<ActionContextMenu pick=\{pickDeck\} menu=\{menu\}>\s*<div data-deck-facts-half/);
  });

  test("the context menu's panel is opaque in both themes, other menus untouched", () => {
    const menu = source("components/ui/context-menu.tsx");
    expect(menu).toContain('const OPAQUE_CLASS = "[background:linear-gradient(var(--cm-overlay),var(--cm-overlay)),var(--cm-bg)]!"');
    expect(menu.match(/cn\(CONTENT_CLASS, OPAQUE_CLASS,/g)?.length).toBe(2);
    expect(source("components/ui/dropdown-menu.tsx")).not.toContain("OPAQUE_CLASS");
  });
});
