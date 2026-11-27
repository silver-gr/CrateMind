// Test gaps (2026-11-27) for the Library's pure helpers: the `sort:` mirror of the backend, the deck-match chips,
// list totals, session plays, the relink review's stored answers and the track menu's own-set label.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  deckMatchTerms, hasSortToken, SORT_FIELDS, sessionPlayedIds, termsActive, toggleTerms, totalDurationLabel,
} from "../src/lib/libraryExtras";
import { heldBackRoots, loadDeclined, saveDeclined, scanHeldBack, scanMissingCount } from "../src/lib/relink";
import { trackLine, trackMenuEntries, type TrackMenuContext } from "../src/lib/menus/trackMenu";
import { eitherMenu, type MenuEntry } from "../src/lib/menus/entries";
import type { PlayHistoryEntry, Track } from "../src/lib/types";

const track = (fields: Partial<Track>): Track => ({ id: 1, absolute_path: "/a.mp3", file_name: "a.mp3", extension: "mp3", ...fields }) as Track;

describe("SORT_FIELDS mirrors backend _SORT_FIELDS", () => {
  test("the same field names as services/search.py, profile axes included", async () => {
    const search = await Bun.file(`${import.meta.dir}/../../backend/app/services/search.py`).text();
    const dict = /_SORT_FIELDS: dict\[str, Any\] = \{([\s\S]*?)\n\}/.exec(search)?.[1] ?? "";
    const named = [...dict.matchAll(/^\s+"([a-z_]+)":/gm)].map(m => m[1]);
    const profileSet = /_PROFILE_NUM = \{([\s\S]*?)\}/.exec(search)?.[1] ?? "";
    const profile = [...profileSet.matchAll(/"([a-z_]+)"/g)].map(m => m[1]);
    expect(named.length).toBeGreaterThan(5);
    expect(dict).toContain("for f in _PROFILE_NUM");
    expect(profile.length).toBeGreaterThan(5);
    expect([...SORT_FIELDS].sort()).toEqual([...new Set([...named, ...profile])].sort());
  });

  test.each([
    ["sort:bpm", true],
    ["sort:BPM", true],
    ["sort:-lufs", true],
    ["sort:--bpm", true], // the backend strips every leading "-" and sorts by BPM
    ["-sort:plays", true],
    ['sort:"title"', true],
    ["energy:8 sort:chaos_level limit:10", true],
    ["sort:tempo_bridge_score", true],
    ["sort:", false],
    ["sort:-", false],
    ["sort:year", false],
    ["sort:rating", false],
    ["bpm:140-150", false],
    ["", false],
    ["Σ' αγαπώ sort:artist", true],
  ] as const)("hasSortToken(%p) is %p", (query, expected) => {
    expect(hasSortToken(query)).toBe(expected);
  });
});

describe("deck match terms: boundaries and key sources", () => {
  test.each([
    // [fields, expected terms]
    [{ bpm: 174.5 }, ["bpm:164-185"]],
    [{ bpm: 70 }, ["bpm:65-75"]],
    [{ bpm: 100 }, ["bpm:94-106"]],
    [{ key_text: "~8A" }, ["key:8A,9A,7A,8B"]],
    [{ key_text: "  ", key_djay: "1A" }, ["key:1A,2A,12A,1B"]],
    [{ key_text: "F♯m" }, ["key:11A,12A,10A,11B"]],
    [{ key_text: "1m" }, ["key:8A,9A,7A,8B"]],
    [{ key_text: "12A" }, ["key:12A,1A,11A,12B"]],
    [{ key_text: "not a key" }, []],
  ] as [Partial<Track>, string[]][])("%p → %p", (fields, expected) => {
    expect(deckMatchTerms(track(fields))).toEqual(expected);
  });

  test("a manual BPM wins over the tag BPM for the tempo window", () => {
    const [bpmTerm] = deckMatchTerms(track({ bpm: 120, bpm_consensus: 145, bpm_consensus_sources: "manual:user" }));
    expect(bpmTerm).toBe("bpm:136-154");
  });

  test("a half-tempo tag with a grid an octave up keeps the tag's octave (no fold to the grid)", () => {
    expect(deckMatchTerms(track({ bpm: 72.5, bpm_grid: 145.2 }))).toEqual(["bpm:68-77"]);
  });
});

describe("toggleTerms: order of clicks", () => {
  const deckA = ["bpm:134-152", "key:8A,9A,7A,8B"];
  const deckB = ["bpm:164-185", "key:5B,6B,4B,5A"];

  test("deck A chip, then deck B chip: B replaces A, A is no longer active", () => {
    const a = toggleTerms("energy:8", deckA);
    const b = toggleTerms(a, deckB);
    expect(b).toBe("energy:8 bpm:164-185 key:5B,6B,4B,5A");
    expect(termsActive(b, deckA)).toBe(false);
    expect(termsActive(b, deckB)).toBe(true);
  });

  test("on, off, on gives the same query as one click (idempotent pairs)", () => {
    const once = toggleTerms("role:peak bpm:120-125", deckA);
    const thrice = toggleTerms(toggleTerms(once, deckA), deckA);
    expect(thrice).toBe(once);
  });

  test("terms already present in another order count as active and are removed", () => {
    const q = "key:8A,9A,7A,8B energy:7 bpm:134-152";
    expect(termsActive(q, deckA)).toBe(true);
    expect(toggleTerms(q, deckA)).toBe("energy:7");
  });

  test("an empty query gains only the terms; removing them leaves an empty query", () => {
    const on = toggleTerms("", deckA);
    expect(on).toBe("bpm:134-152 key:8A,9A,7A,8B");
    expect(toggleTerms(on, deckA)).toBe("");
  });

  test("an upper-case BPM field is replaced like a lower-case one; a negated one is kept", () => {
    expect(toggleTerms("BPM:120-125 -bpm:90-100", deckA)).toBe("-bpm:90-100 bpm:134-152 key:8A,9A,7A,8B");
  });

  test("quoted Greek free text with an apostrophe survives a round trip", () => {
    const q = "\"Σ' αγαπώ\" Χατζής";
    const on = toggleTerms(q, deckA);
    expect(toggleTerms(on, deckA)).toBe(q);
  });

  test("a trailing OR before the removed term is dropped, not left dangling", () => {
    expect(toggleTerms("role:peak OR bpm:140-150", deckA)).toBe("role:peak bpm:134-152 key:8A,9A,7A,8B");
  });
});

describe("totalDurationLabel boundaries", () => {
  test.each([
    [29, "0 λ"],
    [30, "1 λ"],
    [59 * 60 + 29, "59 λ"],
    [59 * 60 + 30, "1 ώ 0 λ"],
    [3600, "1 ώ 0 λ"],
    [3600 + 61 * 60, "2 ώ 1 λ"],
    [500 * 3600, "500 ώ 0 λ"],
  ])("%p s → %p", (seconds, label) => {
    expect(totalDurationLabel(seconds)).toBe(label);
  });
});

describe("sessionPlayedIds", () => {
  const play = (id: number, trackId: number, at: string) => ({ id, track_id: trackId, played_at: at }) as PlayHistoryEntry;
  const since = Date.parse("2026-11-26T10:00:00Z");

  test("a track played twice counts once; an offset timestamp is compared as an instant", () => {
    const ids = sessionPlayedIds([
      play(1, 5, "2026-11-26T10:05:00Z"), play(2, 5, "2026-11-26T11:00:00Z"),
      play(3, 6, "2026-11-26T12:30:00+02:00"), // 10:30 UTC: in
      play(4, 7, "2026-11-26T11:59:00+02:00"), // 09:59 UTC: out
    ], since);
    expect([...ids].sort()).toEqual([5, 6]);
  });

  test("no plays, no ids; an unreadable timestamp is not counted", () => {
    expect(sessionPlayedIds([], since).size).toBe(0);
    expect(sessionPlayedIds([play(1, 5, "not a date")], since).size).toBe(0);
  });
});

describe("relink: the declined answers in storage", () => {
  const original = (globalThis as { localStorage?: Storage }).localStorage;
  let store: Map<string, string>;
  const fake = (throws = false) => ({
    getItem: (k: string) => { if (throws) throw new Error("denied"); return store.get(k) ?? null; },
    setItem: (k: string, v: string) => { if (throws) throw new Error("quota"); store.set(k, v); },
  });
  beforeEach(() => {
    store = new Map();
    (globalThis as { localStorage?: unknown }).localStorage = fake();
  });
  afterEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = original;
  });

  test("saved answers come back in order", () => {
    saveDeclined(["1:11", "2:12"]);
    expect(loadDeclined()).toEqual(["1:11", "2:12"]);
  });

  test.each([
    ["{broken", []],
    ["{\"a\":1}", []],
    ["\"1:11\"", []],
    ["[\"1:11\", 3, null, \"2:12\"]", ["1:11", "2:12"]],
    ["[]", []],
  ] as const)("stored %p reads as %p", (raw, expected) => {
    store.set("cratemind-relink-declined", raw);
    expect(loadDeclined()).toEqual([...expected]);
  });

  test("nothing stored reads as no answers", () => {
    expect(loadDeclined()).toEqual([]);
  });

  test("storage that throws neither breaks loading nor saving", () => {
    (globalThis as { localStorage?: unknown }).localStorage = fake(true);
    expect(loadDeclined()).toEqual([]);
    expect(() => saveDeclined(["1:11"])).not.toThrow();
  });
});

describe("relink: scan messages", () => {
  const held = (root: string) => `${root}: λείπουν 30 από τα 40 tracks του φακέλου, δεν σημειώθηκε κανένα ότι λείπει (έλεγξε)`;

  test("two folders held back in one scan: both warnings, both roots, in order", () => {
    const message = `added 0, updated 0, unchanged 10, missing 0, skipped duplicates 0; ${held("/Volumes/Μουσική")}; ${held("C:\\Music")}`;
    const warnings = scanHeldBack(message);
    expect(warnings).toHaveLength(2);
    expect(heldBackRoots(warnings)).toEqual(["/Volumes/Μουσική", "C:\\Music"]);
  });

  test("a folder whose own name holds the marker keeps its full name", () => {
    expect(heldBackRoots([held("/Music/Folder: λείπουν τα παλιά")])).toEqual(["/Music/Folder: λείπουν τα παλιά"]);
  });

  test.each([
    ["Added 1, Updated 0, Unchanged 5, Missing 12, skipped duplicates 0", 12],
    ["missing 7", 7],
    ["added 1, premissing 4", 0],
    ["", 0],
    [null, 0],
  ] as const)("scanMissingCount(%p) is %p", (message, count) => {
    expect(scanMissingCount(message)).toBe(count);
  });
});

describe("track menu: the own-set label and the track line", () => {
  const ctx = (over: Partial<TrackMenuContext> = {}): TrackMenuContext => ({
    profile: "dj", deckPlaying: { A: false, B: false }, mixRunning: false, sets: [], ownSetId: 2, ownSetTitle: "Open",
    addToOwnSet: () => {}, addToSet: () => {}, newSet: () => {}, copy: () => {}, ...over,
  });
  const ownLabel = (title: string) => {
    const entries = trackMenuEntries(track({ title: "t" }), ctx({ ownSetTitle: title }));
    const hit = entries.find((e): e is Extract<MenuEntry, { label: string }> => e.type !== "separator" && e.label.startsWith("Προσθήκη στο «"));
    if (!hit) throw new Error("no own-set entry");
    return hit.label;
  };

  test("a title of exactly 28 characters is shown whole; 29 is cut to 27 and an ellipsis", () => {
    const t28 = "a".repeat(28);
    expect(ownLabel(t28)).toBe(`Προσθήκη στο «${t28}»`);
    expect(ownLabel(`${t28}b`)).toBe(`Προσθήκη στο «${"a".repeat(27)}…»`);
  });

  test("a Greek title with accents is cut by characters, keeping the closing quote", () => {
    const title = "Ψυχεδέλεια στο Κεραμεικό — Σάββατο βράδυ";
    expect(ownLabel(title)).toBe(`Προσθήκη στο «${title.slice(0, 27)}…»`);
  });

  test.each([
    [{ artist: "Άστριξ", title: "Βαθιά ζούγκλα", file_name: "x.flac" }, "Άστριξ – Βαθιά ζούγκλα"],
    [{ artist: null, title: "Μόνο τίτλος", file_name: "x.flac" }, "Μόνο τίτλος"],
    [{ artist: "", title: "", file_name: "01 - Ίντρο.flac" }, "01 - Ίντρο.flac"],
    [{ artist: "A", title: null, file_name: "f.mp3" }, "A – f.mp3"],
  ] as [Pick<Track, "artist" | "title" | "file_name">, string][])("trackLine(%p) is %p", (fields, line) => {
    expect(trackLine(fields)).toBe(line);
  });
});

describe("eitherMenu with one side missing", () => {
  const item = (label: string): MenuEntry => ({ type: "item", label, onSelect: () => {} });

  test("a target for the missing side shows nothing and reaches no source", () => {
    let opened = 0;
    const menu = eitherMenu<string, number>({ entries: s => [item(s)], onOpenChange: () => { opened++; } }, undefined);
    expect(menu).toBeDefined();
    expect(menu!.entries({ second: 3 })).toEqual([]);
    menu!.onOpenChange?.(true, { second: 3 });
    expect(opened).toBe(0);
    expect(menu!.entries({ first: "play" }).map(e => (e.type === "separator" ? "—" : e.label))).toEqual(["play"]);
  });
});
