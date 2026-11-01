// Page snapshot polled by the desktop host (~20 Hz) to drive controller feedback.
// Keys are a contract with native/src-tauri: emit exactly these, numbers only.
// `cueSet`: a main cue is set. `rangePct`: pitch fader span in percent. `syncFlash`: Sync just succeeded (see flashSync).
export type DeckTelemetry = { playing: boolean; bpm: number; positionMs: number; durationMs: number; pads: boolean[]; level: number; barPhase: number; rate: number; keylock: boolean; cueSet: boolean; rangePct: number; syncFlash: boolean };
/** What a deck's getter reports; `syncFlash` is added here from the expiring flag. */
export type DeckTelemetryInput = Omit<DeckTelemetry, "syncFlash">;
export type DeckTelemetrySnapshot = { tagRoute: boolean; A: DeckTelemetry | null; B: DeckTelemetry | null };
type DeckKey = "A" | "B";

const getters: Partial<Record<DeckKey, () => DeckTelemetryInput>> = {};

/** The Sync LED stays lit this long after a successful Sync (ms). */
export const SYNC_FLASH_MS = 400;
const syncFlashUntil: Record<DeckKey, number> = { A: 0, B: 0 };
const flashNow = () => performance.now();
/** Lights the deck's Sync LED for SYNC_FLASH_MS; the expiry is evaluated per snapshot, so Rust stays stateless. */
export function flashSync(deck: DeckKey, now = flashNow()) { syncFlashUntil[deck] = now + SYNC_FLASH_MS; }

const finite = (n: unknown) => typeof n === "number" && Number.isFinite(n) ? n : 0;

export function registerDeck(deck: DeckKey, getter: () => DeckTelemetryInput): () => void {
  getters[deck] = getter;
  return () => { if (getters[deck] === getter) delete getters[deck]; };
}

function read(deck: DeckKey): DeckTelemetry | null {
  try {
    const d = getters[deck]?.();
    if (!d) return null;
    return {
      playing: d.playing === true, bpm: Math.max(0, finite(d.bpm)),
      positionMs: Math.max(0, finite(d.positionMs)), durationMs: Math.max(0, finite(d.durationMs)),
      pads: Array.from({ length: 8 }, (_, i) => d.pads?.[i] === true),
      level: Math.max(0, Math.min(1, finite(d.level))),
      rate: Number.isFinite(d.rate) && d.rate > 0 ? d.rate : 1, keylock: d.keylock === true,
      cueSet: d.cueSet === true, syncFlash: flashNow() < syncFlashUntil[deck],
      rangePct: Number.isFinite(d.rangePct) ? Math.max(1, Math.min(100, Math.round(d.rangePct))) : 8,
      barPhase: typeof d.barPhase === "number" && Number.isFinite(d.barPhase) ? Math.max(-1, Math.min(1, d.barPhase)) : -1,
    };
  } catch { return null; }
}

/** The controller VU's level for a deck (0..1); 0 when no getter is registered. */
export const deckLevelNow = (deck: DeckKey): number => read(deck)?.level ?? 0;

export function snapshot(): DeckTelemetrySnapshot {
  let tagRoute = false;
  try { tagRoute = globalThis.location?.pathname === "/tag"; } catch { /* no location */ }
  return { tagRoute, A: read("A"), B: read("B") };
}

/** Pad i is lit when a cue with the id assigned to slot i exists. */
export function padsHaveCues(slots: readonly (number | null)[], cueIds: readonly number[]): boolean[] {
  return Array.from({ length: 8 }, (_, i) => slots[i] != null && cueIds.includes(slots[i]!));
}

/** Position within a 4-beat bar, 0..1, counted from the anchor; -1 when the tempo or times are unusable. */
export function barPhase(currentTimeS: number, anchorS: number, bpm: number): number {
  if (!Number.isFinite(bpm) || bpm <= 0 || !Number.isFinite(currentTimeS) || !Number.isFinite(anchorS)) return -1;
  const beats = (currentTimeS - anchorS) * bpm / 60;
  return (((beats % 4) + 4) % 4) / 4;
}

/** dBFS mapped to an empty meter; 0 dBFS is full. */
export const DB_FLOOR = -40;

/** Estimated post-fader VU: envelope rms (raw full-scale) at the playhead x deck gain, on a dB meter; 0 unless audibly playing. */
export function deckLevel(o: {
  playing: boolean; stalled: boolean; positionSec: number; durationSec: number;
  envelope?: { rms?: number[]; duration?: number } | null; gain: number;
}): number {
  const rms = o.envelope?.rms;
  if (!o.playing || o.stalled || !rms?.length) return 0;
  const span = finite(o.envelope?.duration) > 0 ? o.envelope!.duration! : finite(o.durationSec);
  if (span <= 0) return 0;
  const i = Math.min(rms.length - 1, Math.max(0, Math.floor(finite(o.positionSec) / span * rms.length)));
  const amp = finite(rms[i]) * finite(o.gain);
  return amp <= 0 ? 0 : Math.max(0, Math.min(1, (20 * Math.log10(amp) - DB_FLOOR) / -DB_FLOOR));
}

(globalThis as Record<string, unknown>).__cratemindDecks = snapshot;
