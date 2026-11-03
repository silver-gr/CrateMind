import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DECK_HISTORY_CAP, recordDeckLoad, relativeTime, type DeckLoad } from "../src/lib/deckHistory";
import { DEFAULT_PREFS } from "../src/lib/prefs";
import { dealColumns } from "../src/lib/masonry";

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

describe("recordDeckLoad", () => {
  test("defaults to an empty list in the prefs blob", () => {
    expect(DEFAULT_PREFS.recentDeckLoads).toEqual([]);
  });

  test("newest first", () => {
    let list: DeckLoad[] = [];
    list = recordDeckLoad(list, 1, "A", 100);
    list = recordDeckLoad(list, 2, "B", 200);
    list = recordDeckLoad(list, 3, "A", 300);
    expect(list.map((e) => e.id)).toEqual([3, 2, 1]);
    expect(list[0]).toEqual({ id: 3, deck: "A", at: 300 });
  });

  test("keeps only the newest entry per track", () => {
    let list: DeckLoad[] = [];
    list = recordDeckLoad(list, 1, "A", 100);
    list = recordDeckLoad(list, 2, "A", 200);
    list = recordDeckLoad(list, 1, "B", 300);
    expect(list).toEqual([{ id: 1, deck: "B", at: 300 }, { id: 2, deck: "A", at: 200 }]);
  });

  test("caps the list at 20 and leaves the input untouched", () => {
    let list: DeckLoad[] = [];
    for (let i = 1; i <= 25; i++) list = recordDeckLoad(list, i, "A", i);
    expect(DECK_HISTORY_CAP).toBe(20);
    expect(list).toHaveLength(20);
    expect(list[0].id).toBe(25);
    expect(list[19].id).toBe(6);
    const before = [...list];
    recordDeckLoad(list, 99, "B", 99);
    expect(list).toEqual(before);
  });

  test("relative time in Greek", () => {
    const now = 10_000_000;
    expect(relativeTime(now - 20_000, now)).toBe("μόλις τώρα");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("πριν 5 λ.");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("πριν 3 ώ.");
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("πριν 2 ημ.");
  });
});

describe("masonry", () => {
  test("deals items left to right into column stacks", () => {
    expect(dealColumns(["a", "b", "c"], 2)).toEqual([["a", "c"], ["b"]]);
    expect(dealColumns(["a", "b", "c"], 1)).toEqual([["a", "b", "c"]]);
  });
});

describe("deck history source contracts", () => {
  const player = source("lib/player.tsx");
  const dashboard = source("pages/Dashboard.tsx");

  test("PlayerProvider's load records every committed deck load", () => {
    const load = player.slice(player.indexOf("const load = ("), player.indexOf("const playRouted"));
    expect(load).toMatch(/commit\(next\);\s*rememberDeckLoad\(track\.id, deck\);\s*return true;/);
  });

  test("MiniPlayer does not record loads itself", () => {
    const mini = source("components/MiniPlayer.tsx");
    expect(mini).not.toContain("rememberDeckLoad");
    expect(mini).not.toContain("recentDeckLoads");
  });

  test("«Συνέχεια» shows deck loads, logged plays and the last set", () => {
    expect(dashboard).toContain("Φορτώθηκαν πρόσφατα");
    expect(dashboard).toContain("Σημειωμένα ως παιγμένα · 30 ημέρες");
    expect(dashboard).toContain("Τελευταίο set");
    expect(dashboard).toContain('usePref("recentDeckLoads")');
    expect(dashboard).toMatch(/api\.getTrack\(/);
    expect(dashboard).toContain("relativeTime(");
  });

  test("«Συνέχεια» rows colour tempo and key like the Library", () => {
    const row = dashboard.slice(dashboard.indexOf("function ContinueRow"));
    expect(row).toContain("const bpm = effectiveBpm(t);");
    expect(row).toContain("bpmColor(bpm)");
    expect(row).toContain("keyColor(");
    expect(row).toContain("formatKey(");
    expect(row).toMatch(/\} BPM`/);
    expect(row).toContain("→ Deck A");
    expect(row).toContain("→ Deck B");
    expect(dashboard.match(/<ContinueRow\b/g)?.length).toBe(2);
  });

  test("«Συνέχεια» cards use the masonry helper", () => {
    expect(dashboard).toContain('import { dealColumns } from "../lib/masonry"');
    expect(dashboard).toContain("dealColumns(");
    expect(source("pages/Artists.tsx")).toContain('import { dealColumns } from "../lib/masonry"');
  });

  test("the dashboard star shows on hover or focus, unless it marks the main crate", () => {
    const star = dashboard.slice(dashboard.indexOf("onClick={(e) => handleMainCrate(c, e)}"), dashboard.indexOf("<Star "));
    expect(star).toMatch(/\? "text-cm-amber hover:text-cm-text"/);
    expect(star).toContain("opacity-0");
    expect(star).toContain("group-hover:opacity-100");
    expect(star).toContain("group-focus-within:opacity-100");
    expect(star).not.toContain("opacity-40");
    expect(dashboard).toContain("Όρισε ένα crate ως κύριο με το ☆ που εμφανίζεται όταν περνάς πάνω από ένα crate");
  });
});
