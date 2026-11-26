import { Link2, Play, SlidersHorizontal, Split } from "../icons";
import { MIX_COPY } from "../transitions/copy";
import { SEPARATOR, tidy, type MenuEntry } from "./entries";

/** The connector between two set rows: the pill's ▶ and edit, «γέφυρα» and the pair note. */
export interface TransitionMenuContext {
  /** The pair's transition is loaded (the pill shows). */
  hasTransition: boolean;
  /** Both tracks can play and mix (the pill's ▶ is enabled). */
  mixable: boolean;
  hasNote: boolean;
  preview(): void;
  edit(): void;
  bridge(): void;
  note(): void;
}

export function transitionMenuEntries(ctx: TransitionMenuContext): MenuEntry[] {
  return tidy([
    {
      type: "item", icon: Play, label: MIX_COPY.previewTransition, onSelect: ctx.preview,
      ...(!ctx.hasTransition ? { disabled: true } : !ctx.mixable ? { disabled: true, reason: MIX_COPY.unmixable } : {}),
    },
    { type: "item", icon: SlidersHorizontal, label: `${MIX_COPY.editorTitle}…`, disabled: !ctx.hasTransition, onSelect: ctx.edit },
    SEPARATOR,
    { type: "item", icon: Split, label: "Βρες track-γέφυρα", onSelect: ctx.bridge },
    { type: "item", icon: Link2, label: ctx.hasNote ? "Επεξεργασία σημείωσης…" : "Σημείωση μετάβασης…", onSelect: ctx.note },
  ]);
}
