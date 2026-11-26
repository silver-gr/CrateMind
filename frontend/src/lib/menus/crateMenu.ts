import { Activity, Pin, Search, Trash2, Wrench } from "../icons";
import type { SavedSearch } from "../types";
import { SEPARATOR, tidy, type MenuEntry } from "./entries";

/** A crate (saved search). `edit` and `analyze` exist only in the Library «Crates» tab, where their dialogs live. */
export interface CrateMenuContext {
  mainCrateId: number | null;
  open(crate: SavedSearch): void;
  pin(crate: SavedSearch): void;
  toggleMain(crate: SavedSearch): void;
  edit?(crate: SavedSearch): void;
  analyze?(crate: SavedSearch): void;
  /** Exactly the trash button: no confirmation today. */
  remove(crate: SavedSearch): void;
}

export function crateMenuEntries(crate: SavedSearch, ctx: CrateMenuContext): MenuEntry[] {
  const { edit, analyze } = ctx;
  return tidy([
    { type: "item", icon: Search, label: "Άνοιγμα", onSelect: () => ctx.open(crate) },
    { type: "item", icon: Pin, label: crate.pinned ? "Ξεκαρφίτσωμα" : "Καρφίτσωμα", onSelect: () => ctx.pin(crate) },
    { type: "check", label: "Κύριο crate", checked: ctx.mainCrateId === crate.id, onSelect: () => ctx.toggleMain(crate) },
    SEPARATOR,
    edit && { type: "item", icon: Wrench, label: "Επεξεργασία…", onSelect: () => edit(crate) },
    analyze && { type: "item", icon: Activity, label: "Ανάλυση BPM…", onSelect: () => analyze(crate) },
    SEPARATOR,
    { type: "item", icon: Trash2, label: "Διαγραφή crate", danger: true, onSelect: () => ctx.remove(crate) },
  ]);
}
