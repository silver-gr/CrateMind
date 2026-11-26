import type { LucideIcon } from "lucide-react";

/** One row of a context menu, as data: the builders stay pure and the same list can feed any menu surface. */
export type MenuEntry =
  | { type: "item"; label: string; onSelect(): void; icon?: LucideIcon; reason?: string; shortcut?: string; disabled?: boolean; danger?: boolean }
  | { type: "check"; label: string; checked: boolean; onSelect(): void; disabled?: boolean }
  | { type: "radio"; label: string; checked: boolean; onSelect(): void; shortcut?: string; disabled?: boolean }
  | { type: "sub"; label: string; icon?: LucideIcon; reason?: string; disabled?: boolean; entries: MenuEntry[] }
  | { type: "label"; label: string }
  | { type: "separator" };

/** What builders may write: `cond && item`, so a hidden item is just `false`. */
export type MaybeEntry = MenuEntry | false | null | undefined;

export const SEPARATOR: MenuEntry = { type: "separator" };

/** Drops hidden entries and the separators they leave behind: none first, none last, never two in a row. */
export function tidy(entries: readonly MaybeEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const entry of entries) {
    if (!entry) continue;
    if (entry.type === "separator" && (out.length === 0 || out[out.length - 1].type === "separator")) continue;
    out.push(entry);
  }
  while (out.length && out[out.length - 1].type === "separator") out.pop();
  return out;
}

/** A source of menu entries for one kind of target; `onOpenChange` lets it fetch late data. */
export interface MenuSource<T> {
  entries(target: T): MenuEntry[];
  onOpenChange?(open: boolean, target: T): void;
}

/** A target in a list with two kinds of rows (a play and its session, a track and its column header). */
export type Either<A, B> = { first: A } | { second: B };

/** One menu for two kinds of rows: the picked target says which menu it belongs to. */
export function eitherMenu<A, B>(first: MenuSource<A> | undefined, second: MenuSource<B> | undefined): MenuSource<Either<A, B>> | undefined {
  if (!first && !second) return undefined;
  return {
    entries: target => ("first" in target ? first?.entries(target.first) : second?.entries(target.second)) ?? [],
    onOpenChange(open, target) {
      if ("first" in target) first?.onOpenChange?.(open, target.first);
      else second?.onOpenChange?.(open, target.second);
    },
  };
}

/** The same menu for a different target type (a table row → a menu subject). */
export function mapMenu<A, B>(menu: MenuSource<B>, map: (target: A) => B): MenuSource<A> {
  return {
    entries: target => menu.entries(map(target)),
    onOpenChange: (open, target) => menu.onOpenChange?.(open, map(target)),
  };
}
