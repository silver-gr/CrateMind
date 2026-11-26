import { CheckCircle2, Copy, Download, ListMusic, Play, Trash2, X } from "../icons";
import { MIX_COPY } from "../transitions/copy";
import { SEPARATOR, tidy, type MenuEntry } from "./entries";

export const SET_EXPORTS = [
  { fmt: "m3u", label: "M3U" },
  { fmt: "csv", label: "CSV" },
  { fmt: "markdown", label: "Markdown" },
  { fmt: "json-backup", label: "JSON" },
] as const;

export type SetExportFormat = typeof SET_EXPORTS[number]["fmt"];

/**
 * One set's menu, bound to that set by the place: the Library «Sets/Playlist» tab passes `open` and `active`,
 * the Set Builder passes `mix` and `markPlayed`. The Set Builder's «…» button shows the same list.
 */
export interface SetMenuActions {
  /** Export, copy and delete wait: no set loaded yet, or a change is saving. */
  busy?: boolean;
  open?(): void;
  active?: { checked: boolean; toggle(): void };
  mix?: { running: boolean; disabled: boolean; toggle(): void };
  markPlayed?: { disabled: boolean; run(): void };
  exportAs(fmt: SetExportFormat): void;
  duplicate(): void;
  /** Opens the existing «Διαγραφή set» confirmation. */
  remove(): void;
}

export function setMenuEntries(a: SetMenuActions): MenuEntry[] {
  const busy = !!a.busy;
  const { open, active, mix, markPlayed } = a;
  return tidy([
    open && { type: "item", icon: ListMusic, label: "Άνοιγμα στο Set Builder", onSelect: open },
    active && { type: "check", label: "Ενεργό set", checked: active.checked, onSelect: active.toggle },
    mix && {
      type: "item", icon: mix.running ? X : Play, label: mix.running ? MIX_COPY.stopMix : MIX_COPY.playAsMix,
      disabled: mix.disabled, onSelect: mix.toggle,
    },
    markPlayed && { type: "item", icon: CheckCircle2, label: "Σήμανση set ως παιγμένο", disabled: markPlayed.disabled, onSelect: markPlayed.run },
    SEPARATOR,
    {
      type: "sub", icon: Download, label: "Εξαγωγή", disabled: busy,
      entries: SET_EXPORTS.map(({ fmt, label }): MenuEntry => ({
        type: "item", label: fmt === "json-backup" ? "JSON (αντίγραφο ασφαλείας)" : label, onSelect: () => a.exportAs(fmt),
      })),
    },
    { type: "item", icon: Copy, label: "Δημιουργία αντιγράφου", disabled: busy, onSelect: a.duplicate },
    SEPARATOR,
    { type: "item", icon: Trash2, label: "Διαγραφή set…", danger: true, disabled: busy, onSelect: a.remove },
  ]);
}
