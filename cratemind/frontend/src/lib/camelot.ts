/**
 * Camelot wheel — client-side harmonic mapping. Mirrors the harmonic-compatibility
 * idea used server-side in the recommender (Camelot map), surfaced here for the
 * Key & Harmony view, the SetBuilder key wheel, and key chips. Pure, no network.
 *
 * Camelot: 12 numbers × 2 sides. B = major, A = minor. Relative major/minor share
 * a number (C major 8B ↔ A minor 8A). Harmonically compatible = same code, ±1 on
 * the same side, or the same number on the other side.
 */
export type Camelot = { n: number; side: "A" | "B" };

const NOTE_TO_PC: Record<string, number> = {
  c: 0, "b#": 0, "c#": 1, db: 1, d: 2, "d#": 3, eb: 3, e: 4, fb: 4,
  "e#": 5, f: 5, "f#": 6, gb: 6, g: 7, "g#": 8, ab: 8, a: 9, "a#": 10,
  bb: 10, b: 11, cb: 11,
};

// Major pitch-class → Camelot number (C=8B, G=9B, D=10B, …, around the wheel).
const MAJOR_PC_TO_N: Record<number, number> = {
  0: 8, 1: 3, 2: 10, 3: 5, 4: 12, 5: 7, 6: 2, 7: 9, 8: 4, 9: 11, 10: 6, 11: 1,
};

/** Parse a free-form key string ("8A", "Am", "F# min", "Gbm", "C") → Camelot, or null. */
export function toCamelot(keyText?: string | null): Camelot | null {
  if (!keyText) return null;
  const s = keyText.trim().toLowerCase().replace(/\s+/g, "");
  // already Camelot, e.g. "8a" / "12b"
  const cm = s.match(/^(1[0-2]|[1-9])([ab])$/);
  if (cm) return { n: Number(cm[1]), side: cm[2].toUpperCase() as "A" | "B" };

  // note + optional accidental + optional maj/min marker
  const m = s.match(/^([a-g])([#b♯♭]?)(maj(or)?|min(or)?|m|d|moll|dur)?$/);
  if (!m) return null;
  let note = m[1] + (m[2] === "♯" ? "#" : m[2] === "♭" ? "b" : m[2] || "");
  note = note.replace("#", "#").replace("b", "b");
  const pc = NOTE_TO_PC[note];
  if (pc === undefined) return null;
  const marker = m[3] || "";
  const isMinor = marker === "m" || marker.startsWith("min") || marker === "moll";
  if (isMinor) {
    // relative-minor of major a minor-third up shares the number
    const n = MAJOR_PC_TO_N[(pc + 3) % 12];
    return { n, side: "A" };
  }
  return { n: MAJOR_PC_TO_N[pc], side: "B" };
}

export function camelotCode(c: Camelot): string {
  return `${c.n}${c.side}`;
}

/** Harmonically compatible neighbours (energy boost / mood shift / relative). */
export function neighbors(c: Camelot): Camelot[] {
  const up = ((c.n % 12) + 1) as number;
  const down = ((c.n + 10) % 12) + 1;
  const other: "A" | "B" = c.side === "A" ? "B" : "A";
  return [
    { n: up, side: c.side },
    { n: down, side: c.side },
    { n: c.n, side: other },
  ];
}

export function isCompatible(a: Camelot | null, b: Camelot | null): boolean {
  if (!a || !b) return false;
  if (a.n === b.n) return true; // same number (either side / relative)
  if (a.side === b.side) {
    const diff = Math.abs(a.n - b.n);
    return diff === 1 || diff === 11; // ±1 with wrap
  }
  return false;
}

/** Clock order 1..12 for rendering the wheel. */
export const WHEEL_NUMBERS = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

/** All 24 Camelot codes (for iterating count buckets). */
export const ALL_CAMELOT: string[] = WHEEL_NUMBERS.flatMap((n) => [`${n}A`, `${n}B`]);
