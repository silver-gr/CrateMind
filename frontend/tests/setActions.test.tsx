import { expect, test } from "bun:test";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import SetActions from "../src/components/SetActions";
import { DropdownMenuEntries } from "../src/components/ui/dropdown-menu";
import { setMenuEntries } from "../src/lib/menus/setMenu";

const noop = () => {};
const entries = setMenuEntries({ busy: true, exportAs: noop, duplicate: noop, remove: noop });

test("the «…» is a menu button", () => {
  const html = renderToString(<SetActions onNew={noop} entries={entries} />);
  expect(html).toContain('aria-label="Ενέργειες set"');
  expect(html).toContain('aria-haspopup="menu"');
});

test("its menu renders the set's entries: export, copy and delete wait while no set is loaded", () => {
  // The app's content portals to <body>, which a server render skips: render the entries in place.
  const html = renderToStaticMarkup(
    <DropdownMenuPrimitive.Root open>
      <DropdownMenuPrimitive.Trigger />
      <DropdownMenuPrimitive.Content>
        <DropdownMenuEntries entries={[{ type: "item", label: "Νέο set", onSelect: noop }, ...entries]} />
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Root>,
  );
  const items = html.match(/<div role="menuitem"[^>]*>.*?<\/div>/g) ?? [];
  expect(items.map(item => item.replace(/<[^>]+>/g, ""))).toEqual(["Νέο set", "Εξαγωγή", "Δημιουργία αντιγράφου", "Διαγραφή set…"]);
  expect(items[0]).not.toContain("data-disabled");
  for (const item of items.slice(1)) expect(item).toContain("data-disabled");
  expect(items[3]).toContain("text-cm-rose");
});
