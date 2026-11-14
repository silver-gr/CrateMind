import { methodLabel, THERAPY_METHOD } from "./tempoRanges";
import type { Track } from "./types";

type TempoFields = Pick<Track, "bpm" | "bpm_analyzed" | "bpm_consensus" | "bpm_consensus_sources" | "bpm_grid" | "display_bpm_hint" | "metadata_provenance">;
type Reading = { value: number; source: string };

const OCTAVES = [0.25, 0.5, 1, 2, 4];
/** A grid this close to the value it replaces is the same tempo (the deck's rule too). */
const SAME_TEMPO = 0.03;
const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/** The automatic sources below CrateMind's own grid: file tag, title or artist hint, consensus, local analysis. */
function prior(track: TempoFields): Reading | null {
  if (valid(track.bpm)) return { value: track.bpm, source: "metadata" };
  if (valid(track.display_bpm_hint)) {
    return { value: track.display_bpm_hint, source: `metadata:${track.metadata_provenance?.bpm?.basis || "title_annotation"}` };
  }
  if (valid(track.bpm_consensus)) return { value: track.bpm_consensus, source: track.bpm_consensus_sources || "consensus" };
  return valid(track.bpm_analyzed) ? { value: track.bpm_analyzed, source: "local" } : null;
}

/** BPM sources stay separate; invalid readings never mask a usable fallback. Manual first, then the grid tempo:
 * it replaces the value it agrees with (which keeps deciding the octave); where they disagree, a tag or hint stays
 * and a machine estimate gives way. */
function reading(track?: TempoFields | null): Reading | null {
  if (!track) return null;
  const source = track.bpm_consensus_sources;
  if (source?.startsWith("manual:") && valid(track.bpm_consensus)) return { value: track.bpm_consensus, source };
  const before = prior(track);
  const grid = track.bpm_grid;
  if (!valid(grid)) return before;
  if (!before) return { value: grid, source: "grid" };
  const folded = OCTAVES.map(f => grid * f).reduce((best, b) => (Math.abs(b - before.value) < Math.abs(best - before.value) ? b : best));
  if (Math.abs(folded - before.value) / before.value <= SAME_TEMPO) return { value: Math.round(folded * 100) / 100, source: "grid" };
  const tagged = valid(track.bpm) || valid(track.display_bpm_hint);
  return tagged ? before : { value: grid, source: "grid" };
}

/** Same precedence as backend/app/services/tempo.py. */
export function effectiveBpm(track?: TempoFields | null): number | null {
  return reading(track)?.value ?? null;
}

export function bpmSource(track?: TempoFields | null): string | null {
  return reading(track)?.source ?? null;
}

/** Therapy analysis ran cleanly and found no steady beat (ambient, voice): no BPM by design. */
function noClearTempo(track: Track): boolean {
  return effectiveBpm(track) == null && track.bpm_analyzed_method === THERAPY_METHOD &&
    !!track.analyzed_at && !track.analysis_error;
}

export function bpmDescription(track: Track): string | undefined {
  if (noClearTempo(track)) return "Χωρίς σταθερό ρυθμό";
  const source = bpmSource(track);
  if (!source) return undefined;
  if (source.startsWith("manual:")) return "Χειροκίνητη επιλογή BPM";
  if (source === "grid") return "BPM από το beatgrid του CrateMind";
  if (source === "metadata") return "BPM από tag αρχείου";
  if (source.startsWith("metadata:")) return "BPM από μεταδεδομένα τίτλου ή καλλιτέχνη";
  if (source === "local") {
    const confidence = track.bpm_analyzed_confidence;
    return `${methodLabel(track.bpm_analyzed_method) ?? "Ανάλυση BPM"}${confidence ? ` · ${Math.round(confidence * 100)}% εμπιστοσύνη` : ""}`;
  }
  return "Συμφωνία αναλύσεων BPM";
}
