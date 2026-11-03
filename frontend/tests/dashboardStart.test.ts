import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  ATTENTION_QUERIES,
  RECENT_PLAYS_QUERY,
  latestSet,
  libraryHref,
  recentPlays,
  resolveMainCrate,
  toggleMainCrate,
} from "../src/lib/dashboardStart";
import { DEFAULT_PREFS } from "../src/lib/prefs";
import type { DJSet, SavedSearch, Track } from "../src/lib/types";

const crate = (id: number, name: string, query: string, count: number): SavedSearch =>
  ({ id, name, query, pinned: false, sort_order: 0, count });

const track = (id: number, last_played_at: string | null): Track =>
  ({ id, absolute_path: `/t${id}.wav`, file_name: `t${id}.wav`, last_played_at } as unknown as Track);

describe("main crate", () => {
  const crates = [crate(1, "Peak", "energy:8+", 40), crate(2, "Ζέσταμα", "role:warmup", 225)];

  test("defaults to no main crate in the prefs blob", () => {
    expect(DEFAULT_PREFS.mainCrateId).toBeNull();
  });

  test("a set main crate shows its name, query and live count", () => {
    expect(resolveMainCrate(crates, 2, 12)).toEqual(
      { id: 2, name: "Ζέσταμα", query: "role:warmup", count: 225, fallback: false });
  });

  test("a deleted main crate falls back to «Όπλα»", () => {
    expect(resolveMainCrate(crates, 99, 12)).toEqual(
      { id: null, name: "Όπλα", query: "weapons", count: 12, fallback: true });
  });

  test("no main crate falls back to «Όπλα» with its real count (or unknown)", () => {
    expect(resolveMainCrate(crates, null, 7).query).toBe("weapons");
    expect(resolveMainCrate([], null, null)).toMatchObject({ name: "Όπλα", count: null, fallback: true });
  });

  test("the star sets a crate and clicking the active star clears it", () => {
    expect(toggleMainCrate(null, 3)).toBe(3);
    expect(toggleMainCrate(2, 3)).toBe(3);
    expect(toggleMainCrate(3, 3)).toBeNull();
  });
});

describe("continue", () => {
  test("recent plays: newest first, never-played dropped, top 8", () => {
    const rows = [
      track(1, "2026-10-01T10:00:00"),
      track(2, null),
      track(3, "2026-11-02T22:15:00"),
      track(4, "2026-10-20T09:00:00"),
      ...Array.from({ length: 8 }, (_, i) => track(10 + i, `2026-09-0${i + 1}T00:00:00`)),
    ];
    const out = recentPlays(rows);
    expect(out).toHaveLength(8);
    expect(out.slice(0, 3).map((t) => t.id)).toEqual([3, 4, 1]);
    expect(out.some((t) => t.id === 2)).toBe(false);
    expect(rows[0].id).toBe(1); // input untouched
  });

  test("the recent-play query is a real search field, not free text", () => {
    expect(RECENT_PLAYS_QUERY).toBe("played_recently:30");
  });

  test("latest set is the newest one, null when there are none", () => {
    const sets: DJSet[] = [{ id: 4, title: "Β" }, { id: 9, title: "Γ" }, { id: 1, title: "Α" }];
    expect(latestSet(sets)?.id).toBe(9);
    expect(latestSet([])).toBeNull();
  });
});

describe("attention queries", () => {
  test("open the Library with the agreed queries", () => {
    expect(ATTENTION_QUERIES.map((q) => q.query)).toEqual(["-bpm:0+", "bpm:200+", "untagged added:30"]);
    expect(libraryHref("-bpm:0+")).toBe("/library?q=-bpm%3A0%2B");
    expect(libraryHref("")).toBe("/library");
  });
});

describe("start screen source contracts", () => {
  const dashboard = readFileSync(new URL("../src/pages/Dashboard.tsx", import.meta.url), "utf8");
  const crates = readFileSync(new URL("../src/pages/Crates.tsx", import.meta.url), "utf8");

  test("no FLAGSHIP_QUERY and no cosmetic waveform remain", () => {
    expect(dashboard).not.toContain("FLAGSHIP_QUERY");
    expect(dashboard).not.toMatch(/<Waveform\b/);
    expect(dashboard).not.toContain("components/ui/Waveform");
  });

  test("both pages have a main-crate star toggle with aria-pressed", () => {
    for (const page of [dashboard, crates]) {
      expect(page).toMatch(/aria-pressed=\{[^}]*mainCrateId/);
      expect(page).toContain("Ορισμός ως κύριο crate");
      expect(page).toContain("toggleMainCrate(");
    }
  });

  test("the hero, its Play and «Library →» use the resolved main crate", () => {
    expect(dashboard).toContain("resolveMainCrate(");
    expect(dashboard).toMatch(/api\.listTracks\(hero\.query, 1\)/);
    expect(dashboard).toContain("Όρισε ένα crate ως κύριο με το ☆");
  });

  test("the backup import still drops the cached vocabularies", () => {
    expect(dashboard).toMatch(/await api\.importBackup\(payload\);\s*notifyFacetsChanged\(\);/);
  });
});
