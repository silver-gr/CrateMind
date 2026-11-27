// A tuned transition another set holds for the same ordered pair (`GET /sets/{id}/transitions/elsewhere`).
// «Χρήση» copies it into this set through the ordinary save: a copy, never a link, and never automatic.
import { pairKey, type SetTransition, type TransitionParams } from "./types";

export interface CarriedTransition {
  from_track_id: number;
  to_track_id: number;
  source_set_id: number;
  source_set_title: string;
  updated_at: string;
  transition: TransitionParams;
}

const TITLE_MAX = 24;

/** The offers to show, by `pairKey`: only for a pair of this set that has no saved transition of its own. */
export function carryOffers(transitions: Record<string, SetTransition>, offers: CarriedTransition[]): Record<string, CarriedTransition> {
  const shown: Record<string, CarriedTransition> = {};
  for (const offer of offers) {
    const key = pairKey(offer.from_track_id, offer.to_track_id);
    const own = transitions[key];
    if (own && !own.persisted) shown[key] = offer;
  }
  return shown;
}

/** The chip's Greek: the source set's name (shortened in the label, whole in the tooltip) and the action. */
export function carryChip(offer: CarriedTransition): { label: string; title: string; action: string } {
  const name = offer.source_set_title.trim();
  const short = name.length > TITLE_MAX ? `${name.slice(0, TITLE_MAX - 1).trimEnd()}…` : name;
  return {
    label: `Ρυθμισμένη στο set «${short}»`,
    title: `Η ίδια μετάβαση είναι ρυθμισμένη στο set «${name}». Η «Χρήση» την αντιγράφει εδώ· το αντίγραφο αλλάζει χωριστά.`,
    action: "Χρήση",
  };
}

/** Save the offer's values as this set's own row (a fresh object, so nothing is shared), then announce it. */
export async function applyCarry(
  setId: number,
  offer: CarriedTransition,
  deps: {
    save: (setId: number, body: TransitionParams & { from_track_id: number; to_track_id: number }) => Promise<SetTransition>;
    announce: () => void;
  },
): Promise<SetTransition> {
  const row = await deps.save(setId, { ...offer.transition, from_track_id: offer.from_track_id, to_track_id: offer.to_track_id });
  deps.announce();
  return row;
}
