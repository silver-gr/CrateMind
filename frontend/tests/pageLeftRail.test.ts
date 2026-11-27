import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PageLeftRail, PageLeftRailContext } from "../src/lib/pageRail";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const rail = read("../src/lib/pageRail.tsx");
const shell = read("../src/components/layout/AppShell.tsx");
const sidebar = read("../src/components/layout/Sidebar.tsx");
const library = read("../src/pages/Library.tsx");
const setBuilder = read("../src/pages/SetBuilder.tsx");
const panel = read("../src/components/library/LibrarySidePanel.tsx");

describe("a page's left panel as the main sidebar", () => {
  test("outside the shell it renders in place", () => {
    const html = renderToString(createElement(PageLeftRail, null, createElement("aside", null, "panel")));
    expect(html).toBe("<aside>panel</aside>");
    // Without a document (no box to move) it stays in place even with the shell's value.
    const host = {} as HTMLElement;
    const inside = createElement(PageLeftRailContext.Provider, { value: { host, shown: true } }, createElement(PageLeftRail, null, createElement("aside", null, "panel")));
    expect(renderToString(inside)).toBe("<aside>panel</aside>");
  });

  test("it takes the left column only while the sidebar shows no column (the floating bar), and never when inline", () => {
    expect(rail).toContain("const toRail = Boolean(rail?.shown) && !inline;");
    expect(rail).toContain("const target = toRail ? host : slot.current;");
    // `shown` is the sidebar's floating state and nothing else: the full sidebar and the icon rail keep the panels in the page.
    expect(shell).toContain("const leftRail = useMemo(() => (leftHost ? { host: leftHost, shown: floatingSidebar } : null), [leftHost, floatingSidebar]);");
    expect(sidebar).toContain('const dock = collapsed && collapseStyle === "dock";');
    expect(sidebar).toContain("useLayoutEffect(() => { onFloating?.(dock); }, [dock, onFloating]);");
  });

  test("the panel is moved, never remounted: one box made once, portalled into, and placed in the page or the left column", () => {
    expect(rail).toContain('el.className = "contents";');
    expect(rail).toContain("if (target && box.parentElement !== target) target.appendChild(box);");
    expect(rail).toContain('return <><div ref={slot} className="contents" />{createPortal(children, box)}</>;');
    // The shell's left host is made once and sits in the sidebar's column, after the sidebar.
    expect(shell).toContain('<Sidebar key={profile} onFloating={setFloatingSidebar} />');
    expect(shell.indexOf("<Sidebar key={profile}")).toBeLessThan(shell.indexOf("data-page-left-rail"));
  });

  test("only the Library and Set Builder have a left panel; other pages show no left column in the floating state", () => {
    expect(library.match(/<PageLeftRail\b/g)).toHaveLength(1);
    expect(setBuilder.match(/<PageLeftRail\b/g)).toHaveLength(1);
    for (const page of ["../src/pages/TaggingQueue.tsx", "../src/pages/Glossary.tsx", "../src/pages/Dashboard.tsx", "../src/pages/Settings.tsx"]) {
      expect(read(page)).not.toContain("PageLeftRail");
    }
  });

  test("the Library rails its side panel only side by side and where the panel is static (lg); narrower it stays in the page", () => {
    expect(library).toContain("const leftRailed = leftRailShown && wide && panelStatic;");
    expect(library).toContain("<PageLeftRail inline={!leftRailed}>");
    expect(library).toContain("railed={leftRailed}");
    // The 896 px switch counts a railed left panel back into the page, so the panel's move never flips the layout.
    expect(library).toContain('const leftOut = left?.closest("[data-page-left-rail]") ? left.getBoundingClientRect().width : 0;');
    // In the column the panel is static at its own width, keeps its handle, and Escape (an overlay's close) leaves it alone.
    expect(panel).toContain('? "relative w-[var(--library-panel-width)] bg-cm-bg-2/40"');
    expect(panel).toContain('railed ? "flex" : "hidden lg:flex"');
    expect(panel).toContain("event.defaultPrevented || railed ||");
  });
});
