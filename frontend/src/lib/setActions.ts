import { api } from "./api";
import { getMixSession, stopMixSession } from "./mix/mixSession";
import { forgetSetTarget } from "./setTargets";
import type { DJSet } from "./types";

/** «Δημιουργία αντιγράφου»: a new set «… (αντίγραφο)» with the same tracks in the same order. */
export async function duplicateSetById(id: number, title: string): Promise<DJSet> {
  const { tracks } = await api.getSet(id);
  const copy = await api.createSet(`${title || "Set"} (αντίγραφο)`);
  for (const row of tracks) await api.addSetTrack(copy.id, row.track.id);
  return copy;
}

/** Deletes a set (after its confirmation): a running mix of it stops and it leaves the «Προσθήκη σε set» order. */
export async function deleteSetAndCleanUp(id: number): Promise<void> {
  await api.deleteSet(id);
  if (getMixSession().setId === id) stopMixSession("set-deleted");
  forgetSetTarget(id);
}
