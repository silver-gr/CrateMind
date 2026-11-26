import { describe, expect, test } from "bun:test";
import { mapMenu, SEPARATOR, tidy, type MenuEntry } from "../src/lib/menus/entries";
import { allowsNativeMenu } from "../src/lib/nativeContextMenu";

const item = (label: string): MenuEntry => ({ type: "item", label, onSelect: () => {} });
const labels = (entries: MenuEntry[]) => entries.map(e => (e.type === "separator" ? "—" : e.label));

describe("tidy", () => {
  test("drops hidden entries (false, null, undefined)", () => {
    expect(labels(tidy([item("a"), false, null, undefined, item("b")]))).toEqual(["a", "b"]);
  });

  test("no separator first, last or twice in a row, also when the items between them are hidden", () => {
    expect(labels(tidy([SEPARATOR, item("a"), SEPARATOR, SEPARATOR, false, SEPARATOR, item("b"), SEPARATOR, false]))).toEqual(["a", "—", "b"]);
    expect(tidy([SEPARATOR, false, SEPARATOR])).toEqual([]);
  });
});

describe("mapMenu", () => {
  test("maps the target for entries and for onOpenChange", () => {
    const seen: [boolean, string][] = [];
    const menu = mapMenu({ entries: (s: string) => [item(s)], onOpenChange: (open, s: string) => seen.push([open, s]) }, (n: number) => `#${n}`);
    expect(labels(menu.entries(7))).toEqual(["#7"]);
    menu.onOpenChange?.(true, 7);
    expect(seen).toEqual([[true, "#7"]]);
  });

  test("a source without onOpenChange maps to a no-op", () => {
    expect(() => mapMenu({ entries: () => [] }, (n: number) => n).onOpenChange?.(true, 1)).not.toThrow();
  });
});

describe("allowsNativeMenu", () => {
  const noSelection = null;
  const selection = (text: string, contains: boolean) => ({ isCollapsed: text === "", toString: () => text, containsNode: () => contains });

  test("text fields keep the webview menu (Copy/Paste); other inputs and plain elements do not", () => {
    expect(allowsNativeMenu({ tagName: "INPUT", type: "text" } as never, noSelection)).toBe(true);
    expect(allowsNativeMenu({ tagName: "INPUT", type: "search" } as never, noSelection)).toBe(true);
    expect(allowsNativeMenu({ tagName: "INPUT" } as never, noSelection)).toBe(true);
    expect(allowsNativeMenu({ tagName: "TEXTAREA" } as never, noSelection)).toBe(true);
    expect(allowsNativeMenu({ tagName: "DIV", isContentEditable: true } as never, noSelection)).toBe(true);
    expect(allowsNativeMenu({ tagName: "INPUT", type: "checkbox" } as never, noSelection)).toBe(false);
    expect(allowsNativeMenu({ tagName: "INPUT", type: "range" } as never, noSelection)).toBe(false);
    expect(allowsNativeMenu({ tagName: "DIV" } as never, noSelection)).toBe(false);
    expect(allowsNativeMenu(null, noSelection)).toBe(false);
  });

  test("selected text under the pointer keeps it; a selection elsewhere or only whitespace does not", () => {
    const row = { tagName: "DIV" } as never;
    expect(allowsNativeMenu(row, selection("/Music/track.flac", true))).toBe(true);
    expect(allowsNativeMenu(row, selection("/Music/track.flac", false))).toBe(false);
    expect(allowsNativeMenu(row, selection("  ", true))).toBe(false);
    expect(allowsNativeMenu(row, selection("", true))).toBe(false);
  });
});
