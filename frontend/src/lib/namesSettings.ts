/** Settings > «Καθαρά ονόματα»: the pure rules behind the section (components/NamesSettings.tsx). The numbers come
 *  from `GET /api/names/status`; the Greek blocked reason and refusal text arrive from the backend as they are. */
import { NAME_STATUSES, NAME_STATUS_COUNT_LABEL, NAMES_TOKENS } from "./namesLabels";
import type { NameStatus, NamesLastRun, NamesRunState, NamesStatus } from "./types";

/** How often the section re-reads the status while a run is queued or running. */
export const NAMES_POLL_MS = 1500;

/** The Settings link for «κάνε σάρωση». */
export const SCAN_SECTION_HREF = "/settings?section=scan";

/** A Library link for one search query. */
export const libraryHref = (query: string) => "/library?q=" + encodeURIComponent(query);

const number = (n: number) => n.toLocaleString("el-GR");

/** «1 κομμάτι», «4.675 κομμάτια». */
export function tracksText(n: number): string {
  return n === 1 ? "1 κομμάτι" : `${number(n)} κομμάτια`;
}

export interface SwitchView {
  checked: boolean;
  disabled: boolean;
  /** Greek; why the switch cannot be turned on. */
  reason: string | null;
}

/** Turning the switch off is always allowed; turning it on waits until every present track's tags were read. */
export function switchView(status: NamesStatus, busy = false): SwitchView {
  const blocked = !status.on && !status.can_turn_on;
  const reason = blocked
    ? status.blocked_reason
      ?? (status.unread > 0 ? `${unreadText(status.unread)}: κάνε σάρωση` : "Ο διακόπτης δεν ανοίγει ακόμη.")
    : null;
  return { checked: status.on, disabled: busy || blocked, reason };
}

/** «12 κομμάτια δεν έχουν διαβαστεί ακόμη». */
export function unreadText(n: number): string {
  return n === 1 ? "1 κομμάτι δεν έχει διαβαστεί ακόμη" : `${number(n)} κομμάτια δεν έχουν διαβαστεί ακόμη`;
}

/** «2 κομμάτια έχουν tags που δεν διαβάζονται». */
export function unreadableText(n: number): string {
  return n === 1 ? "1 κομμάτι έχει tags που δεν διαβάζονται" : `${number(n)} κομμάτια έχουν tags που δεν διαβάζονται`;
}

export interface CountRow {
  status: NameStatus;
  label: string;
  count: number;
  /** The Library filter for the rows (`names:look`, …). */
  href: string;
}

/** One row per status, in the fixed order of NAME_STATUSES, zeros included. */
export function countRows(status: NamesStatus): CountRow[] {
  return NAME_STATUSES.map(key => ({
    status: key,
    label: NAME_STATUS_COUNT_LABEL[key],
    count: status.counts[key] ?? 0,
    href: libraryHref(`names:${key}`),
  }));
}

/** «Άλλαξαν από την τελευταία ματιά: N», with its Library link (`names:new`) only when there is something to see. */
export function newChangesView(status: NamesStatus): { text: string; href: string | null } {
  return {
    text: `Άλλαξαν από την τελευταία ματιά: ${number(status.new)}`,
    href: status.new > 0 ? libraryHref(NAMES_TOKENS.new) : null,
  };
}

/** What started a run, as the end of a Greek sentence; '' for a cause this file does not know. */
export function causeText(cause: string | null | undefined): string {
  if (!cause) return "";
  if (cause.startsWith("decision:")) return "μετά από μια απάντησή σου";
  return ({
    launch: "με το άνοιγμα της εφαρμογής",
    scan: "μετά τη σάρωση",
    analysis: "μετά την ανάλυση",
    links: "μετά από αλλαγή στις πηγές",
    switch: "με το άνοιγμα του διακόπτη",
    manual: "με «Ενημέρωση ονομάτων»",
    import: "μετά την εισαγωγή των απαντήσεων",
  } as Record<string, string>)[cause] ?? "";
}

/** The running or waiting run, in Greek; null while idle. */
export function runText(run: NamesRunState): string | null {
  if (run.state === "idle") return null;
  const why = causeText(run.cause);
  const head = run.state === "running" ? "Τα ονόματα ενημερώνονται τώρα" : "Η ενημέρωση των ονομάτων περιμένει τη σειρά της";
  return why ? `${head}, ${why}…` : `${head}…`;
}

/** Poll while a run is queued or running. */
export const shouldPoll = (status: NamesStatus | null) => status != null && status.run.state !== "idle";

/** An ISO time as a short Greek date and time; the text itself when it does not parse. */
export function whenText(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString("el-GR", { day: "numeric", month: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function changesText(n: number): string {
  return n === 0 ? "καμία αλλαγή" : n === 1 ? "1 αλλαγή" : `${number(n)} αλλαγές`;
}

/** «Τελευταία ενημέρωση: 28/11/2026, 00:53 · κανόνες names-8 · 12 αλλαγές σε 4,1 δευτ.»; null before the first run.
 *  A run made with other rules than the engine's names both. */
export function lastRunText(last: NamesLastRun | null, ruleset: string): string | null {
  if (!last) return null;
  const rules = last.ruleset === ruleset || !ruleset
    ? `κανόνες ${last.ruleset}`
    : `κανόνες ${last.ruleset} (τώρα ${ruleset}: πάτα «Ενημέρωση ονομάτων»)`;
  const seconds = last.seconds.toLocaleString("el-GR", { maximumFractionDigits: 1 });
  return `Τελευταία ενημέρωση: ${whenText(last.finished_at)} · ${rules} · ${changesText(last.written)} σε ${seconds} δευτ.`;
}

/** «Ενημέρωση ονομάτων» waits while a run is already queued or running. */
export const canRunNow = (status: NamesStatus, busy = false) => !busy && status.run.state === "idle";
