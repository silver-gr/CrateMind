import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { LibraryToolbarTabHeadings, LibraryToolbarTabPanels } from "../src/components/library/LibraryToolbarTabs";
import { LIBRARY_TOOLBAR_TABS, normalizeToolbarTab, toggleToolbarTab } from "../src/lib/libraryToolbar";
import { DEFAULT_PREFS } from "../src/lib/prefs";

const noop = () => {};

test("one section open at a time: a heading opens its own, closes the open one, and closes itself", () => {
  expect(toggleToolbarTab(null, "presets")).toBe("presets");
  expect(toggleToolbarTab("presets", "bulk")).toBe("bulk");
  expect(toggleToolbarTab("bulk", "tools")).toBe("tools");
  expect(toggleToolbarTab("tools", "tools")).toBeNull();
  for (const tab of LIBRARY_TOOLBAR_TABS) expect(toggleToolbarTab(tab, tab)).toBeNull();
});

test("the open section is remembered as a pref; anything unknown reads as all closed", () => {
  expect(DEFAULT_PREFS.libraryToolbarTab).toBeNull();
  expect(normalizeToolbarTab("bulk")).toBe("bulk");
  for (const stored of [undefined, null, "", "filters", 3, {}]) expect(normalizeToolbarTab(stored)).toBeNull();
});

test("the headings are disclosure buttons; only the open one points at its body", () => {
  const html = renderToStaticMarkup(<LibraryToolbarTabHeadings open="tools" onToggle={noop} selectedCount={0} />);
  expect(html.match(/aria-expanded="true"/g)).toHaveLength(1);
  expect(html.match(/aria-expanded="false"/g)).toHaveLength(2);
  expect(html).toMatch(/aria-expanded="true" aria-controls="library-toolbar-tools"/);
  expect(html.match(/aria-controls=/g)).toHaveLength(1);
  for (const label of ["Έτοιμα φίλτρα", "Μαζική επεξεργασία", "Εργαλεία βιβλιοθήκης"]) expect(html).toContain(label);
  // No checked rows, no count.
  expect(html).not.toContain("επιλεγμένα");
});

test("checked rows show their count on «Μαζική επεξεργασία», open or closed", () => {
  for (const open of [null, "bulk"] as const) {
    const html = renderToStaticMarkup(<LibraryToolbarTabHeadings open={open} onToggle={noop} selectedCount={1234} />);
    const bulk = html.match(/<button[^>]*data-toolbar-tab="bulk"[^>]*>(?:(?!<\/button>).)*<\/button>/)?.[0] ?? "";
    expect(bulk).toContain('title="1234 επιλεγμένα"');
    expect(bulk).toContain(">1.234</span>");
    expect(bulk).toContain('<span class="sr-only"> επιλεγμένα</span>');
  }
});

test("the bodies share one place: the open one shows, the bulk editor stays mounted while closed, the rest unmount", () => {
  const panels = { presets: <p>προεπιλογές</p>, bulk: <p>μαζική</p>, tools: <p>εργαλεία</p> };
  const closed = renderToStaticMarkup(<LibraryToolbarTabPanels open={null} panels={panels} keepMounted={["bulk"]} />);
  expect(closed).toContain("μαζική");
  expect(closed).toMatch(/<section id="library-toolbar-bulk"[^>]*hidden=""/);
  expect(closed).not.toContain("προεπιλογές");
  expect(closed).not.toContain("εργαλεία");

  const tools = renderToStaticMarkup(<LibraryToolbarTabPanels open="tools" panels={panels} keepMounted={["bulk"]} />);
  expect(tools).toMatch(/<section id="library-toolbar-tools" aria-label="Εργαλεία βιβλιοθήκης" class="[^"]*">/);
  expect(tools).not.toMatch(/<section id="library-toolbar-tools"[^>]*hidden/);
  expect(tools).toMatch(/<section id="library-toolbar-bulk"[^>]*hidden=""/);
  expect(tools).not.toContain("προεπιλογές");
});

test("the Library keeps one toolbar state and opens «Μαζική επεξεργασία» from the track menu", () => {
  const library = readFileSync(new URL("../src/pages/Library.tsx", import.meta.url), "utf8");
  expect(library).toContain('const [toolbarTab, setToolbarTab] = usePref("libraryToolbarTab");');
  expect(library).toContain("onToggle={next => setToolbarTab(toggleToolbarTab(toolbarTab, next))}");
  expect(library).toContain('setPref("libraryToolbarTab", "bulk");');
  expect(library).toContain('keepMounted={["bulk"]}');
  expect(library).not.toContain("library-bulk-actions");
  // The search keeps at least 220 px (13.75rem) and grows into what the chips and toggles leave.
  expect(library).toContain('className="@container/search min-w-[min(100%,13.75rem)] flex-[1_1_13.75rem]"');
});
