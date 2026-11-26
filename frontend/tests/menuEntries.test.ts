import { describe, expect, test } from "bun:test";
import { mapMenu, SEPARATOR, shownEntries, tidy, type MenuEntry } from "../src/lib/menus/entries";
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

  test("a target that is gone (a removed set row) shows nothing and never reaches the source", () => {
    // Set Builder: the right-clicked position left the set (removed, or another set opened).
    const rows = [{ position: 0, title: "a" }, { position: 1, title: "b" }];
    let reached = 0;
    const menu = mapMenu(
      { entries: (row: { title: string }) => { reached++; return [item(row.title)]; }, onOpenChange: () => { reached++; } },
      (position: number) => rows.find(row => row.position === position) ?? null,
    );
    expect(labels(menu.entries(1))).toEqual(["b"]);
    rows.pop();
    reached = 0;
    expect(menu.entries(1)).toEqual([]);
    menu.onOpenChange?.(false, 1);
    expect(reached).toBe(0);
  });
});

describe("shownEntries", () => {
  test("builds the entries only while a target is open; after close it keeps the last list", () => {
    let built = 0;
    const menu = { entries: (s: string) => { built++; return [item(s)]; } };
    const open = shownEntries(menu, { value: "row" }, []);
    expect(labels(open)).toEqual(["row"]);
    expect(shownEntries(menu, null, open)).toBe(open);
    expect(built).toBe(1);
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
