import { Activity, CircleDot, Copy, Disc3, Folder, Gauge, Layers, ListMusic, MicVocal, Play, Plus, SlidersHorizontal, Workflow, X } from "../icons";
import { editorStatus, statusLabel, statusValues } from "../labels";
import type { BpmFactor } from "../bpmUpdates";
import type { DeckId } from "../player";
import type { LibraryProfile } from "../prefs";
import { orderSetTargets } from "../setTargets";
import { effectiveBpm } from "../tempo";
import type { DJSet, Track } from "../types";
import { SEPARATOR, tidy, type MaybeEntry, type MenuEntry } from "./entries";

/**
 * The track menu (single track) and the selection menu, as pure builders. A place shows an item by passing its
 * action; facts decide when a shown item is disabled, with a short reason. The order never changes.
 */
export interface TrackMenuContext {
  profile: LibraryProfile;
  /** Read when the menu opens. */
  deckPlaying: Record<DeckId, boolean>;
  /** A set mix is running: plays and deck loads would cut into it. */
  mixRunning: boolean;
  /** The other sets for «Προσθήκη σε set»; null while they load. */
  sets: DJSet[] | null;
  /** The place's own set (Library's active set, Set Builder's open set): left out of «Προσθήκη σε set». */
  ownSetId: number | null;
  /** Its title for «Προσθήκη στο «…»»; null when the place has none chosen (the item is disabled). */
  ownSetTitle?: string | null;
  /** Why the own set takes nothing right now («αποθήκευση…»); it also replaces «κανένα ενεργό set». */
  ownSetReason?: string;
  /** The track open in the Library inspector: its status belongs to the editor's draft. */
  editingTrackId?: number | null;
  /** Status keys that work in this place («Ουρά tagging»). */
  statusKeys?: Partial<Record<string, string>>;
  /** The applied query already filters this artist. */
  artistFiltered?(artist: string): boolean;

  play?(track: Track): void;
  load?(deck: DeckId, track: Track): void;
  addToOwnSet?(tracks: Track[]): void;
  addToSet(set: DJSet, tracks: Track[]): void;
  newSet(tracks: Track[]): void;
  edit?(track: Track): void;
  setStatus?(track: Track, status: string): void;
  bpm?(track: Track, action: BpmFactor | "reset"): void;
  analyze?(tracks: Track[]): void;
  flowFinder?(track: Track): void;
  openArtist?(artist: string): void;
  reveal?(track: Track): void;
  copy(text: string): void;
  bulkEdit?(): void;
  clearSelection?(): void;
}

export const MENU_REASONS = {
  missing: "λείπει το αρχείο",
  mix: "τρέχει μίξη set",
  playing: "παίζει",
  noActiveSet: "κανένα ενεργό set",
  editing: "ανοιχτό στην καρτέλα Κομμάτι",
  noBpm: "χωρίς BPM",
  noArtist: "χωρίς καλλιτέχνη",
} as const;

/** «Καλλιτέχνης – τίτλος», or just the title (file name) without an artist. */
export function trackLine(track: Pick<Track, "artist" | "title" | "file_name">): string {
  const title = track.title || track.file_name;
  return track.artist ? `${track.artist} – ${title}` : title;
}

function disabledBy(...reasons: (string | false | null | undefined)[]): { disabled: boolean; reason?: string } {
  const reason = reasons.find((r): r is string => !!r);
  return reason ? { disabled: true, reason } : { disabled: false };
}

const OWN_SET_TITLE_MAX = 28;

function ownSetEntry(tracks: Track[], ctx: TrackMenuContext): MaybeEntry {
  if (!ctx.addToOwnSet) return null;
  const add = ctx.addToOwnSet;
  // A long title is cut inside the quotes, so the menu's own truncation never eats the closing ».
  // Counted in code points, so an emoji is never split into a lone surrogate.
  const chars = Array.from(ctx.ownSetTitle ?? "");
  const title = chars.length > OWN_SET_TITLE_MAX ? `${chars.slice(0, OWN_SET_TITLE_MAX - 1).join("")}…` : ctx.ownSetTitle;
  return title
    ? { type: "item", icon: Plus, label: `Προσθήκη στο «${title}»`, ...disabledBy(ctx.ownSetReason), onSelect: () => add(tracks) }
    : ctx.ownSetReason
      ? { type: "item", icon: Plus, label: "Προσθήκη στο set", disabled: true, reason: ctx.ownSetReason, onSelect: () => {} }
      : { type: "item", icon: Plus, label: "Προσθήκη στο ενεργό set", disabled: true, reason: MENU_REASONS.noActiveSet, onSelect: () => {} };
}

function setsEntry(tracks: Track[], ctx: TrackMenuContext): MenuEntry {
  const others = ctx.sets ? orderSetTargets(ctx.sets, ctx.ownSetId) : null;
  return {
    type: "sub",
    icon: ListMusic,
    label: "Προσθήκη σε set",
    entries: tidy([
      others === null && { type: "label", label: "Φόρτωση…" },
      others?.length === 0 && { type: "label", label: "Δεν υπάρχουν άλλα sets." },
      ...(others ?? []).map((set): MenuEntry => ({ type: "item", label: set.title, onSelect: () => ctx.addToSet(set, tracks) })),
      SEPARATOR,
      { type: "item", label: "Νέο set…", onSelect: () => ctx.newSet(tracks) },
    ]),
  };
}

export function trackMenuEntries(track: Track, ctx: TrackMenuContext, placeItems: MaybeEntry[] = []): MenuEntry[] {
  const missing = track.missing && MENU_REASONS.missing;
  const mix = ctx.mixRunning && MENU_REASONS.mix;
  const { play, load, setStatus, bpm, analyze, flowFinder, openArtist, reveal, edit } = ctx;
  const hasBpm = effectiveBpm(track) != null;
  const shown = editorStatus(track.personal_status, ctx.profile);
  const artist = track.artist?.trim() ?? "";
  const filename = track.absolute_path.split(/[\\/]/).pop() || track.file_name;
  return tidy([
    play && { type: "item", icon: Play, label: "Ακρόαση", ...disabledBy(missing, mix), onSelect: () => play(track) },
    ...(["A", "B"] as const).map((deck): MaybeEntry => load && {
      type: "item", icon: Disc3, label: `Φόρτωση στο Deck ${deck}`,
      ...disabledBy(missing, mix, ctx.deckPlaying[deck] && MENU_REASONS.playing),
      onSelect: () => load(deck, track),
    }),
    SEPARATOR,
    ownSetEntry([track], ctx),
    setsEntry([track], ctx),
    SEPARATOR,
    edit && { type: "item", icon: SlidersHorizontal, label: "Επεξεργασία προφίλ", onSelect: () => edit(track) },
    setStatus && {
      type: "sub", icon: CircleDot, label: "Κατάσταση",
      ...disabledBy(ctx.editingTrackId === track.id && MENU_REASONS.editing),
      entries: statusValues(ctx.profile).map((status): MenuEntry => ({
        type: "radio",
        label: statusLabel(status, ctx.profile),
        checked: shown === status,
        shortcut: ctx.statusKeys?.[status],
        // Choosing what is already shown would only erase a DJ «banger» shown as approved in therapy.
        onSelect: () => { if (shown !== status) setStatus(track, status); },
      })),
    },
    bpm && {
      type: "sub", icon: Gauge, label: "BPM",
      entries: tidy([
        { type: "label", label: "Μόνο στο CrateMind, όχι στα tags ή στο djay" },
        { type: "item", label: "Μισό BPM (×½)", ...disabledBy(!hasBpm && MENU_REASONS.noBpm), onSelect: () => bpm(track, 0.5) },
        { type: "item", label: "Διπλό BPM (×2)", ...disabledBy(!hasBpm && MENU_REASONS.noBpm), onSelect: () => bpm(track, 2) },
        !!track.bpm_consensus_sources?.startsWith("manual:") && { type: "item", label: "Επαναφορά αυτόματου BPM", onSelect: () => bpm(track, "reset") },
      ]),
    },
    analyze && { type: "item", icon: Activity, label: "Ανάλυση BPM…", onSelect: () => analyze([track]) },
    SEPARATOR,
    flowFinder && ctx.profile === "dj" && { type: "item", icon: Workflow, label: "Flow Finder από εδώ", onSelect: () => flowFinder(track) },
    openArtist && !(artist && ctx.artistFiltered?.(artist)) && {
      type: "item", icon: MicVocal, label: "Κομμάτια του καλλιτέχνη",
      ...disabledBy(!artist && MENU_REASONS.noArtist), onSelect: () => openArtist(artist),
    },
    reveal && { type: "item", icon: Folder, label: "Εμφάνιση στον φάκελο", ...disabledBy(missing), onSelect: () => reveal(track) },
    {
      type: "sub", icon: Copy, label: "Αντιγραφή",
      entries: [
        { type: "item", label: "Καλλιτέχνης – τίτλος", onSelect: () => ctx.copy(trackLine(track)) },
        { type: "item", label: "Όνομα αρχείου", onSelect: () => ctx.copy(filename) },
        { type: "item", label: "Διαδρομή αρχείου", onSelect: () => ctx.copy(track.absolute_path) },
      ],
    },
    SEPARATOR,
    ...placeItems,
  ]);
}

/** Right-click on a checked row while two or more are checked: the menu acts on all of them, in table order. */
export function selectionMenuEntries(tracks: Track[], ctx: TrackMenuContext): MenuEntry[] {
  const { analyze, bulkEdit, clearSelection } = ctx;
  return tidy([
    { type: "label", label: `${tracks.length.toLocaleString("el-GR")} επιλεγμένα κομμάτια` },
    ownSetEntry(tracks, ctx),
    setsEntry(tracks, ctx),
    SEPARATOR,
    bulkEdit && { type: "item", icon: Layers, label: "Μαζική επεξεργασία…", onSelect: bulkEdit },
    analyze && { type: "item", icon: Activity, label: "Ανάλυση BPM…", onSelect: () => analyze(tracks) },
    SEPARATOR,
    { type: "item", icon: Copy, label: "Αντιγραφή λίστας", onSelect: () => ctx.copy(tracks.map(trackLine).join("\n")) },
    SEPARATOR,
    clearSelection && { type: "item", icon: X, label: "Καθαρισμός επιλογής", onSelect: clearSelection },
  ]);
}
