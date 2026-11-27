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
    expect(block).toContain("Ανάπτυξη πλαϊνής μπάρας");
    // The dock stays the other branch, unchanged.
    expect(sidebar.slice(end)).toContain("createPortal(island, document.body)");
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
    expect(sidebar).toContain('className="block size-[clamp(112px,22dvh,250px)] max-w-full shrink-0 overflow-hidden"');
    expect(sidebar).not.toContain("size-[72px]");
    expect(sidebar).not.toContain("useTwoDeck");
  });
});
