import type { AutomaticLinkBatch, AutomaticLinkRow } from "./types";

/** The rules that link on their own, in the order the review tab lists them: the two title-only rules first. */
export const RULE_LABELS: Record<string, string> = {
  title_unknown_artist: "Ίδιος τίτλος και διάρκεια, άγνωστος καλλιτέχνης",
  title_supported: "Ίδιος τίτλος, ο καλλιτέχνης στο όνομα αρχείου",
  text_exact: "Ίδιος καλλιτέχνης και τίτλος",
  text_clean: "Ίδιος καλλιτέχνης και τίτλος, χωρίς «Original Mix», BPM κ.λπ.",
  artist_variant: "Ίδιος τίτλος, ένας κοινός καλλιτέχνης",
  artist_in_title: "Καλλιτέχνης μέσα στον τίτλο",
  same_words: "Καλλιτέχνης και τίτλος με άλλη σειρά",
  isrc_duration: "Ίδιο ISRC και διάρκεια",
};
const RULE_HINTS: Record<string, string> = { isrc_duration: "ISRC: ο διεθνής κωδικός μιας ηχογράφησης" };
const TITLE_ONLY = new Set(["title_unknown_artist", "title_supported"]);

/** A rule key never reaches the screen: an unknown one gets a neutral label. */
export const ruleLabel = (rule: string) => RULE_LABELS[rule] ?? "Αυτόματος κανόνας";
export const ruleHint = (rule: string): string | undefined => RULE_HINTS[rule];
export const isTitleOnlyRule = (rule: string) => TITLE_ONLY.has(rule);
/** Ledger methods the automatic-links undo reverses. */
export const isAutomaticMethod = (method: string) => method.startsWith("auto_v1:");

/** The rule filter's options for one view, in the order of RULE_LABELS, with how many decisions each has. */
export function ruleOptions(counts: Record<string, number>): { rule: string; label: string; count: number }[] {
  const order = Object.keys(RULE_LABELS);
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([rule, count]) => ({ rule, label: ruleLabel(rule), count }))
    .sort((a, b) => (order.indexOf(a.rule) + 1 || order.length + 1) - (order.indexOf(b.rule) + 1 || order.length + 1));
}

export const REVIEW_STATUS = "REVIEW";
/**
 * The badge an entity shows. An unlinked local track no longer carries a match-class badge: it shows «Για έλεγχο»
 * when the last catch-up left it for manual review, and nothing otherwise. Everything else keeps its status.
 */
export function shownStatus(entity: { id: string; service: string; status: string }, review: ReadonlySet<string>): string {
  if (entity.service !== "local" || entity.status === "ACCEPTED") return entity.status;
  return review.has(entity.id) ? REVIEW_STATUS : "";
}

/** One side of a decision as two lines: a local file by its file name, a remote record by artist and title. */
export function sideLines(row: AutomaticLinkRow, side: "left" | "right"): { main: string; sub: string } {
  const artist = row[`${side}_artist`];
  const credit = artist && artist !== "null" ? artist : "Άγνωστος καλλιτέχνης";
  const title = row[`${side}_title`] || "Χωρίς τίτλο";
  if (row[`${side}_service`] === "local") return { main: row[`${side}_file_name`] || title, sub: `${credit} — ${title}` };
  return { main: title, sub: credit };
}

/** 0.4 → «0,4 δ.»; a missing value shows nothing. */
export const deltaText = (seconds: number | null) =>
  seconds == null ? "" : `διαφορά διάρκειας ${seconds.toLocaleString("el-GR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} δ.`;

const plural = (count: number, one: string, many: string) => `${count.toLocaleString("el-GR")} ${count === 1 ? one : many}`;
/** «332 συνδέσεις με αρχείο · 1.067 ενώσεις διπλότυπων», leaving out an empty part. */
export function batchSummary(batch: Pick<AutomaticLinkBatch, "link" | "fold">): string {
  return [
    batch.link ? plural(batch.link, "σύνδεση με αρχείο", "συνδέσεις με αρχείο") : "",
    batch.fold ? plural(batch.fold, "ένωση διπλότυπων", "ενώσεις διπλότυπων") : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
