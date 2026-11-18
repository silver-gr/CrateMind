import { expect, test } from "bun:test";
import { DEFAULT_PREFS, isLibraryPanelTab, normalizeFacetPanel } from "../src/lib/prefs";

test("a panel pref stored before the tabs reads as «Φίλτρα» and keeps its fields", () => {
  expect(normalizeFacetPanel({ open: true, collapsed: ["bpm"] })).toEqual({ open: true, collapsed: ["bpm"], tab: "filters" });
  expect(normalizeFacetPanel({ open: true, collapsed: [], tab: "bogus" as never })).toEqual({ open: true, collapsed: [], tab: "filters" });
  expect(normalizeFacetPanel({ open: false, collapsed: [], tab: "history" }).tab).toBe("history");
  expect(normalizeFacetPanel(undefined)).toEqual(DEFAULT_PREFS.libraryFacetPanel);
});

test("only the three tab names are panel tabs (an unknown ?panel= is ignored)", () => {
  expect(["filters", "artists", "history"].every(isLibraryPanelTab)).toBe(true);
  expect(isLibraryPanelTab("crates")).toBe(false);
  expect(isLibraryPanelTab(undefined)).toBe(false);
});
