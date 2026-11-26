import { ArrowUpDown, Columns3, RotateCcw, X } from "../icons";
import { LIBRARY_COLUMNS, columnLabel, type LibraryColumnId } from "../tablePreferences";
import type { SortKey } from "../trackSort";
import { SEPARATOR, tidy, type MenuEntry } from "./entries";

type Sort = { key: SortKey; dir: "asc" | "desc" } | null;

/** A Library column header: the header click's sort, the «Στήλες» choices and the width resets, in one place. */
export interface ColumnMenuContext {
  sort: Sort;
  /** Absent while a `sort:` token orders the rows (the headers step aside then). */
  setSort?(next: Sort): void;
  visibility: Record<LibraryColumnId, boolean>;
  setVisible(id: LibraryColumnId, visible: boolean): void;
  resetWidth(id: LibraryColumnId): void;
  resetWidths(): void;
}

export function columnMenuEntries(id: LibraryColumnId, ctx: ColumnMenuContext): MenuEntry[] {
  const column = LIBRARY_COLUMNS.find(c => c.id === id);
  if (!column) return [];
  const sortKey: SortKey | undefined = "sortKey" in column ? column.sortKey : undefined;
  const { setSort } = ctx;
  const dir = sortKey && ctx.sort?.key === sortKey ? ctx.sort.dir : null;
  return tidy([
    setSort && sortKey && {
      type: "sub", icon: ArrowUpDown, label: "Ταξινόμηση",
      entries: [
        { type: "radio", label: "Αύξουσα", checked: dir === "asc", onSelect: () => setSort({ key: sortKey, dir: "asc" }) },
        { type: "radio", label: "Φθίνουσα", checked: dir === "desc", onSelect: () => setSort({ key: sortKey, dir: "desc" }) },
        // «Χωρίς ταξινόμηση» is shown for every column but this one's sort; choosing it then leaves another column's sort alone.
        { type: "radio", label: "Χωρίς ταξινόμηση", checked: dir === null, onSelect: () => { if (dir !== null) setSort(null); } },
      ],
    },
    id !== "track" && { type: "item", icon: X, label: "Απόκρυψη στήλης", onSelect: () => ctx.setVisible(id, false) },
    {
      type: "sub", icon: Columns3, label: "Στήλες",
      entries: LIBRARY_COLUMNS.map((c): MenuEntry => ({
        type: "check", label: columnLabel(c), checked: ctx.visibility[c.id], disabled: c.id === "track",
        onSelect: () => ctx.setVisible(c.id, !ctx.visibility[c.id]),
      })),
    },
    SEPARATOR,
    { type: "item", icon: RotateCcw, label: "Επαναφορά πλάτους στήλης", onSelect: () => ctx.resetWidth(id) },
    { type: "item", label: "Επαναφορά μεγεθών", onSelect: ctx.resetWidths },
  ]);
}
