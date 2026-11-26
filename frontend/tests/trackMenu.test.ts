import { describe, expect, test } from "bun:test";
import type { MenuEntry } from "../src/lib/menus/entries";
import { MENU_REASONS, selectionMenuEntries, trackLine, trackMenuEntries, type TrackMenuContext } from "../src/lib/menus/trackMenu";
import { STATUS_VALUES, type DJSet, type Track } from "../src/lib/types";

const track = (over: Partial<Track> = {}): Track => ({
  id: 1, absolute_path: "/Music/Psy/Astrix - Deep Jungle Walk.flac", file_name: "Astrix - Deep Jungle Walk.flac", extension: ".flac",
  artist: "Astrix", title: "Deep Jungle Walk", bpm: 145, play_count: 0, missing: false, personal_status: "approved", ...over,
});
const set = (id: number, title: string): DJSet => ({ id, title } as DJSet);

type Calls = { name: string; args: unknown[] }[];

/** Every action present, recording calls; `over` replaces facts or removes actions (undefined). */
function context(over: Partial<TrackMenuContext> = {}, calls: Calls = []): TrackMenuContext {
  const rec = (name: string) => (...args: unknown[]) => { calls.push({ name, args }); };
  return {
    profile: "dj", deckPlaying: { A: false, B: false }, mixRunning: false, sets: [set(1, "Old"), set(3, "Newest"), set(2, "Open")],
    ownSetId: 2, ownSetTitle: "Open",
    play: rec("play"), load: rec("load"), addToOwnSet: rec("addToOwnSet"), addToSet: rec("addToSet"), newSet: rec("newSet"),
    edit: rec("edit"), setStatus: rec("setStatus"), bpm: rec("bpm"), analyze: rec("analyze"), flowFinder: rec("flowFinder"),
    openArtist: rec("openArtist"), reveal: rec("reveal"), copy: rec("copy"), bulkEdit: rec("bulkEdit"), clearSelection: rec("clearSelection"),
    ...over,
  };
}

const labels = (entries: MenuEntry[]) => entries.map(e => (e.type === "separator" ? "—" : e.label));
function find(entries: MenuEntry[], label: string): MenuEntry {
  const hit = entries.find(e => e.type !== "separator" && e.label === label);
  if (!hit) throw new Error(`no entry «${label}» in ${labels(entries).join(" | ")}`);
  return hit;
}
const sub = (entries: MenuEntry[], label: string) => {
  const hit = find(entries, label);
  if (hit.type !== "sub") throw new Error(`«${label}» is not a submenu`);
  return hit;
};
const select = (entry: MenuEntry) => { if ("onSelect" in entry) entry.onSelect(); };
const state = (entry: MenuEntry) => ({ disabled: "disabled" in entry ? !!entry.disabled : false, reason: "reason" in entry ? entry.reason : undefined });

describe("track menu", () => {
  test("every item in the stable order, grouped by separators", () => {
    expect(labels(trackMenuEntries(track(), context()))).toEqual([
      "Ακρόαση", "Φόρτωση στο Deck A", "Φόρτωση στο Deck B",
      "—", "Προσθήκη στο «Open»", "Προσθήκη σε set",
      "—", "Επεξεργασία προφίλ", "Κατάσταση", "BPM", "Ανάλυση BPM…",
      "—", "Flow Finder από εδώ", "Κομμάτια του καλλιτέχνη", "Εμφάνιση στον φάκελο", "Αντιγραφή",
    ]);
  });

  test("a place without actions shows only what always works, with no stray separators", () => {
    const bare = context({
      play: undefined, load: undefined, addToOwnSet: undefined, edit: undefined, setStatus: undefined, bpm: undefined,
      analyze: undefined, flowFinder: undefined, openArtist: undefined, reveal: undefined,
    });
    expect(labels(trackMenuEntries(track(), bare))).toEqual(["Προσθήκη σε set", "—", "Αντιγραφή"]);
  });

  test("a missing file disables play, deck loads and the folder; other items stay", () => {
    const entries = trackMenuEntries(track({ missing: true }), context());
    for (const label of ["Ακρόαση", "Φόρτωση στο Deck A", "Φόρτωση στο Deck B", "Εμφάνιση στον φάκελο"]) {
      expect([label, state(find(entries, label))]).toEqual([label, { disabled: true, reason: MENU_REASONS.missing }]);
    }
    expect(state(find(entries, "Αντιγραφή")).disabled).toBe(false);
  });

  test("a playing deck disables only its own load; a set mix disables play and both loads", () => {
    const playing = trackMenuEntries(track(), context({ deckPlaying: { A: true, B: false } }));
    expect(state(find(playing, "Φόρτωση στο Deck A"))).toEqual({ disabled: true, reason: "παίζει" });
    expect(state(find(playing, "Φόρτωση στο Deck B")).disabled).toBe(false);
    expect(state(find(playing, "Ακρόαση")).disabled).toBe(false);
    const mix = trackMenuEntries(track(), context({ mixRunning: true, deckPlaying: { A: true, B: true } }));
    for (const label of ["Ακρόαση", "Φόρτωση στο Deck A", "Φόρτωση στο Deck B"]) {
      expect([label, state(find(mix, label))]).toEqual([label, { disabled: true, reason: MENU_REASONS.mix }]);
    }
  });

  test("deck loads call load with the deck and the track", () => {
    const calls: Calls = [];
    const t = track();
    select(find(trackMenuEntries(t, context({}, calls)), "Φόρτωση στο Deck B"));
    expect(calls).toEqual([{ name: "load", args: ["B", t] }]);
  });

  test("the own set: named and enabled, disabled without one, hidden where the place has none", () => {
    const calls: Calls = [];
    const t = track();
    select(find(trackMenuEntries(t, context({}, calls)), "Προσθήκη στο «Open»"));
    expect(calls).toEqual([{ name: "addToOwnSet", args: [[t]] }]);
    const none = trackMenuEntries(t, context({ ownSetId: null, ownSetTitle: null }));
    expect(state(find(none, "Προσθήκη στο ενεργό set"))).toEqual({ disabled: true, reason: MENU_REASONS.noActiveSet });
    expect(labels(trackMenuEntries(t, context({ addToOwnSet: undefined })))).not.toContain("Προσθήκη στο «Open»");
  });

  test("the own set: a place's reason disables it (Set Builder saving, or no open set)", () => {
    const calls: Calls = [];
    const busy = trackMenuEntries(track(), context({ ownSetReason: "αποθήκευση…" }, calls));
    expect(state(find(busy, "Προσθήκη στο «Open»"))).toEqual({ disabled: true, reason: "αποθήκευση…" });
    const none = trackMenuEntries(track(), context({ ownSetId: null, ownSetTitle: null, ownSetReason: "κανένα ανοιχτό set" }));
    expect(state(find(none, "Προσθήκη στο set"))).toEqual({ disabled: true, reason: "κανένα ανοιχτό set" });
  });

  test("a long own-set title is cut inside the quotes", () => {
    const entries = trackMenuEntries(track(), context({ ownSetTitle: "Psy Night στο Κεραμεικό — Σάββατο 28 Νοεμβρίου" }));
    expect(labels(entries)).toContain("Προσθήκη στο «Psy Night στο Κεραμεικό — Σ…»");
  });

  test("«Προσθήκη σε set» lists the other sets newest first, then «Νέο set…»", () => {
    const calls: Calls = [];
    const t = track();
    const sets = sub(trackMenuEntries(t, context({}, calls)), "Προσθήκη σε set");
    expect(labels(sets.entries)).toEqual(["Newest", "Old", "—", "Νέο set…"]);
    select(find(sets.entries, "Old"));
    select(find(sets.entries, "Νέο set…"));
    expect(calls).toEqual([{ name: "addToSet", args: [set(1, "Old"), [t]] }, { name: "newSet", args: [[t]] }]);
  });

  test("«Προσθήκη σε set» while the sets load, and with no other set", () => {
    expect(labels(sub(trackMenuEntries(track(), context({ sets: null })), "Προσθήκη σε set").entries)).toEqual(["Φόρτωση…", "—", "Νέο set…"]);
    expect(labels(sub(trackMenuEntries(track(), context({ sets: [set(2, "Open")] })), "Προσθήκη σε set").entries))
      .toEqual(["Δεν υπάρχουν άλλα sets.", "—", "Νέο set…"]);
  });

  test("«Κατάσταση» is a radio list in Greek with the current status checked; choosing it again writes nothing", () => {
    const calls: Calls = [];
    const t = track();
    const status = sub(trackMenuEntries(t, context({}, calls)), "Κατάσταση");
    expect(status.entries.every(e => e.type === "radio")).toBe(true);
    expect(labels(status.entries)).toContain("banger");
    expect(labels(status.entries)).toContain("εγκεκριμένο");
    expect(status.entries.filter(e => e.type === "radio" && e.checked).map(e => e.type !== "separator" && e.label)).toEqual(["εγκεκριμένο"]);
    select(find(status.entries, "εγκεκριμένο"));
    expect(calls).toEqual([]);
    select(find(status.entries, "banger"));
    expect(calls).toEqual([{ name: "setStatus", args: [t, "weapon"] }]);
  });

  test("therapy: no «banger», and a DJ banger shows as approved without being overwritten", () => {
    const calls: Calls = [];
    const status = sub(trackMenuEntries(track({ personal_status: "weapon" }), context({ profile: "therapy" }, calls)), "Κατάσταση");
    expect(labels(status.entries)).not.toContain("banger");
    const approved = status.entries.find(e => e.type === "radio" && e.checked);
    expect(approved).toBeDefined();
    select(approved!);
    expect(calls).toEqual([]);
  });

  test("«Κατάσταση» is disabled for the track open in the inspector, and shows the place's keys", () => {
    const status = sub(trackMenuEntries(track(), context({ editingTrackId: 1 })), "Κατάσταση");
    expect(state(status)).toEqual({ disabled: true, reason: MENU_REASONS.editing });
    expect(state(sub(trackMenuEntries(track(), context({ editingTrackId: 2 })), "Κατάσταση")).disabled).toBe(false);
    const keyed = sub(trackMenuEntries(track(), context({ statusKeys: { weapon: "W", approved: "A" } })), "Κατάσταση");
    const shortcut = (label: string) => { const e = find(keyed.entries, label); return e.type === "radio" ? e.shortcut : undefined; };
    expect([shortcut("banger"), shortcut("εγκεκριμένο"), shortcut("δοκιμή")]).toEqual(["W", "A", undefined]);
  });

  test("«BPM»: the data-safety note, halves and doubles, reset only for a manual BPM", () => {
    const calls: Calls = [];
    const t = track();
    const bpm = sub(trackMenuEntries(t, context({}, calls)), "BPM");
    expect(labels(bpm.entries)).toEqual(["Μόνο στο CrateMind, όχι στα tags ή στο djay", "Μισό BPM (×½)", "Διπλό BPM (×2)"]);
    select(find(bpm.entries, "Μισό BPM (×½)"));
    select(find(bpm.entries, "Διπλό BPM (×2)"));
    expect(calls.map(c => c.args[1])).toEqual([0.5, 2]);
    const manual = sub(trackMenuEntries(track({ bpm_consensus: 146, bpm_consensus_sources: "manual:octave" }), context()), "BPM");
    expect(labels(manual.entries)).toContain("Επαναφορά αυτόματου BPM");
  });

  test("«BPM» without any BPM: ×½ and ×2 are disabled", () => {
    const bpm = sub(trackMenuEntries(track({ bpm: null }), context()), "BPM");
    expect(state(find(bpm.entries, "Μισό BPM (×½)"))).toEqual({ disabled: true, reason: MENU_REASONS.noBpm });
    expect(state(find(bpm.entries, "Διπλό BPM (×2)"))).toEqual({ disabled: true, reason: MENU_REASONS.noBpm });
  });

  test("Flow Finder is DJ only", () => {
    expect(labels(trackMenuEntries(track(), context({ profile: "therapy" })))).not.toContain("Flow Finder από εδώ");
  });

  test("the artist's tracks: disabled without an artist, hidden when the query already filters this artist", () => {
    const calls: Calls = [];
    select(find(trackMenuEntries(track({ artist: " Astrix " }), context({}, calls)), "Κομμάτια του καλλιτέχνη"));
    expect(calls).toEqual([{ name: "openArtist", args: ["Astrix"] }]);
    expect(state(find(trackMenuEntries(track({ artist: null }), context()), "Κομμάτια του καλλιτέχνη")))
      .toEqual({ disabled: true, reason: MENU_REASONS.noArtist });
    const filtered = trackMenuEntries(track(), context({ artistFiltered: artist => artist === "Astrix" }));
    expect(labels(filtered)).not.toContain("Κομμάτια του καλλιτέχνη");
  });

  test("«Αντιγραφή» copies artist – title, the file name and the full path", () => {
    const calls: Calls = [];
    const copy = sub(trackMenuEntries(track(), context({}, calls)), "Αντιγραφή");
    for (const entry of copy.entries) select(entry);
    expect(calls.map(c => c.args[0])).toEqual([
      "Astrix – Deep Jungle Walk", "Astrix - Deep Jungle Walk.flac", "/Music/Psy/Astrix - Deep Jungle Walk.flac",
    ]);
    expect(trackLine(track({ artist: null, title: null }))).toBe("Astrix - Deep Jungle Walk.flac");
  });

  test("place items come last after a separator; none leaves no trailing separator", () => {
    const remove: MenuEntry = { type: "item", label: "Αφαίρεση από το set", danger: true, onSelect: () => {} };
    expect(labels(trackMenuEntries(track(), context(), [remove])).slice(-3)).toEqual(["Αντιγραφή", "—", "Αφαίρεση από το set"]);
    expect(labels(trackMenuEntries(track(), context(), [false])).at(-1)).toBe("Αντιγραφή");
  });

  test("no internal keys reach the labels", () => {
    const all = (entries: MenuEntry[]): string[] =>
      entries.flatMap(e => (e.type === "separator" ? [] : e.type === "sub" ? [e.label, ...all(e.entries)] : [e.label]));
    for (const label of all(trackMenuEntries(track(), context()))) {
      expect([label, (STATUS_VALUES as readonly string[]).includes(label) || label.includes("_")]).toEqual([label, false]);
    }
  });
});

describe("selection menu", () => {
  const tracks = [track({ id: 1 }), track({ id: 2, artist: null, title: "Untitled", file_name: "u.mp3" })];

  test("the count, then the set, bulk, copy and clear groups", () => {
    expect(labels(selectionMenuEntries(tracks, context()))).toEqual([
      "2 επιλεγμένα κομμάτια", "Προσθήκη στο «Open»", "Προσθήκη σε set",
      "—", "Μαζική επεξεργασία…", "Ανάλυση BPM…",
      "—", "Αντιγραφή λίστας",
      "—", "Καθαρισμός επιλογής",
    ]);
  });

  test("every action receives the whole selection, in the given order", () => {
    const calls: Calls = [];
    const entries = selectionMenuEntries(tracks, context({}, calls));
    select(find(entries, "Προσθήκη στο «Open»"));
    select(find(sub(entries, "Προσθήκη σε set").entries, "Newest"));
    select(find(entries, "Ανάλυση BPM…"));
    select(find(entries, "Αντιγραφή λίστας"));
    expect(calls).toEqual([
      { name: "addToOwnSet", args: [tracks] },
      { name: "addToSet", args: [set(3, "Newest"), tracks] },
      { name: "analyze", args: [tracks] },
      { name: "copy", args: ["Astrix – Deep Jungle Walk\nUntitled"] },
    ]);
  });

  test("without analysis or a bulk editor those items are hidden, and no active set disables the own-set item", () => {
    const entries = selectionMenuEntries(tracks, context({ analyze: undefined, bulkEdit: undefined, ownSetTitle: null }));
    expect(labels(entries)).not.toContain("Ανάλυση BPM…");
    expect(labels(entries)).not.toContain("Μαζική επεξεργασία…");
    expect(state(find(entries, "Προσθήκη στο ενεργό set"))).toEqual({ disabled: true, reason: MENU_REASONS.noActiveSet });
  });

  test("the count is formatted in Greek", () => {
    const many = Array.from({ length: 1234 }, (_, i) => track({ id: i + 1 }));
    expect(labels(selectionMenuEntries(many, context()))[0]).toBe("1.234 επιλεγμένα κομμάτια");
  });
});
