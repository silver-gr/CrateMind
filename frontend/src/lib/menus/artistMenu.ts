import { Copy, UserRound, Tags } from "../icons";
import { SEPARATOR, tidy, type MenuEntry } from "./entries";

/** An artist row or card. */
export interface ArtistMenuContext {
  /** The Library already filters this artist: the row's click takes it out again. */
  filtered?: boolean;
  openTracks(): void;
  /** Only while a genre result waits for confirmation: opens its card. */
  review?(): void;
  copy(text: string): void;
}

export function artistMenuEntries(name: string, ctx: ArtistMenuContext): MenuEntry[] {
  const { review } = ctx;
  return tidy([
    { type: "item", icon: UserRound, label: ctx.filtered ? "Αφαίρεση από το φίλτρο" : "Κομμάτια του καλλιτέχνη", onSelect: ctx.openTracks },
    review && { type: "item", icon: Tags, label: "Επιβεβαίωση είδους…", onSelect: review },
    SEPARATOR,
    { type: "item", icon: Copy, label: "Αντιγραφή ονόματος", onSelect: () => ctx.copy(name) },
  ]);
}
