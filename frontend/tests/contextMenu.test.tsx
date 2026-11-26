import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextMenu as ContextMenuPrimitive } from "radix-ui";
import { ActionContextMenu, MenuEntries } from "../src/components/ui/context-menu";
import { Copy, Play, Trash2 } from "../src/lib/icons";
import type { MenuEntry } from "../src/lib/menus/entries";

const noop = () => {};

/** An open menu rendered in place (the app's content portals to <body>, which a server render skips). */
function openMenu(entries: MenuEntry[]) {
  return renderToStaticMarkup(
    <ContextMenuPrimitive.Root open>
      <ContextMenuPrimitive.Trigger />
      <ContextMenuPrimitive.Content>
        <MenuEntries entries={entries} />
      </ContextMenuPrimitive.Content>
    </ContextMenuPrimitive.Root>,
  );
}

/** The opening tag of the element that holds `text`. */
function tagOf(html: string, text: string): string {
  const at = html.indexOf(text);
  expect(at).toBeGreaterThan(-1);
  let start = html.lastIndexOf('role="', at);
  start = html.lastIndexOf("<", start);
  return html.slice(start, html.indexOf(">", start) + 1);
}

const entries: MenuEntry[] = [
  { type: "label", label: "3 επιλεγμένα κομμάτια" },
  { type: "item", icon: Play, label: "Ακρόαση", onSelect: noop },
  { type: "item", label: "Φόρτωση στο Deck A", disabled: true, reason: "παίζει", onSelect: noop },
  { type: "separator" },
  { type: "sub", icon: Copy, label: "Αντιγραφή", entries: [{ type: "item", label: "Όνομα αρχείου", onSelect: noop }] },
  { type: "radio", label: "εγκεκριμένο", checked: true, shortcut: "A", onSelect: noop },
  { type: "radio", label: "απόφυγε", checked: false, shortcut: "X", onSelect: noop },
  { type: "check", label: "BPM", checked: true, onSelect: noop },
  { type: "separator" },
  { type: "item", icon: Trash2, label: "Αφαίρεση από το set", danger: true, onSelect: noop },
];

describe("MenuEntries", () => {
  const html = openMenu(entries);

  test("renders an accessible menu: menu, items, separators, a submenu trigger", () => {
    expect(html).toContain('role="menu"');
    expect(html.match(/role="menuitem"/g)).toHaveLength(4); // play, deck A, sub trigger, remove
    expect(html.match(/role="separator"/g)).toHaveLength(2);
    expect(tagOf(html, "Αντιγραφή")).toContain('aria-haspopup="menu"');
    // The submenu's items exist only once it opens.
    expect(html).not.toContain("Όνομα αρχείου");
  });

  test("a disabled item is aria-disabled and shows its reason, not a shortcut", () => {
    const deck = tagOf(html, "Φόρτωση στο Deck A");
    expect(deck).toContain('aria-disabled="true"');
    expect(deck).toContain("data-disabled");
    expect(html).toContain(">παίζει</span>");
  });

  test("a run of radios is one group with the checked one marked, and keys as shortcuts", () => {
    expect(html.match(/role="group"/g)).toHaveLength(1);
    expect(tagOf(html, "εγκεκριμένο")).toContain('role="menuitemradio"');
    expect(tagOf(html, "εγκεκριμένο")).toContain('aria-checked="true"');
    expect(tagOf(html, "απόφυγε")).toContain('aria-checked="false"');
    expect(html).toMatch(/<kbd[^>]*>A<\/kbd>/);
    expect(html).toMatch(/<kbd[^>]*>X<\/kbd>/);
    expect(tagOf(html, ">BPM<")).toContain('role="menuitemcheckbox"');
  });

  test("labels line up: rows without an icon are inset to the icon column, the destructive row is rose", () => {
    expect(tagOf(html, "Φόρτωση στο Deck A")).toContain("pl-8");
    expect(tagOf(html, "Ακρόαση")).not.toContain("pl-8");
    expect(tagOf(html, "Αφαίρεση από το set")).toContain("text-cm-rose");
    expect(tagOf(html, "Αφαίρεση από το set")).toContain("data-danger");
  });

  test("without icons or marks nothing is inset", () => {
    const plain = openMenu([{ type: "item", label: "Μισό BPM (×½)", onSelect: noop }]);
    expect(tagOf(plain, "Μισό BPM")).not.toContain("pl-8");
  });
});

describe("ActionContextMenu", () => {
  test("renders the list itself as the trigger, closed, and the list alone without a menu", () => {
    const menu = { entries: () => entries };
    const html = renderToStaticMarkup(
      <ActionContextMenu menu={menu} rowSelector="[data-row]" pick={() => 1}>
        <div id="list"><div data-row="1">Κομμάτι</div></div>
      </ActionContextMenu>,
    );
    expect(html).toMatch(/^<div id="list" data-state="closed"/);
    expect(html).not.toContain('role="menu"');
    const bare = renderToStaticMarkup(
      <ActionContextMenu menu={undefined} pick={() => 1}><div id="list" /></ActionContextMenu>,
    );
    expect(bare).toBe('<div id="list"></div>');
  });
});
