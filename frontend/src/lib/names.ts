/** «Καθαρισμός ονομάτων» (`/names`): the page's pure rules (tabs and their counts, Greek words for kinds and
 *  sources, paging, the bulk confirmations, focus after a row leaves). The page and `components/names/*` render
 *  what these return; the backend's own texts (questions, rule sentences, causes) arrive already in Greek. */
import type { NameAnswer, NameAnswerInput, NameQuestion, NameQuestions, NamesRunState, NamesStatus } from "./types";
import { UNKNOWN_ARTIST } from "./namesLabels";

export type NamesTab = "questions" | "patterns" | "look" | "none" | "changed" | "answers";

export const NAMES_TABS: readonly { id: NamesTab; label: string }[] = [
  { id: "questions", label: "Για απόφαση" },
  { id: "patterns", label: "Ερωτήσεις προτιμήσεων" },
  { id: "look", label: "Για ματιά" },
  { id: "none", label: "Χωρίς καλλιτέχνη" },
  { id: "changed", label: "Άλλαξαν" },
  { id: "answers", label: "Οι απαντήσεις σου" },
];

export const isNamesTab = (value: string | null): value is NamesTab => NAMES_TABS.some(tab => tab.id === value);

/** What each tab still asks of the owner (null: not known yet). «Για ματιά» counts only the tracks not yet
 *  marked «Εντάξει»; «Άλλαξαν» the unacknowledged changes; «Οι απαντήσεις σου» every active answer. */
export function tabCounts(status: NamesStatus | null, questions: NameQuestions | null, answers: NameAnswer[] | null):
  Record<NamesTab, number | null> {
  const unanswered = (list: NameQuestion[]) => list.filter(q => !q.answer).length;
  return {
    questions: questions ? unanswered(questions.open) : null,
    patterns: questions ? unanswered(questions.patterns) : null,
    look: status ? Math.max(0, status.counts.look - status.accepted) : null,
    none: status ? status.counts.none : null,
    changed: status ? status.new : null,
    answers: answers ? answers.length : null,
  };
}

/** The tab a visit without `?section=` opens: the first one with something to do, else the answers. */
export function defaultTab(counts: Record<NamesTab, number | null>): NamesTab {
  const todo = NAMES_TABS.find(tab => tab.id !== "answers" && (counts[tab.id] ?? 0) > 0);
  return todo?.id ?? "answers";
}

const count = (n: number) => n.toLocaleString("el-GR");

export const tracksText = (n: number) => (n === 1 ? "1 κομμάτι" : `${count(n)} κομμάτια`);

/** «άλλαξε N κομμάτια» beside an answer: what the run after it changed (null: that run has not finished). */
export function reachText(reach: number | null): string {
  if (reach == null) return "μετριέται στην επόμενη ενημέρωση";
  if (reach === 0) return "δεν άλλαξε κανένα κομμάτι";
  return reach === 1 ? "άλλαξε 1 κομμάτι" : `άλλαξε ${count(reach)} κομμάτια`;
}

/** «Artist — Title»; an empty artist (status `none`) reads «Άγνωστος καλλιτέχνης». */
export function trackLine(artist: string | null | undefined, title: string | null | undefined): string {
  const a = (artist ?? "").trim() || UNKNOWN_ARTIST;
  const t = (title ?? "").trim();
  return t ? `${a} — ${t}` : a;
}

/** The switch-off name, only when it differs from the shown one (else nothing to show). */
export function offLine(row: { artist: string; title: string; off_artist: string; off_title: string }): string | null {
  if (!row.off_artist && !row.off_title) return null;
  if (row.off_artist === row.artist && row.off_title === row.title) return null;
  return trackLine(row.off_artist, row.off_title);
}

const KIND_LABEL: Record<string, string> = {
  spelling: "Γραφή ονόματος",
  same_act: "Ίδιος καλλιτέχνης",
  one_act: "Ένα όνομα",
  not_act: "Όχι καλλιτέχνης",
  bracket_word: "Λέξη σε αγκύλες",
  album_credit: "Άλμπουμ",
  facts: "Στοιχεία",
  preference: "Προτίμηση",
  casing: "Κεφαλαία",
  folder: "Φάκελος",
  title: "Τίτλος",
  reading: "Ανάγνωση",
  credit: "Συντελεστές",
  pattern: "Προτίμηση",
  track: "Διόρθωση κομματιού",
  accept: "Εντάξει",
};

/** A Greek chip for an answer's kind; an unknown kind gets a plain word, never the internal key. */
export const nameKindLabel = (kind: string) => KIND_LABEL[kind] ?? "Απάντηση";

const SOURCE_LABEL: Record<string, string> = {
  owner: "δική σου",
  seed: "από την αρχική λίστα",
  canonical: "από τη σελίδα ταυτότητας",
};

export const nameSourceLabel = (source: string) => SOURCE_LABEL[source] ?? "δική σου";

export function answerDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("el-GR", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** The body of an answer: a letter, or a typed value for «Άλλο…» (null when the typed value is empty). */
export function answerInput(question: Pick<NameQuestion, "kind" | "scope">, choice: { letter: string } | { text: string }):
  NameAnswerInput | null {
  if ("letter" in choice) return { kind: question.kind, scope: question.scope, letter: choice.letter };
  const text = choice.text.trim();
  return text ? { kind: question.kind, scope: question.scope, text } : null;
}

/** The option the active answer chose, when its value is a letter or an option's text (else none is marked). */
export function answeredLetter(question: NameQuestion): string | null {
  const value = question.answer?.value;
  if (!value) return null;
  return question.options.find(o => o.letter === value || o.text === value)?.letter ?? null;
}

/** Unanswered questions first, each group in the order the run gave. */
export const questionsInOrder = (list: NameQuestion[]) => [...list.filter(q => !q.answer), ...list.filter(q => q.answer)];

/** What the page says above its tabs: the switch off, a refused run, unread tracks (while off: the switch
 *  cannot be turned on until a scan reads them). Each line ends with a link to Settings. */
export function noticeLines(status: NamesStatus | null): { tone: "info" | "warn"; text: string }[] {
  if (!status) return [];
  const lines: { tone: "info" | "warn"; text: string }[] = [];
  if (!status.on) {
    lines.push({ tone: "info", text: "Τα καθαρά ονόματα είναι κλειστά: οι απαντήσεις σου φυλάγονται, αλλά τα ονόματα ενημερώνονται μόνο όταν τα ανοίξεις ή πατήσεις «Ενημέρωση ονομάτων» στις Ρυθμίσεις." });
  }
  if (status.refusal_text) lines.push({ tone: "warn", text: status.refusal_text });
  if (status.blocked_reason && !status.on) lines.push({ tone: "warn", text: status.blocked_reason });
  return lines;
}

export const runBusy = (run: NamesRunState | null | undefined) => run != null && run.state !== "idle";

export const REVIEW_PAGE_SIZE = 100;
export const QUESTIONS_PAGE_SIZE = 25;

/** «101–200 από 1.234»; empty for an empty list. */
export function rangeText(offset: number, shown: number, total: number): string {
  if (total <= 0 || shown <= 0) return "";
  return `${count(offset + 1)}–${count(offset + shown)} από ${count(total)}`;
}

/** The last page's offset when rows left the list and the current page is past its end. */
export function clampOffset(offset: number, total: number, limit: number): number {
  if (total <= 0) return 0;
  const last = Math.floor((total - 1) / limit) * limit;
  return Math.min(Math.max(0, offset), last);
}

/** Which row takes the focus after the focused one left: the one now in its place, else the new last row,
 *  else none (-1: the list's heading takes it). */
export function focusIndexAfter(index: number, length: number): number {
  if (length <= 0) return -1;
  return Math.min(Math.max(0, index), length - 1);
}

/** «Όλα» of a grouped list: the sum of its groups (or the section's total when it has none). */
export const groupsTotal = (groups: { count: number }[], total: number) =>
  groups.length ? groups.reduce((sum, g) => sum + g.count, 0) : total;

export type BulkAction = "accept" | "ok" | "keep_previous";

/** The request of «Εντάξει» for the «Για ματιά» filter shown (`group` null: every unaccepted look track). */
export const acceptBody = (group: string | null, dryRun: boolean) => ({ ...(group ? { rule: group } : {}), dry_run: dryRun });

/** The request of a bulk «Άλλαξαν» action for the filter shown (`group` null: every changed row). */
export const acknowledgeBody = (action: "ok" | "keep_previous", group: string | null, dryRun: boolean) =>
  ({ ...(group ? { cause: group } : {}), action, dry_run: dryRun });

/** The confirmation of a bulk action, with the count the dry run returned. */
export function bulkConfirm(action: BulkAction, n: number, groupLabel: string | null): { title: string; text: string; button: string } {
  const scope = groupLabel ? ` της ομάδας «${groupLabel}»` : "";
  const tracks = tracksText(n);
  const one = n === 1;
  if (action === "accept") {
    return {
      title: "Εντάξει σε όλα αυτά",
      text: one
        ? `1 κομμάτι${scope} θα σημειωθεί ως εντάξει με το όνομα που δείχνεται τώρα. Αν μια επόμενη ενημέρωση το αλλάξει, θα ξαναφανεί εδώ και στα «Άλλαξαν». Τα αρχεία δεν αλλάζουν.`
        : `${tracks}${scope} θα σημειωθούν ως εντάξει με τα ονόματα που δείχνονται τώρα. Αν μια επόμενη ενημέρωση τα αλλάξει, θα ξαναφανούν εδώ και στα «Άλλαξαν». Τα αρχεία δεν αλλάζουν.`,
      button: n === 1 ? "Εντάξει στο 1" : `Εντάξει και στα ${count(n)}`,
    };
  }
  if (action === "ok") {
    return {
      title: "Εντάξει σε όλες τις αλλαγές",
      text: one
        ? `1 κομμάτι${scope} κρατά το νέο του όνομα και φεύγει από τα «Άλλαξαν». Τα αρχεία δεν αλλάζουν.`
        : `${tracks}${scope} κρατούν το νέο τους όνομα και φεύγουν από τα «Άλλαξαν». Τα αρχεία δεν αλλάζουν.`,
      button: n === 1 ? "Εντάξει στο 1" : `Εντάξει και στα ${count(n)}`,
    };
  }
  return {
    title: "Κράτα τα προηγούμενα ονόματα",
    text: one
      ? `1 κομμάτι${scope} θα πάρει πάλι το προηγούμενο όνομά του, ως δική σου διόρθωση (την αναιρείς από «Οι απαντήσεις σου»). Τα αρχεία δεν αλλάζουν.`
      : `${tracks}${scope} θα πάρουν πάλι το προηγούμενο όνομά τους, ως δική σου διόρθωση το καθένα (την αναιρείς από «Οι απαντήσεις σου»). Τα αρχεία δεν αλλάζουν.`,
    button: n === 1 ? "Κράτα το προηγούμενο στο 1" : `Κράτα τα προηγούμενα και στα ${count(n)}`,
  };
}

/** The toast after a bulk or one-row action. */
export function doneText(action: BulkAction, n: number): string {
  if (action === "keep_previous") return n === 1 ? "Κράτησες το προηγούμενο όνομα" : `Κράτησες τα προηγούμενα ονόματα σε ${count(n)} κομμάτια`;
  return n === 1 ? "Σημειώθηκε ως εντάξει" : `Σημειώθηκαν ως εντάξει ${count(n)} κομμάτια`;
}

/** A correction needs an artist (a «Χωρίς καλλιτέχνη» track is named by typing one) and a title. */
export function correctionInput(artist: string, title: string): { artist: string; title: string } | null {
  const a = artist.trim();
  const t = title.trim();
  return a && t ? { artist: a, title: t } : null;
}

/** An error from `api` without its «409: » prefix (its text is already Greek). */
export function namesErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^\d{3}: /, "") || "Το αίτημα απέτυχε";
}

/** Settings' section of the feature (the switch and «Ενημέρωση ονομάτων» live there). */
export const NAMES_SETTINGS_HREF = "/settings?section=names";
