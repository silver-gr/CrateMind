import { Ban, CheckCircle2, Copy, Folder, X } from "../icons";
import type { MovedPair } from "../types";
import { SEPARATOR, tidy, type MenuEntry } from "./entries";

/** A duplicate group, outside its tracks: the group's own button. */
export function duplicateGroupMenuEntries(ignore: () => void): MenuEntry[] {
  return [{ type: "item", icon: Ban, label: "Δεν είναι διπλότυπο (αγνόηση)", onSelect: ignore }];
}

/** A «Μετακινημένα κομμάτια» pair: its two answers, the new file's folder (desktop) and both paths. */
export interface MovedPairMenuContext {
  merging: boolean;
  confirm(pair: MovedPair): void;
  decline(pair: MovedPair): void;
  reveal?(pair: MovedPair): void;
  copy(text: string): void;
}

export function movedPairMenuEntries(pair: MovedPair, ctx: MovedPairMenuContext): MenuEntry[] {
  const { reveal } = ctx;
  return tidy([
    { type: "item", icon: CheckCircle2, label: "Είναι το ίδιο", disabled: ctx.merging, onSelect: () => ctx.confirm(pair) },
    { type: "item", icon: X, label: "Όχι", disabled: ctx.merging, onSelect: () => ctx.decline(pair) },
    SEPARATOR,
    reveal && { type: "item", icon: Folder, label: "Εμφάνιση νέου αρχείου στον φάκελο", onSelect: () => reveal(pair) },
    {
      type: "sub", icon: Copy, label: "Αντιγραφή",
      entries: [
        { type: "item", label: "Παλιά διαδρομή", onSelect: () => ctx.copy(pair.old.absolute_path) },
        { type: "item", label: "Νέα διαδρομή", onSelect: () => ctx.copy(pair.new.absolute_path) },
      ],
    },
  ]);
}
