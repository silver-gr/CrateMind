import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { LibraryTools } from "../src/components/LibraryTools";
import { PanelTabs } from "../src/components/library/PanelTabs";
import { Tabs } from "../src/components/ui/tabs";
import { Plus } from "../src/lib/icons";

const noop = () => {};
const toolsProps = {
  sets: [],
  activeSetId: null,
  onActiveSetChange: noop,
  onCreateSet: noop,
  canSaveCrate: false,
  onSaveCrate: noop,
  pendingSoundCloud: 7,
};

test("«Εργαλεία βιβλιοθήκης» is a plain section body, independent of any selected track", () => {
  const html = renderToStaticMarkup(<LibraryTools {...toolsProps} />);

  expect(html).not.toContain("<details");
  expect(html).toContain("Ενεργό set");
  expect(html).toContain("Νέο set");
  expect(html).toMatch(/<button[^>]*\sdisabled=""[^>]*>.*Αποθήκευση ως crate/);
  expect(html).toContain("Στήλες");
  expect(html).toContain("Επαναφορά μεγεθών");
  expect(html).not.toContain("Έλεγχος SoundCloud");
});

test("the SoundCloud review control and pending count follow provider availability", () => {
  const html = renderToStaticMarkup(<LibraryTools {...toolsProps} onReviewSoundCloud={noop} />);

  expect(html).toContain("Έλεγχος SoundCloud");
  expect(html).toContain(">7</span>");
});

test("the Library sidebar tabs stay mounted, and the drawers are DJ-only", () => {
  const library = readFileSync(new URL("../src/pages/Library.tsx", import.meta.url), "utf8");
  // forceMount keeps the editor's draft and a crate's analysis dialog alive across tab switches.
  expect(library.match(/<TabsContent value="(track|crates|sets)" forceMount className="data-\[state=inactive\]:hidden">/g)).toHaveLength(3);
  expect(library).toContain('hidden={!selected || tab !== "track"}');
  // The list reloads on the query only, so stripping ?tab= never refetches or clears the selection.
  expect(library).toContain("}, [appliedQuery, load]);");
  expect(library).toContain('next.delete("tab");');
  expect(library.match(/\{isDj && \(/g)).toHaveLength(2);
  // «Flow Finder» is a button among the track card's own, so it exists only with a selected track, and only for a DJ.
  expect(library).toContain('flowFinder={isDj ? { open: drawer === "flow", controls: "library-flow-drawer"');
  expect(library).not.toContain("διάλεξε Track A");
  // The tools left the inspector for the toolbar's third section.
  expect(library.indexOf("<LibraryTools")).toBeLessThan(library.indexOf("<PageRail inline={!wide}>"));
  const flow = readFileSync(new URL("../src/components/FlowFinderPanel.tsx", import.meta.url), "utf8");
  // Track A is local: picking or clearing it never loads or ejects a deck.
  expect(flow).not.toContain('load("A"');
  expect(flow).not.toContain("eject(");
});

test("the side panel keeps its three tabs mounted and opens from one toolbar button per tab", () => {
  const library = readFileSync(new URL("../src/pages/Library.tsx", import.meta.url), "utf8");
  const panel = readFileSync(new URL("../src/components/library/LibrarySidePanel.tsx", import.meta.url), "utf8");
  expect(panel.match(/<TabsContent value="(filters|artists|history)" forceMount tabIndex=\{-1\} className="flex min-h-0 flex-1 flex-col data-\[state=inactive\]:hidden">/g)).toHaveLength(3);
  // A tab is active only while it shows; the handle shows only while the panel is static.
  for (const tab of ["filters", "artists", "history"]) expect(panel).toContain(`active={open && tab === "${tab}"}`);
  expect(panel).toContain('className={cn("absolute inset-y-0 -right-1.5 z-30", railed ? "flex" : "hidden lg:flex")}');
  expect(panel).toContain('storageKey: "cm:library-panel-width"');
  // Toggle buttons: aria-pressed, never aria-expanded; ?panel= opens a tab, then leaves the URL.
  expect(library).toContain('aria-pressed={facetPanel.open && facetPanel.tab === value} aria-controls="library-facet-panel" title={label}');
  expect(library).not.toContain("aria-expanded={facetPanel.open}");
  expect(library).toContain('next.delete("panel");');
  expect(library).toContain("toggleFieldValue(appliedQuery, \"artist\", name)");
});

test("PanelTabs sizes its columns and pill from the tab count, inspector and side panel alike", () => {
  const tabs = [{ value: "a", label: "Α" }, { value: "b", label: "Β" }, { value: "c", label: "Γ" }, { value: "d", label: "Δ" }];
  const html = renderToStaticMarkup(<Tabs value="c"><PanelTabs tabs={tabs} value="c" ariaLabel="Δοκιμή" /></Tabs>);
  expect(html).toContain('aria-label="Δοκιμή"');
  expect(html).toContain("grid-template-columns:repeat(4, minmax(0, 1fr))");
  expect(html).toContain("width:calc((100% - 6px) / 4);transform:translateX(200%)");
  // An unknown value parks the pill on the first tab.
  expect(renderToStaticMarkup(<Tabs value="x"><PanelTabs tabs={tabs} value="x" ariaLabel="Δοκιμή" /></Tabs>)).toContain("translateX(0%)");
  const library = readFileSync(new URL("../src/pages/Library.tsx", import.meta.url), "utf8");
  expect(library).toContain('<PanelTabs tabs={SIDEBAR_TABS} value={tab} ariaLabel="Καρτέλες εργαλείων" />');
  // Only the active tab is a tab stop; the list itself never is (a stale roving stop could switch the tab).
  expect(html).toMatch(/role="tablist"[^>]*tabindex="-1"/);
  expect(html.match(/role="tab"[^>]*tabindex="0"/g)).toHaveLength(1);
  expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*tabindex="0"/);
});

test("the inspector's tabs read «Κομμάτι», «Crates» and «Sets», each with an icon, as the side panel's tabs do", () => {
  const library = readFileSync(new URL("../src/pages/Library.tsx", import.meta.url), "utf8");
  expect(library).toContain('{ value: "sets", label: "Sets", icon: ListMusic }');
  expect(library).not.toContain("Sets/Playlist");
  const panel = readFileSync(new URL("../src/components/library/LibrarySidePanel.tsx", import.meta.url), "utf8");
  for (const icon of ["SlidersHorizontal", "UserRound", "HistoryIcon"]) expect(panel).toContain(`icon: ${icon} }`);
  const tabs = [{ value: "a", label: "Κομμάτι", icon: Plus }, { value: "b", label: "Crates" }];
  const html = renderToStaticMarkup(<Tabs value="a"><PanelTabs tabs={tabs} value="a" ariaLabel="Δοκιμή" /></Tabs>);
  // The icon shows from a 17.5rem row (a 320 px panel) with tighter, smaller triggers; from 20rem the triggers take their usual size.
  expect(html.match(/<svg/g)).toHaveLength(1);
  expect(html).toContain("hidden size-[11px] shrink-0 @min-[17.5rem]/panel-tabs:block @min-[20rem]/panel-tabs:size-3");
});
