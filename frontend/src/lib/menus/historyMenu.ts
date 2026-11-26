import { ArrowRight, ChevronDown, ChevronRight, ListMusic, Trash2 } from "../icons";
import { SEPARATOR, tidy, type MenuEntry } from "./entries";

/** A play-history session: the Library «Ιστορικό» tab passes `fold` and `openPage`, the `/history` page `remove`. */
export interface SessionMenuContext {
  /** Older plays still to load: the session may be cut, so saving and deleting wait. */
  partial: boolean;
  busy: boolean;
  saveAsSet(): void;
  fold?: { open: boolean; toggle(): void };
  openPage?(): void;
  /** Shows the page's own «Διαγραφή όλου του session;» confirmation. */
  remove?(): void;
}

export const LOAD_OLDER_REASON = "φόρτωσε παλιότερα";

export function sessionMenuEntries(ctx: SessionMenuContext): MenuEntry[] {
  const { fold, openPage, remove } = ctx;
  const waits = ctx.partial ? { disabled: true, reason: LOAD_OLDER_REASON } : { disabled: ctx.busy };
  return tidy([
    { type: "item", icon: ListMusic, label: "Αποθήκευση ως set", ...waits, onSelect: ctx.saveAsSet },
    fold && { type: "item", icon: fold.open ? ChevronDown : ChevronRight, label: fold.open ? "Σύμπτυξη" : "Ανάπτυξη", onSelect: fold.toggle },
    SEPARATOR,
    openPage && { type: "item", icon: ArrowRight, label: "Άνοιγμα στη σελίδα «Ιστορικό»", onSelect: openPage },
    remove && { type: "item", icon: Trash2, label: "Διαγραφή session…", danger: true, ...waits, onSelect: remove },
  ]);
}
