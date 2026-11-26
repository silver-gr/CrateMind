// A track's sections (bass on / off) and phrase lines, as the backend measures them (services/track_structure.py).
// Pure helpers for the Phrase Finder page and the deck's phrase lines.
import { beatPosition, shiftByBeats, snapToBar, timeAfterBars, type BeatGrid } from "./beatGrid";

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
  const line = parts.join(" · ");
  return line.charAt(0).toUpperCase() + line.slice(1);
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

/** A section start as the scrolling deck waveform prints it: «Break · 16 bars». */
export type SectionMark = { time_s: number; text: string; bass: boolean };
const MARK_LABELS: Record<SectionKind, string> = { intro: "Εισαγωγή", main: "Μπάσο", break: "Break", outro: "Κλείσιμο" };
export function sectionMarks(sections: StructureSection[]): SectionMark[] {
  const kinds = sectionKinds(sections);
  return sections.map((s, i) => ({ time_s: s.start_s, text: `${MARK_LABELS[kinds[i]]} · ${formatBars(s.beats)}`, bass: s.bass }));
}

/**
 * A cue the structure suggests for a pad (`slot` is 0-based). `source_s` is the section start it stands for (the
 * point itself for «Πριν το drop», which no section starts at); `beat_s` is the beat length there.
 */
export type CueSuggestion = { slot: number; label: string; time_s: number; source_s: number; beat_s: number };

const LONG_BREAK_BEATS = 32; // a break here is 8 bars or more: shorter gaps (old rows keep 2-bar pauses as sections) neither count nor block
const LEAD_IN_BEATS = 32;
const CLOSING_BEATS = 16;
const MOST_BREAKS = 3;
const PRE_DROP_BARS = 8;
const BEAT_EPS = 1e-6;

/**
 * The cues suggested for pads 5–8, each on the grid's nearest bar line: «Πρώτο μπάσο», «Break» (start of the longest
 * break), «Πριν το drop» (8 bars before the bass returns from it) and «Τέλος μπάσου». Only a track of the common
 * structure gets any: a sure split, a lead-in of 8 bars or more, a first bass that comes in as a clean step in the
 * first half, a closing of 4 bars or more that starts in the second half, at most three breaks of 8 bars or more (the
 * bass returning from the longest as a clean step), and every point within a beat of a bar line of a real grid. A
 * track with no long break gets the first and the last only; a break of exactly 8 bars gets no «Πριν το drop» (it
 * would sit on «Break»).
 */
export function cueSuggestions(structure: Pick<TrackStructure, "quality" | "sections" | "anchors">, grid: BeatGrid | null, duration: number): CueSuggestion[] {
  const { sections, anchors } = structure;
  if (!grid || grid.estimated || structure.quality < STRUCTURE_SURE) return [];
  const kinds = sectionKinds(sections);
  const first = kinds.indexOf("main");
  const outro = kinds.indexOf("outro");
  if (first < 1 || outro < 0) return [];
  const half = (duration > 0 ? duration : structureDuration(sections)) / 2;
  const beats = (from: number, to: number) => sections.slice(from, to).reduce((n, s) => n + s.beats, 0);
  const apart = (a: number, b: number) => Math.abs(beatPosition(grid, a) - beatPosition(grid, b));
  const cleanStep = (t: number) => anchors.some(a => apart(a, t) <= 1 + BEAT_EPS);
  const firstS = sections[first].start_s;
  const lastS = sections[outro].start_s;
  if (beats(0, first) < LEAD_IN_BEATS || firstS > half || !cleanStep(firstS)) return [];
  if (beats(outro, sections.length) < CLOSING_BEATS || lastS < half) return [];
  const breaks = sections.map((_, i) => i).filter(i => kinds[i] === "break" && sections[i].beats >= LONG_BREAK_BEATS);
  if (breaks.length > MOST_BREAKS) return [];
  const longest = breaks.reduce<number | null>((best, i) => (best == null || sections[i].beats > sections[best].beats ? i : best), null);
  const returnS = longest == null ? null : sections[longest + 1].start_s;
  if (returnS != null && !cleanStep(returnS)) return [];

  const sources = [firstS, lastS, ...(longest == null || returnS == null ? [] : [sections[longest].start_s, returnS])];
  const bar = (t: number) => snapToBar(grid, t, "nearest");
  if (sources.some(t => apart(t, bar(t)) > 1 + BEAT_EPS)) return [];
  const at = (slot: number, label: string, time_s: number, source_s: number): CueSuggestion =>
    ({ slot, label, time_s, source_s, beat_s: shiftByBeats(grid, time_s, 1) });
  const out = [at(4, "Πρώτο μπάσο", bar(firstS), firstS)];
  if (longest != null && returnS != null) {
    const breakS = bar(sections[longest].start_s);
    const preDropS = timeAfterBars(grid, bar(returnS), -PRE_DROP_BARS);
    out.push(at(5, "Break", breakS, sections[longest].start_s));
    if (preDropS > breakS + BEAT_EPS) out.push(at(6, "Πριν το drop", preDropS, preDropS));
  }
  out.push(at(7, "Τέλος μπάσου", bar(lastS), lastS));
  return out;
}

/**
 * The suggestions that show, one entry per pad: only on an empty pad, and never where a saved cue already sits within
 * a beat of the point.
 */
export function ghostPads(suggestions: readonly CueSuggestion[], slots: readonly (number | null)[], cues: readonly { id: number; position_ms: number }[]): (CueSuggestion | null)[] {
  const ghosts: (CueSuggestion | null)[] = slots.map(() => null);
  for (const s of suggestions) {
    const taken = cues.some(cue => cue.id === slots[s.slot] || Math.abs(cue.position_ms / 1000 - s.time_s) <= s.beat_s + BEAT_EPS);
    if (!taken && s.slot < ghosts.length) ghosts[s.slot] = s;
  }
  return ghosts;
}

/** A suggestion as a pad's tooltip: «Πρόταση: Break 3:12 · πάτησε για να πας εκεί». */
export const suggestionTitle = (s: CueSuggestion) => `Πρόταση: ${s.label} ${formatClock(s.time_s)} · πάτησε για να πας εκεί`;

export type PadMixPoint = Omit<MixPoint, "kind"> & { kind: MixPoint["kind"] | "pre-drop"; pad: number | null };
/** The mix points with the pad number (1-based) each is suggested on, plus the suggested points that are not mix points, in time order. */
export function padMixPoints(points: readonly MixPoint[], suggestions: readonly CueSuggestion[]): PadMixPoint[] {
  const rows: PadMixPoint[] = points.map(p => ({ ...p, pad: (suggestions.find(s => s.source_s === p.time_s)?.slot ?? -1) + 1 || null }));
  for (const s of suggestions) {
    if (!points.some(p => p.time_s === s.source_s)) rows.push({ time_s: s.time_s, label: s.label, kind: "pre-drop", detail: `${PRE_DROP_BARS} bars πριν επιστρέψει το μπάσο`, pad: s.slot + 1 });
  }
  return rows.sort((a, b) => a.time_s - b.time_s);
}
