// Controller pad actions off /tag: an empty pad creates a cue, a filled one jumps; Shift + pad removes it.
// Functions over a small I/O facade so MiniPlayer's closures (and tests) supply the track-bound writes.
import type { TrackCue } from "./types";
import type { CuePadSlots } from "./cuePads";

export type PadIo = {
  /** Track on the deck right now (a write bound to an earlier track must not be applied to this one). */
  trackId(): number | null;
  cues(): TrackCue[];
  slots(): CuePadSlots;
  surfaceOpen(): boolean;
  seek(positionMs: number): void;
  capturePending(): boolean;
  /** Saves a cue at the playhead (resolves undefined when it was refused). */
  capture(): Promise<TrackCue | undefined>;
  assign(slot: number, cueId: number | null): void;
  deleteCue(cueId: number): Promise<void>;
  createCue(input: { position_ms: number; kind: "cue"; label: string | null }): Promise<TrackCue>;
  toast: { info(message: string): void; error(message: string): void; undo(message: string, onUndo: () => void): void };
};

const cueAt = (io: PadIo, slot: number) => {
  const id = io.slots()[slot];
  return id == null ? undefined : io.cues().find(cue => cue.id === id);
};

/** Pad pressed: jump to its cue, or (empty pad) save a cue at the playhead into this pad. */
export async function padPress(io: PadIo, slot: number): Promise<void> {
  const cue = cueAt(io, slot);
  if (cue) { io.seek(cue.position_ms); return; }
  if (io.surfaceOpen()) return;
  if (io.capturePending()) { io.toast.info("Η αποθήκευση cue βρίσκεται ήδη σε εξέλιξη."); return; }
  const created = await io.capture();
  if (created) io.assign(slot, created.id);
}

/**
 * Shift + pad: a `cue` is deleted (with an undo that recreates its position and label); an entry/exit cue is only
 * unassigned from the pad, since the entry drives the main cue and bar phase.
 */
export async function padDelete(io: PadIo, slot: number): Promise<void> {
  const cue = cueAt(io, slot);
  if (!cue || io.surfaceOpen()) return;
  if (cue.kind !== "cue") { io.assign(slot, null); io.toast.info("Το pad αδειάστηκε (το cue παραμένει)."); return; }
  const trackId = io.trackId();
  const { position_ms, label } = cue;
  try { await io.deleteCue(cue.id); } catch { io.toast.error("Το cue δεν διαγράφηκε."); return; }
  io.toast.undo("Το cue διαγράφηκε", async () => {
    try {
      const restored = await io.createCue({ position_ms, kind: "cue", label });
      // Back into its pad only if that pad is still free and the same track is loaded; otherwise it stays unassigned.
      const occupant = io.slots()[slot];
      const free = occupant == null || !io.cues().some(c => c.id === occupant);
      if (io.trackId() === trackId && free) io.assign(slot, restored.id);
    } catch { io.toast.error("Το cue δεν επαναφέρθηκε."); }
  });
}
