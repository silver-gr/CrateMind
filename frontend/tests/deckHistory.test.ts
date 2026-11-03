import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DECK_HISTORY_CAP, collectDeckTracks, recordDeckLoad, relativeTime, type DeckLoad } from "../src/lib/deckHistory";
import { continueColumnCount } from "../src/lib/dashboardStart";
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

describe("collectDeckTracks", () => {
  const ok = (id: number): PromiseSettledResult<{ track: { id: number } }> => ({ status: "fulfilled", value: { track: { id } } });
  const fail = (message: string): PromiseSettledResult<{ track: { id: number } }> => ({ status: "rejected", reason: new Error(message) });

  test("skips deleted tracks (404) without an error", () => {
    const { found, failed } = collectDeckTracks([ok(1), fail("404: Not Found"), ok(3)]);
    expect([...found.keys()]).toEqual([1, 3]);
    expect(failed).toBe(false);
  });

  test("any other failure is an error, not «nothing loaded yet»", () => {
    expect(collectDeckTracks([fail("500: Internal Server Error")]).failed).toBe(true);
    expect(collectDeckTracks([ok(1), fail("Failed to fetch")]).failed).toBe(true);
  });
});

describe("«Συνέχεια» columns", () => {
  test("two columns only when each card keeps at least 560px", () => {
    expect(continueColumnCount(0)).toBe(1);
    expect(continueColumnCount(884)).toBe(1); // 1536px viewport, default sidebar and rail
    expect(continueColumnCount(1131)).toBe(1);
    expect(continueColumnCount(1132)).toBe(2);
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

  test("«Συνέχεια» sizes its columns from its own width, not the viewport", () => {
    expect(dashboard).toContain("new ResizeObserver(");
    expect(dashboard).toContain("continueColumnCount(continueWidth)");
    expect(dashboard).not.toContain("useMediaQuery(\"(min-width: 1536px)\")");
  });

  test("the deck/time meta truncates instead of hiding the artist or spilling into BPM", () => {
    const row = dashboard.slice(dashboard.indexOf("function ContinueRow"));
    expect(row).toContain('"min-w-0 flex-1 overflow-hidden"');
    expect(row).toContain('"max-w-[60%] shrink-0 truncate text-cm-faint"');
  });

  test("«Συνέχεια» patches BPM fixes, refetches after analysis and shows a load error", () => {
    expect(dashboard).toContain("window.addEventListener(BPM_UPDATED, onBpmUpdated)");
    expect(dashboard).toContain("window.addEventListener(ANALYSIS_FINISHED, onAnalysisFinished)");
    expect(dashboard).toContain("[deckLoadIds, analysisTick]");
    expect(dashboard).toContain("Δεν ήταν δυνατή η φόρτωση των πρόσφατων φορτώσεων.");
  });

  test("prefs drop the per-tab cache when another tab writes the blob", () => {
    const prefs = source("lib/prefs.ts");
    expect(prefs).toMatch(/addEventListener\("storage"[\s\S]*?cache = null;/);
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
