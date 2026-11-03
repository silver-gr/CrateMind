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
    expect(settings).toContain('<SelectItem value="dock">Αιωρούμενη μπάρα</SelectItem>');
    expect(settings).toContain('<SelectItem value="rail">Στενή πλαϊνή μπάρα</SelectItem>');
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
});
