// A track's sections (bass on / off) and phrase lines, as the backend measures them (services/track_structure.py).
// Pure helpers for the Phrase Finder page and the deck's phrase lines.

export type StructureSection = { start_s: number; beats: number; bass: boolean; level: number };
export type TrackStructure = {
  track_id: number; version: number; quality: number;
  sections: StructureSection[];
  /** Seconds: where the bass comes in. */
  anchors: number[];
  /** Seconds: every phrase line (8 bars apart, counted from each anchor), anchors included. */
  phrases: number[];
};
/** What the list needs for a row's mini map. */
export type StructureSummary = Pick<TrackStructure, "quality" | "sections">;

/** Below this the bass on/off split is weak: the lines are shown, marked as uncertain. */
export const STRUCTURE_SURE = 0.8;

export type SectionKind = "intro" | "main" | "break" | "outro";
export const SECTION_LABELS: Record<SectionKind, string> = { intro: "Εισαγωγή", main: "Κύριο μέρος", break: "Break", outro: "Κλείσιμο" };

/** What each section is, from where it sits: no bass before the first bass is the intro, after the last the outro. */
export function sectionKinds(sections: StructureSection[]): SectionKind[] {
  const first = sections.findIndex(s => s.bass);
  const last = sections.reduce((at, s, i) => (s.bass ? i : at), -1);
  return sections.map((s, i) => s.bass ? "main" : i < first || first < 0 ? "intro" : i > last ? "outro" : "break");
}

/** Beats as bars: «32 bars», or one decimal when it is not a whole number of bars. */
export function formatBars(beats: number): string {
  const bars = beats / 4;
  return `${Number.isInteger(bars) ? bars : bars.toFixed(1)} bars`;
}
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

/** One line for a list row: «Εισαγωγή 32 bars · πρώτο μπάσο 0:52 · 2 breaks · κλείσιμο 48 bars». */
export function structureSummary(sections: StructureSection[]): string {
  const kinds = sectionKinds(sections);
  const sum = (kind: SectionKind) => sections.reduce((n, s, i) => n + (kinds[i] === kind ? s.beats : 0), 0);
  const firstBass = sections.find(s => s.bass);
  const breaks = kinds.filter(k => k === "break").length;
  const parts: string[] = [];
  if (sum("intro") > 0) parts.push(`Εισαγωγή ${formatBars(sum("intro"))}`);
  if (firstBass) parts.push(`πρώτο μπάσο ${formatClock(firstBass.start_s)}`);
  parts.push(breaks === 1 ? "1 break" : `${breaks} breaks`);
  if (sum("outro") > 0) parts.push(`κλείσιμο ${formatBars(sum("outro"))}`);
  return parts.join(" · ");
}

export type MixPoint = { time_s: number; label: string; kind: "first-bass" | "break" | "return" | "last-out"; detail: string };
/**
 * The points a DJ mixes around: the first bass, each break and the return after it, and where the bass ends.
 * `detail`: how long what starts there lasts (for the first bass: how long the intro before it was).
 */
export function mixPoints(sections: StructureSection[]): MixPoint[] {
  const kinds = sectionKinds(sections);
  const points: MixPoint[] = [];
  sections.forEach((s, i) => {
    const length = formatBars(s.beats);
    if (kinds[i] === "main") points.push(i > 0 && kinds[i - 1] === "break"
      ? { time_s: s.start_s, label: "Επιστροφή μπάσου", kind: "return", detail: `παίζει ${length}` }
      : { time_s: s.start_s, label: "Πρώτο μπάσο", kind: "first-bass", detail: i > 0 ? `μετά από ${formatBars(sections[i - 1].beats)} εισαγωγής` : "από την αρχή" });
    else if (kinds[i] === "break") points.push({ time_s: s.start_s, label: "Break", kind: "break", detail: `κρατάει ${length}` });
    else if (kinds[i] === "outro" && i > 0) points.push({ time_s: s.start_s, label: "Τέλος μπάσου", kind: "last-out", detail: `κλείσιμο ${length}` });
  });
  return points;
}

/** The track's length when the catalog has none: the last section's start plus its beats at the track's beat length. */
export function structureDuration(sections: StructureSection[]): number {
  if (sections.length === 0) return 0;
  const last = sections[sections.length - 1];
  const beats = sections.slice(0, -1).reduce((n, s) => n + s.beats, 0);
  const beat = beats > 0 ? (last.start_s - sections[0].start_s) / beats : 0.5;
  return last.start_s + last.beats * beat;
}

export type MapBlock = { left: number; width: number; bass: boolean; level: number; kind: SectionKind };
/** The sections as blocks along the track: `left` and `width` in 0..1 of `duration`. */
export function mapBlocks(sections: StructureSection[], duration: number): MapBlock[] {
  if (!(duration > 0)) return [];
  const kinds = sectionKinds(sections);
  return sections.map((s, i) => {
    const start = Math.max(0, Math.min(duration, i === 0 ? 0 : s.start_s));
    const end = Math.max(start, Math.min(duration, i + 1 < sections.length ? sections[i + 1].start_s : duration));
    return { left: start / duration, width: (end - start) / duration, bass: s.bass, level: s.level, kind: kinds[i] };
  });
}

/** Whether `time` is a phrase line: `phrases` sorted, `tolerance` in seconds (a fraction of a beat). */
export function isPhraseTime(phrases: readonly number[], time: number, tolerance: number): boolean {
  let lo = 0, hi = phrases.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (Math.abs(phrases[mid] - time) <= tolerance) return true;
    if (phrases[mid] < time) lo = mid + 1; else hi = mid - 1;
  }
  return false;
}
