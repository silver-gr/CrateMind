import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { LibraryBulkActions, LibraryTools } from "../src/components/LibraryTools";
import { PanelTabs } from "../src/components/library/PanelTabs";
import { Tabs } from "../src/components/ui/tabs";

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

test("Library tools are a closed disclosure independent of any selected track", () => {
  const html = renderToStaticMarkup(<LibraryTools {...toolsProps} />);
  const [summary, contents] = html.split("</summary>");

  expect(summary).toContain("Εργαλεία βιβλιοθήκης");
  expect(html).not.toMatch(/<details[^>]*\sopen(?:\s|=|>)/);
  expect(contents).toContain("Ενεργό set");
  expect(contents).toContain("Νέο set");
  expect(contents).toMatch(/<button[^>]*\sdisabled=""[^>]*>.*Αποθήκευση ως crate/);
  expect(contents).toContain("Στήλες");
  expect(contents).toContain("Επαναφορά μεγεθών");
  expect(contents).not.toContain("Έλεγχος SoundCloud");
});

test("the SoundCloud review control and pending count follow provider availability", () => {
  const html = renderToStaticMarkup(<LibraryTools {...toolsProps} onReviewSoundCloud={noop} />);

  expect(html).toContain("Έλεγχος SoundCloud");
  expect(html).toContain(">7</span>");
});

test("the bulk disclosure keeps the editor mounted and shows selection when closed", () => {
  const html = renderToStaticMarkup(
    <LibraryBulkActions selectedIds={new Set([2, 3])} query="bpm:170" onApplied={noop} canAnalyze />,
  );
  const [summary, contents] = html.split("</summary>");

  expect(html).not.toMatch(/<details[^>]*\sopen(?:\s|=|>)/);
  expect(summary).toContain("Μαζική επεξεργασία");
  expect(summary).toContain(">2</span>");
  expect(summary).toContain("επιλεγμένα");
  expect(contents).toContain("Επιλεγμένα (2)");
  expect(contents).toContain("Όλα τα αποτελέσματα");
  expect(contents).toContain("Ανάλυση BPM");
});

test("the Library sidebar tabs stay mounted, and the drawers are DJ-only", () => {
  const library = readFileSync(new URL("../src/pages/Library.tsx", import.meta.url), "utf8");
  // forceMount keeps the editor's draft and a crate's analysis dialog alive across tab switches.
  expect(library.match(/<TabsContent value="(track|crates|sets)" forceMount className="data-\[state=inactive\]:hidden">/g)).toHaveLength(3);
  expect(library).toContain('hidden={!selected || tab !== "track"}');
  // The list reloads on the query only, so stripping ?tab= never refetches or clears the selection.
  expect(library).toContain("}, [appliedQuery, load]);");
  expect(library).toContain('next.delete("tab");');
  expect(library.match(/\{isDj && \(/g)).toHaveLength(3);
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
  expect(library).toContain('aria-pressed={facetPanel.open && facetPanel.tab === value} aria-controls="library-facet-panel"');
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
