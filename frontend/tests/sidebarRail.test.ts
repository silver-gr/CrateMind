import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const sidebar = read("../src/components/layout/Sidebar.tsx");
const settings = read("../src/pages/Settings.tsx");
const prefs = read("../src/lib/prefs.ts");
const css = read("../src/index.css");

describe("collapsed sidebar style", () => {
  test("defaults to the floating dock", () => {
    expect(prefs).toMatch(/sidebarCollapseStyle: "dock" \| "rail";/);
    expect(prefs).toMatch(/sidebarCollapseStyle: "dock",/);
  });

  test("Settings offers both styles in Greek", () => {
    expect(settings).toContain('usePref("sidebarCollapseStyle")');
    expect(settings).toContain("Σύμπτυξη πλαϊνής μπάρας");
    expect(settings).toContain('{ value: "dock", label: "Αιωρούμενη μπάρα" }');
    expect(settings).toContain('{ value: "rail", label: "Στενή πλαϊνή μπάρα" }');
  });

  test("the rail is an attached, scrollable aside on the left with right-side tooltips", () => {
    const start = sidebar.indexOf("if (rail) {");
    const end = sidebar.indexOf("// Collapsed → floating island nav bar");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = sidebar.slice(start, end);
    expect(block).toContain("<aside");
    expect(block).not.toContain("createPortal");
    expect(block).toMatch(/overflow-y-auto/);
    expect(block).toContain('side="right"');
    expect(block).toContain("<EdgeChevron collapse={false} onClick={() => setCollapsed(false)} />");
    // The dock stays the other branch, unchanged.
    expect(sidebar.slice(end)).toContain("createPortal(island, document.body)");
  });

  test("the «Σύμπτυξη» row is gone: a small chevron at the top right, above the logo, folds the sidebar", () => {
    const expanded = sidebar.slice(sidebar.indexOf("// Expanded → full sidebar"));
    expect(expanded).not.toContain(">Σύμπτυξη</span>");
    const chevron = expanded.indexOf('<div className="flex justify-end">\n          <EdgeChevron collapse onClick={() => setCollapsed(true)} />');
    expect(chevron).toBeGreaterThan(-1);
    expect(chevron).toBeLessThan(expanded.indexOf("<BrandMark />"));
    // Nothing is left under the nav list.
    expect(expanded).toContain("</motion.nav>\n    </aside>");
    // Same name as the old row, now also its tooltip; the rail's twin opens it again.
    expect(sidebar).toContain('const label = collapse ? "Σύμπτυξη πλαϊνής μπάρας" : "Ανάπτυξη πλαϊνής μπάρας";');
    expect(sidebar).toContain('<TooltipContent side="right">{label}</TooltipContent>');
  });

  test("the rail opens from the same chevron at its top, with search under the mark; the floating bar keeps its button", () => {
    const rail = sidebar.slice(sidebar.indexOf("if (rail) {"), sidebar.indexOf("// Collapsed → floating island nav bar"));
    const chevron = rail.indexOf("<EdgeChevron collapse={false}");
    expect(chevron).toBeGreaterThan(-1);
    expect(chevron).toBeLessThan(rail.indexOf("<BrandMark />"));
    expect(rail.indexOf('label="Αναζήτηση (⌘K)"')).toBeLessThan(rail.indexOf("<nav"));
    expect(rail.slice(rail.indexOf("</nav>"))).not.toContain("IslandButton");
    const island = sidebar.slice(sidebar.indexOf("// Collapsed → floating island nav bar"), sidebar.indexOf("// Expanded → full sidebar"));
    expect(island).toMatch(/label="Ανάπτυξη πλαϊνής μπάρας"\s+tip="Ανάπτυξη πλαϊνής μπάρας"\s+icon=\{PanelLeft\}/);
  });

  test("collapsing morphs the width and cascades the icons, and both respect reduced motion", () => {
    expect(sidebar).toMatch(/transition: morph\?\.animate \? `width \$\{RAIL_MORPH_MS\}ms/);
    expect(sidebar).toContain("prefersReducedMotion()");
    expect(sidebar).toContain('className="cm-rail-in"');
    expect(css).toMatch(/@keyframes cm-rail-in/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.cm-rail-in \{ animation: none; \}/);
  });

  test("the morph is short and the in-app reduced-motion pref skips it", () => {
    expect(sidebar).toContain("export const RAIL_MORPH_MS = 300;");
    expect(sidebar).toContain("--ease-drawer");
    expect(sidebar).toContain('document.documentElement.hasAttribute("data-reduce-motion")');
    expect(css).toMatch(/\.cm-rail-in \{ animation: cm-rail-in 280ms var\(--ease-out\) both; \}/);
    const shellCss = read("../src/styles/shell.css");
    expect(shellCss).toContain(":root[data-reduce-motion] .cm-rail-in { animation: none; }");
  });

  test("«Ένταση ακρόασης» left the sidebar's three places for the top bar", () => {
    expect(sidebar).not.toContain("AudioSettingsButton");
    expect(read("../src/components/layout/AppearanceControls.tsx")).not.toContain("AudioSettingsButton");
    expect(read("../src/components/layout/TopBar.tsx")).toContain("<LoudnessBarButton outside={outside} />");
  });

  test("the theme toggle and the background chooser left the footer, the rail and the island for the top bar", () => {
    expect(sidebar).not.toContain("ThemeToggle");
    expect(sidebar).not.toContain("BackgroundSettingsButton");
    expect(read("../src/components/layout/TopBar.tsx")).toContain("<BackgroundSettingsButton ");
  });

  test("the brand mark keeps one size in every mode: it scales with the window height, never with the deck mode", () => {
    expect(sidebar).toContain('className="block size-[clamp(72px,14dvh,160px)] max-w-full shrink-0 overflow-hidden"');
    expect(sidebar).not.toContain("size-[72px]");
    expect(sidebar).not.toContain("useTwoDeck");
  });

  test("the sidebar is 232 px, the narrowest at which every top-level label fits on one line", () => {
    // 150 px under the old 330 would cut «Χαρακτηρισμός tracks» (225 px) and «Χάρτης συναισθήματος» (234, its row 1 px into the padding).
    expect(sidebar).toContain("export const SIDEBAR_WIDTH = 232;");
    expect(sidebar).toMatch(/initial: SIDEBAR_WIDTH,\s+min: SIDEBAR_WIDTH,\s+max: SIDEBAR_MAX_WIDTH,\s+storageKey: "cm:sidebar-width",/);
    // The drag stops under the old 330–350 px range, so a stored old width is out of range and the new default applies.
    const max = Number(sidebar.match(/export const SIDEBAR_MAX_WIDTH = (\d+);/)?.[1]);
    expect(max).toBe(300);
    expect(max).toBeLessThan(330);
    expect(read("../src/lib/useResizable.ts")).toContain("if (!Number.isNaN(parsed) && parsed >= min && parsed <= max) {");
    // Top-level rows stay one line; a sub-item wraps rather than cuts.
    expect(sidebar).toContain('<span className="truncate">{item.label}</span>');
    expect(sidebar).toContain('<span className="leading-snug">{sub.label}</span>');
  });

  test("the mark and the wordmark are 0.64 of their old sizes, so the wordmark keeps its 30 px from the edges", () => {
    // Old: mark clamp(112px,22dvh,250px); wordmark h clamp(44px,6.5dvh,70px), w clamp(170px,25dvh,270px), lift clamp(8px,2dvh,20px).
    expect(sidebar).toContain("-mt-[clamp(5px,1.3dvh,13px)] block h-[clamp(28px,4.15dvh,45px)] w-[clamp(109px,16dvh,173px)] max-w-full");
    expect(Math.round((232 - 173) / 2)).toBe((330 - 270) / 2);
  });
});
