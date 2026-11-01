// Transition notes from the controller's FX select buttons: 1 = good, 2 = ok, 3 = clash, on the 1-5 pair-note scale.
// The direction comes from which deck's current load started playing first, so resumes, ejects and replaced loads can't flip it.
import type { DeckId } from "./player";
import type { PairNote } from "./types";

/** FX button 1/2/3 -> pair-note rating. */
export const NOTE_RATINGS = [5, 3, 1] as const;
export const NOTE_LABELS = ["καλή", "οκ", "clash"] as const;

/** `startedAt`: ms clock of the first play of the deck's current load, null while it has only been cued. */
export type LoadInfo = { trackId: number; startedAt: number | null } | null;

const sources: Partial<Record<DeckId, () => LoadInfo>> = {};
export function registerLoadInfo(deck: DeckId, getter: () => LoadInfo): () => void {
  sources[deck] = getter;
  return () => { if (sources[deck] === getter) delete sources[deck]; };
}
export const loadInfoOf = (deck: DeckId): LoadInfo => { try { return sources[deck]?.() ?? null; } catch { return null; } };

export type NotePlan =
  | { ok: true; from: { deck: DeckId; trackId: number }; to: { deck: DeckId; trackId: number } }
  | { ok: false; reason: "missing" | "not-started" | "same-track" | "simultaneous" };

/** Both loads must have started and hold different tracks; the earlier start is the `from` side. */
export function planTransitionNote(a: LoadInfo, b: LoadInfo): NotePlan {
  if (!a || !b) return { ok: false, reason: "missing" };
  if (a.startedAt === null || b.startedAt === null) return { ok: false, reason: "not-started" };
  if (a.trackId === b.trackId) return { ok: false, reason: "same-track" };
  if (a.startedAt === b.startedAt) return { ok: false, reason: "simultaneous" };
  const aFirst = a.startedAt < b.startedAt;
  return { ok: true, from: { deck: aFirst ? "A" : "B", trackId: (aFirst ? a : b).trackId }, to: { deck: aFirst ? "B" : "A", trackId: (aFirst ? b : a).trackId } };
}

export const NOTE_REFUSALS: Record<Exclude<NotePlan, { ok: true }>["reason"], string> = {
  missing: "Σημείωση μετάβασης: χρειάζονται track και στα δύο decks.",
  "not-started": "Σημείωση μετάβασης: το ένα deck είναι μόνο cued — δεν έχει παίξει ακόμα.",
  "same-track": "Σημείωση μετάβασης: το ίδιο track και στα δύο decks.",
  simultaneous: "Σημείωση μετάβασης: δεν φαίνεται ποιο track παίχτηκε πρώτο.",
};

export type NoteIo = {
  create: (body: { from_track_id: number; to_track_id: number; rating: number }) => Promise<unknown>;
  toast: { success: (message: string) => void; error: (message: string) => void; info: (message: string) => void };
  flash: (index: number) => void;
  /** Tells Set Builder to reload its pair notes. */
  emit: () => void;
};

/** `index` 0..2 = good / ok / clash. Only the rating is sent, so an existing note keeps its text and type. */
export async function rateTransition(index: number, a: LoadInfo, b: LoadInfo, io: NoteIo): Promise<boolean> {
  const rating = NOTE_RATINGS[index];
  if (rating === undefined) return false;
  const plan = planTransitionNote(a, b);
  if (!plan.ok) { io.toast.info(NOTE_REFUSALS[plan.reason]); return false; }
  const body = { from_track_id: plan.from.trackId, to_track_id: plan.to.trackId, rating };
  try {
    await io.create(body);
  } catch (cause: unknown) {
    io.toast.error(cause instanceof Error ? cause.message : "Η σημείωση μετάβασης δεν αποθηκεύτηκε.");
    return false;
  }
  io.flash(index);
  io.toast.success(`Μετάβαση ${plan.from.deck}→${plan.to.deck}: ${NOTE_LABELS[index]} (${rating}/5)`);
  io.emit();
  return true;
}

/** The note a pair is judged by: the newest one (highest id) per ordered pair, whatever order the list arrives in. */
export function newestPairNotes(notes: readonly PairNote[]): Record<string, PairNote> {
  const map: Record<string, PairNote> = {};
  for (const n of notes) {
    const key = `${n.from_track_id}-${n.to_track_id}`;
    if (!map[key] || n.id > map[key].id) map[key] = n;
  }
  return map;
}
