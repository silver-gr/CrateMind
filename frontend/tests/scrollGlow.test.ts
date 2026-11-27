import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { readFileSync } from "node:fs";
import { installScrollGlow, SCROLL_GLOW_MS } from "../src/lib/scrollGlow";

type Fake = { dataset: Record<string, string> };

function fakeDoc() {
  let handler: ((e: Event) => void) | null = null;
  const root: Fake = { dataset: {} };
  const doc = {
    documentElement: root,
    addEventListener: (_: string, h: (e: Event) => void) => { handler = h; },
    removeEventListener: () => { handler = null; },
  };
  return { doc: doc as unknown as Document, root, scroll: (target: unknown) => handler?.({ target } as Event), listening: () => handler !== null };
}

describe("scroll glow", () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  test("only the element that scrolls is marked, until 700 ms after its last scroll event", () => {
    expect(SCROLL_GLOW_MS).toBe(700);
    const { doc, root, scroll } = fakeDoc();
    const list: Fake = { dataset: {} }, other: Fake = { dataset: {} };
    installScrollGlow(doc);
    scroll(list);
    expect("scrolling" in list.dataset).toBe(true);
    expect("scrolling" in other.dataset).toBe(false);
    expect("scrolling" in root.dataset).toBe(false);
    jest.advanceTimersByTime(600);
    scroll(list); // still scrolling: the mark's time starts again
    jest.advanceTimersByTime(600);
    expect("scrolling" in list.dataset).toBe(true);
    jest.advanceTimersByTime(100);
    expect("scrolling" in list.dataset).toBe(false);
  });

  test("a page scroll marks the root element; a target without a dataset is ignored; uninstalling clears the marks", () => {
    const { doc, root, scroll, listening } = fakeDoc();
    const list: Fake = { dataset: {} };
    const stop = installScrollGlow(doc);
    scroll(doc);
    scroll({});
    scroll(null);
    scroll(list);
    expect("scrolling" in root.dataset).toBe(true);
    stop();
    expect("scrolling" in root.dataset).toBe(false);
    expect("scrolling" in list.dataset).toBe(false);
    expect(listening()).toBe(false);
    jest.advanceTimersByTime(SCROLL_GLOW_MS * 2); // no late timer brings a mark back or throws
    expect("scrolling" in list.dataset).toBe(false);
  });

  test("the stylesheet lights a marked element's scrollbar in the app's cyan and the app installs the marker", () => {
    const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
    expect(css).toContain("[data-scrolling]::-webkit-scrollbar-thumb,");
    expect(css).toContain("[data-scrolling]::-webkit-scrollbar-thumb:horizontal,");
    // The element's own style must change with the mark, or WebKit keeps the scrollbar's old style.
    expect(css).toContain('@property --cm-scrolling { syntax: "<number>"; inherits: false; initial-value: 0; }');
    expect(css).toContain("[data-scrolling] { --cm-scrolling: 1; }");
    expect(readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")).toContain("installScrollGlow();");
  });
});
