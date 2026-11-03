import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { quickLists, therapyStats } from "../src/lib/dashboardTherapy";
import { progressLine } from "../src/lib/queuePaging";
import type { SavedSearch } from "../src/lib/types";

const crate = (id: number, name: string, pinned: boolean, sort_order: number): SavedSearch =>
  ({ id, name, query: "purpose:χαλάρωση", pinned, sort_order, count: id });

describe("quickLists", () => {
  test("keeps pinned crates only, ordered by sort_order then name", () => {
    const out = quickLists([
      crate(1, "Ύπνος", true, 2),
      crate(2, "Αδέσμευτο", false, 0),
      crate(3, "Βραδινά", true, 1),
      crate(4, "Αναπνοή", true, 1),
      crate(5, "Ζέσταμα", true, 0),
    ]);
    expect(out.map(c => c.id)).toEqual([5, 4, 3, 1]);
  });

  test("does not mutate the input and returns [] with nothing pinned", () => {
    const input = [crate(1, "Β", false, 1), crate(2, "Α", false, 0)];
    expect(quickLists(input)).toEqual([]);
    expect(input.map(c => c.id)).toEqual([1, 2]);
  });
});

describe("therapy dashboard stats", () => {
  const STATS = [
    { key: "tracks", label: "Tracks", query: "" },
    { key: "approved", label: "Εγκεκριμένα", query: "status:approved" },
    { key: "weapons", label: "Bangers", query: "weapons" },
    { key: "untagged", label: "Χωρίς tags", query: "untagged" },
  ];

  test("drop weapons, count approved with weapons and call untagged «Αταξινόμητα»", () => {
    const out = therapyStats(STATS);
    expect(out.map(s => s.key)).toEqual(["tracks", "approved", "untagged"]);
    expect(out.find(s => s.key === "approved")?.query).toBe("status:approved,weapon");
    expect(out.find(s => s.key === "untagged")?.label).toBe("Αταξινόμητα");
    expect(out.some(s => s.label === "Bangers" || s.query === "weapons")).toBe(false);
    expect(STATS[1].query).toBe("status:approved"); // input untouched
  });

  test("items without a query (tiles) keep having none", () => {
    const out = therapyStats([{ key: "weapons", label: "Bangers" }, { key: "untagged", label: "Χωρίς tags" }]);
    expect(out).toEqual([{ key: "untagged", label: "Αταξινόμητα" }]);
  });

  test("the tagged tile uses the progress line's word, not the DJ «Με tags»", () => {
    const out = therapyStats([{ key: "tagged", label: "Με tags" }, { key: "untagged", label: "Χωρίς tags" }]);
    expect(out.map(s => s.label)).toEqual(["Ταξινομημένα", "Αταξινόμητα"]);
    expect(progressLine(1, 2)).toStartWith("Ταξινομημένα");
  });

  test("the sorting progress line uses the existing stats", () => {
    expect(progressLine(6800 - 5560, 6800)).toBe("Ταξινομημένα 1.240 / 6.800");
  });
});

describe("Dashboard source contract", () => {
  const page = readFileSync(new URL("../src/pages/Dashboard.tsx", import.meta.url), "utf8");

  test("therapy issues no standalone weapons count and skips the review queues", () => {
    expect(page).toMatch(/const statDefs = therapy \? therapyStats\(STATS\) : STATS;/);
    expect(page).toMatch(/statDefs\.map\(/);
    expect(page).not.toMatch(/STATS\.map\(/);
    expect(page).toMatch(/therapy \? \[\] : QUEUES/);
  });

  test("therapy renders no «Bangers»: tiles filtered, hero and IntelRow guarded", () => {
    expect(page).toMatch(/const tiles = therapy \? therapyStats\(TILES\) : TILES;/);
    expect(page).toMatch(/\{!therapy && \(\s*<ElectricFrame>/);
    expect(page).toMatch(/\{!therapy && \(\s*<IntelRow\s+label="Bangers \/ σύνολο"/);
    expect(page).toMatch(/\{!therapy && \(\s*<button[\s\S]{0,200}?libraryHref\(hero\.query\)[\s\S]{0,600}?Κύριο Crate/);
  });

  test("quick lists never print the crate query and offer no delete", () => {
    const start = page.indexOf("Γρήγορες λίστες");
    expect(start).toBeGreaterThan(-1);
    // The block runs to the DJ Memory Crates heading that follows it; indexOf from
    // `start`, because «Memory Crates» also appears earlier in the file.
    const end = page.indexOf("Memory Crates", start);
    expect(end).toBeGreaterThan(start);
    const block = page.slice(start, end);
    expect(block.length).toBeGreaterThan(200);
    expect(block).toContain("quickLists(crates)");
    expect(block).not.toMatch(/c\.query\s*\|\|/);
    expect(block).not.toMatch(/\{c\.query\}/);
    expect(block).not.toMatch(/handleDeleteCrate/);
    expect(page).toContain("Καρφίτσωσε ένα crate για να εμφανιστεί εδώ.");
  });

  test("quick-list cards open from the keyboard and name the list they unpin", () => {
    const start = page.indexOf("{quickLists(crates).map(");
    expect(start).toBeGreaterThan(-1);
    const block = page.slice(start, page.indexOf("</GlassCard>", start));
    expect(block).toMatch(/role="link"\s+tabIndex=\{0\}/);
    expect(block).toMatch(/onKeyDown=\{\(e\) => \{ if \(e\.key === "Enter"/);
    expect(block).toContain("aria-label={`Ξεκαρφίτσωσε: ${c.name}`}");
    // The link names the list and its count, as the card shows them.
    expect(block).toContain('aria-label={`${c.name} — ${c.count.toLocaleString("el-GR")} tracks`}');
    expect(page).toContain('"1 λίστα"');
  });
});
