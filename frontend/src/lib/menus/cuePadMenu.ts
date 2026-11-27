import { Crosshair, Pin, Plus, SettingsIcon, SkipForward, Trash2, X } from "../icons";
import type { CueSuggestion } from "../trackStructure";
import type { TrackCue } from "../types";
import { SEPARATOR, tidy, type MenuEntry } from "./entries";

/** What a pad shows: its cue, else the suggested cue it offers (a ghost, never stored), else nothing. */
export interface CuePadMenuContext {
  cue: TrackCue | null;
  ghost: CueSuggestion | null;
  /** The track's saved cues as the pad editor lists them, for «Ανάθεση αποθηκευμένου cue». */
  cues: { id: number; label: string }[];
  canSeek: boolean;
  canCapture: boolean;
  /** A save for this pad is under way. */
  pending: boolean;
  /** The digit that presses this pad, only on the deck the keys belong to. */
  shortcut?: string;
  jump(): void;
  keep?(): void;
  capture(): void;
  assign(cueId: number | null): void;
  settings(): void;
  deleteCue(): void;
}

export const PAD_REASONS = { notReady: "δεν παίζει track", saving: "αποθήκευση…" } as const;

/** A set pad: jump, settings, then clear the pad or delete its cue. An empty pad: a cue here, a saved cue, settings. */
export function cuePadMenuEntries(ctx: CuePadMenuContext): MenuEntry[] {
  const notReady = !ctx.canSeek ? PAD_REASONS.notReady : undefined;
  const settings: MenuEntry = { type: "item", icon: SettingsIcon, label: "Ρυθμίσεις pad…", ...(ctx.pending ? { disabled: true, reason: PAD_REASONS.saving } : {}), onSelect: ctx.settings };
  if (ctx.cue) {
    return tidy([
      { type: "item", icon: SkipForward, label: "Μετάβαση", shortcut: ctx.shortcut, disabled: !!notReady, reason: notReady, onSelect: ctx.jump },
      settings,
      SEPARATOR,
      { type: "item", icon: X, label: "Άδειασμα pad (το cue διατηρείται)", onSelect: () => ctx.assign(null) },
      { type: "item", icon: Trash2, label: "Διαγραφή cue…", danger: true, disabled: ctx.pending, onSelect: ctx.deleteCue },
    ]);
  }
  const captureReason = ctx.pending ? PAD_REASONS.saving : !ctx.canCapture ? PAD_REASONS.notReady : undefined;
  const { keep } = ctx;
  return tidy([
    ctx.ghost && { type: "item", icon: SkipForward, label: "Μετάβαση", shortcut: ctx.shortcut, disabled: !!notReady, reason: notReady, onSelect: ctx.jump },
    ctx.ghost && keep && { type: "item", icon: Pin, label: "Κράτα ως cue", ...(ctx.pending ? { disabled: true, reason: PAD_REASONS.saving } : {}), onSelect: keep },
    SEPARATOR,
    { type: "item", icon: Crosshair, label: "Cue στο τρέχον σημείο", disabled: !!captureReason, reason: captureReason, onSelect: ctx.capture },
    {
      type: "sub", icon: Plus, label: "Ανάθεση αποθηκευμένου cue",
      entries: ctx.cues.length
        ? ctx.cues.map((cue): MenuEntry => ({ type: "item", label: cue.label, onSelect: () => ctx.assign(cue.id) }))
        : [{ type: "label", label: "Δεν υπάρχουν αποθηκευμένα cues." }],
    },
    settings,
  ]);
}
