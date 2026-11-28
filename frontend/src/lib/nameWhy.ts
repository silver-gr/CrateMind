/** «Γιατί αυτό το όνομα»: the pure part of the why block (components/NameWhy.tsx) and of the Library's `names:`
 *  quick filters. The backend sends every rule sentence, fact and question already in Greek; this file only
 *  arranges them and names the fields, so no internal key (a field name, a status code) ever reaches the screen. */
import { NAME_STATUS_LABEL, NAMES_TOKEN_LABEL, NAMES_TOKENS, UNKNOWN_ARTIST } from "./namesLabels";
import type { NamesStatus, NameWhy, NameWhyStep } from "./types";

/** The engine's step fields (backend services/names: Step.field) in the order the block lists them. */
const FIELD_ORDER = ["artist", "title", "pair", "folder", "album", "facts"] as const;
const FIELD_LABEL: Record<(typeof FIELD_ORDER)[number], string> = {
  artist: "Καλλιτέχνης",
  title: "Τίτλος",
  pair: "Καλλιτέχνης και τίτλος",
  folder: "Προτεινόμενος φάκελος",
  album: "Άλμπουμ",
  facts: "Στοιχεία",
};

/** The folder the engine proposes (advisory: nothing moves a file in this release). */
export const FOLDER_LABEL = FIELD_LABEL.folder;

/** The Greek name of a step's field; null for a field the block has no word for (it is then listed unnamed). */
export function fieldLabel(field: string): string | null {
  return (FIELD_LABEL as Record<string, string>)[field] ?? null;
}

export interface WhyGroup {
  /** null: steps whose field has no Greek name, listed last without a heading. */
  label: string | null;
  steps: NameWhyStep[];
}

/** Steps grouped per field (artist, title, …), each group in the engine's trail order. */
export function groupSteps(steps: readonly NameWhyStep[]): WhyGroup[] {
  const groups: WhyGroup[] = [];
  for (const field of FIELD_ORDER) {
    const own = steps.filter(s => s.field === field);
    if (own.length) groups.push({ label: FIELD_LABEL[field], steps: own });
  }
  const rest = steps.filter(s => fieldLabel(s.field) === null);
  if (rest.length) groups.push({ label: null, steps: rest });
  return groups;
}

/** «κανόνας N7»: the rule id beside its sentence (the owner asked for one beside every explanation). */
export function ruleLabel(rule: string): string {
  return rule ? `κανόνας ${rule}` : "";
}

/** The shown artist: status `none` stores '' and the app says «Άγνωστος καλλιτέχνης». */
export function shownArtist(why: Pick<NameWhy, "artist" | "status">): string {
  return why.status === "none" || !why.artist ? UNKNOWN_ARTIST : why.artist;
}

/** «Artist – Title», with «—» for an empty part. */
export function nameLine(artist: string | null | undefined, title: string | null | undefined): string {
  return `${artist?.trim() || "—"} – ${title?.trim() || "—"}`;
}

/** The status line: the decision's source when there is one («από τη σελίδα ταυτότητας»), else the status
 *  («Για ματιά», …); nothing for a sure name. */
export function statusLine(why: Pick<NameWhy, "status" | "status_text" | "decision">): string {
  if (why.decision?.kind === "track" && why.decision.source_text) return why.decision.source_text;
  if (why.status_text) return why.status_text;
  return why.status ? NAME_STATUS_LABEL[why.status] : "";
}

/** Why a track has no engine name yet (has_row false). */
export function noRowText(why: Pick<NameWhy, "raw">): string {
  return why.raw.state === null
    ? "Τα tags του αρχείου δεν έχουν διαβαστεί ακόμη: κάνε σάρωση."
    : "Δεν έχει γίνει ακόμη ενημέρωση ονομάτων γι' αυτό το κομμάτι.";
}

/** The raw tags as label/value lines; album and track number only when the file has them. */
export function rawLines(raw: NameWhy["raw"]): { label: string; value: string }[] {
  const lines = [
    { label: "Tag καλλιτέχνη", value: raw.artist?.trim() || "—" },
    { label: "Tag τίτλου", value: raw.title?.trim() || "—" },
  ];
  if (raw.album?.trim()) lines.push({ label: "Tag άλμπουμ", value: raw.album.trim() });
  if (raw.track_no?.trim()) lines.push({ label: "Tag αριθμού κομματιού", value: raw.track_no.trim() });
  return lines;
}

export const UNREADABLE_TEXT = "Τα tags του αρχείου δεν διαβάστηκαν· τα ονόματα βγήκαν από τα αποθηκευμένα στοιχεία.";

/** What the owner can do in the block (stage 2). The switch must be on for all of them. */
export interface WhyActions {
  /** «Διόρθωση»: a hand correction needs the file's tags read (the backend refuses otherwise). */
  correct: boolean;
  /** «Αναίρεση» of the track's own decision; a /canonical one is undone on /canonical. */
  undo: boolean;
  /** «Εντάξει» for a «Για ματιά» track not yet accepted. */
  accept: boolean;
}

export function whyActions(why: NameWhy): WhyActions {
  if (!why.on) return { correct: false, undo: false, accept: false };
  return {
    correct: why.raw.state !== null,
    undo: Boolean(why.decision?.undoable),
    accept: why.has_row && why.status === "look" && !why.accepted,
  };
}

/** The «Αναίρεση» button's words: an accept row undoes the «Εντάξει», a track row the correction. */
export function undoLabel(why: Pick<NameWhy, "decision">): string {
  return why.decision?.kind === "accept" ? "Αναίρεση του «Εντάξει»" : "Αναίρεση διόρθωσης";
}

/** The correction form starts from the name shown now (the switch-off name when there is no engine name). */
export function correctionStart(why: NameWhy): { artist: string; title: string } {
  if (why.has_row) return { artist: why.status === "none" ? "" : why.artist, title: why.title };
  return { artist: why.off_artist, title: why.off_title };
}

/** A correction is saved only with both parts filled and something changed; null: it can be saved. */
export function correctionProblem(why: NameWhy, artist: string, title: string): string | null {
  const a = artist.trim();
  const t = title.trim();
  if (!a || !t) return "Συμπλήρωσε καλλιτέχνη και τίτλο.";
  const start = correctionStart(why);
  if (why.decision?.kind === "track" && a === start.artist.trim() && t === start.title.trim()) return "Δεν άλλαξε τίποτα.";
  return null;
}

export interface NamesQuickFilter { label: string; q: string }

/** The Library's `names:` quick filters, offered only while «Καθαρά ονόματα» is on. */
export function namesQuickFilters(status: Pick<NamesStatus, "on"> | null): NamesQuickFilter[] {
  if (!status?.on) return [];
  return [
    { label: NAMES_TOKEN_LABEL.look, q: NAMES_TOKENS.look },
    { label: NAMES_TOKEN_LABEL.open, q: NAMES_TOKENS.open },
    { label: NAMES_TOKEN_LABEL.changed, q: NAMES_TOKENS.changed },
    { label: NAMES_TOKEN_LABEL.new, q: NAMES_TOKENS.new },
  ];
}
