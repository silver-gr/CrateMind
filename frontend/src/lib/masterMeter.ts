import { DB_FLOOR } from "./deckTelemetry";

/** The peak marker stays put this long before it falls. */
export const PEAK_HOLD_MS = 1000;
/** How fast the bar and a released marker fall. */
export const FALL_DB_PER_S = 20;
/** The «LIM» light stays on this long after the limiter last worked, so a short catch is still seen. */
export const LIM_HOLD_MS = 250;

/** One meter channel in dBFS (DB_FLOOR = empty): the bar, the held peak and when the hold ends (ms). */
export interface MeterChannel {
  db: number;
  holdDb: number;
  holdUntil: number;
}

export const SILENT_CHANNEL: MeterChannel = { db: DB_FLOOR, holdDb: DB_FLOOR, holdUntil: 0 };

/** A linear sample peak (full scale = 1) in dBFS, floored at DB_FLOOR. */
export const peakDb = (amp: number): number => (amp > 0 ? Math.max(DB_FLOOR, 20 * Math.log10(amp)) : DB_FLOOR);

/** A dBFS value as the filled share of the meter, 0..1 (0 dBFS is full). */
export const meterShare = (db: number): number => Math.max(0, Math.min(1, (db - DB_FLOOR) / -DB_FLOOR));

/**
 * One frame, `dtMs` after the last: the bar jumps up to a new peak and falls at FALL_DB_PER_S; the marker takes the highest
 * peak, holds it for PEAK_HOLD_MS and then falls the same way (never below the bar).
 */
export function stepChannel(prev: MeterChannel, amp: number, now: number, dtMs: number): MeterChannel {
  const fall = (FALL_DB_PER_S * Math.max(0, dtMs)) / 1000;
  const db = Math.max(peakDb(amp), prev.db - fall, DB_FLOOR);
  if (db >= prev.holdDb) return { db, holdDb: db, holdUntil: now + PEAK_HOLD_MS };
  if (now < prev.holdUntil) return { db, holdDb: prev.holdDb, holdUntil: prev.holdUntil };
  return { db, holdDb: Math.max(db, prev.holdDb - fall), holdUntil: prev.holdUntil };
}

/** When the «LIM» light goes off: LIM_HOLD_MS after the last frame in which the limiter worked. */
export const limUntil = (prev: number, limiting: boolean, now: number): number => (limiting ? now + LIM_HOLD_MS : prev);
