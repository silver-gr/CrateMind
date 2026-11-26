// Pure helpers for the scan guard, the «Μετακινημένα κομμάτια» review and the suggested keeper of a duplicate group.
import type { MovedPair } from "./types";

/** The scan guard's note (MASS_MISSING_NOTE in backend/app/services/scanner.py): a folder that would lose
 *  more than half of its tracks in one scan loses none, and the job's message says so in Greek. */
const HELD_BACK_NOTE = "δεν σημειώθηκε κανένα ότι λείπει";

/** The guard's warnings in a finished scan's message, one per folder that was held back. */
export function scanHeldBack(message: string | null | undefined): string[] {
  return (message ?? "").split("; ").filter(part => part.includes(HELD_BACK_NOTE));
}

/** The folders the guard held back (each warning starts "<folder>: λείπουν …"), so the go-ahead rescans only them. */
export function heldBackRoots(warnings: readonly string[]): string[] {
  return warnings.map(warning => warning.slice(0, warning.lastIndexOf(": λείπουν "))).filter(Boolean);
}

/** How many tracks a finished scan marked as missing. */
export function scanMissingCount(message: string | null | undefined): number {
  const found = /(?:^|, )missing (\d+)/i.exec(message ?? "");
  return found ? Number(found[1]) : 0;
}

export const pairKey = (pair: MovedPair) => `${pair.old.track_id}:${pair.new.track_id}`;

/** The pairs still waiting for an answer: the ones the user said «Όχι» to stay out of the list. */
export function openPairs(pairs: MovedPair[], declined: readonly string[]): MovedPair[] {
  const hidden = new Set(declined);
  return pairs.filter(pair => !hidden.has(pairKey(pair)));
}

const DECLINED_KEY = "cratemind-relink-declined";

export function loadDeclined(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(DECLINED_KEY) ?? "[]");
    return Array.isArray(stored) ? stored.filter((key): key is string => typeof key === "string") : [];
  } catch {
    return [];
  }
}

export function saveDeclined(declined: readonly string[]): void {
  try {
    localStorage.setItem(DECLINED_KEY, JSON.stringify(declined));
  } catch {
    // Without storage the answer holds until the page is reloaded.
  }
}

const KEEPER_REASONS: Record<string, string> = {
  lossless: "αρχείο χωρίς απώλειες (lossless)",
  bitrate: "υψηλότερο bitrate",
  taste: "έχει δικά σου δεδομένα ή ιστορικό",
  longer: "μεγαλύτερη διάρκεια",
};

/** Why a file of a duplicate group is the suggested one to keep; an unknown reason shows no text. */
export const keeperReasonLabel = (reason: string) => KEEPER_REASONS[reason] ?? "";
