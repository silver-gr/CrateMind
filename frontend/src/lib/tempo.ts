import type { Track } from "./types";

type TempoFields = Pick<Track, "bpm" | "bpm_analyzed" | "bpm_consensus" | "bpm_consensus_sources" | "display_bpm_hint" | "metadata_provenance">;

/** BPM sources stay separate; invalid readings never mask a usable fallback. */
function reading(track?: TempoFields | null): { value: number; source: string } | null {
  if (!track) return null;
  const valid = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value > 0;
  const source = track.bpm_consensus_sources;
  if (source?.startsWith("manual:") && valid(track.bpm_consensus)) {
    return { value: track.bpm_consensus, source };
  }
  if (valid(track.bpm)) return { value: track.bpm, source: "metadata" };
  if (valid(track.display_bpm_hint)) {
    return { value: track.display_bpm_hint, source: `metadata:${track.metadata_provenance?.bpm?.basis || "title_annotation"}` };
  }
  if (valid(track.bpm_consensus)) {
    return { value: track.bpm_consensus, source: source || "consensus" };
  }
  return valid(track.bpm_analyzed) ? { value: track.bpm_analyzed, source: "local" } : null;
}

/** Same precedence as backend/app/services/tempo.py and desktop's tempo resolver. */
export function effectiveBpm(track?: TempoFields | null): number | null {
  return reading(track)?.value ?? null;
}

export function bpmSource(track?: TempoFields | null): string | null {
  return reading(track)?.source ?? null;
}

export function bpmDescription(track: Track): string | undefined {
  const source = bpmSource(track);
  if (!source) return undefined;
  if (source.startsWith("manual:")) return "Χειροκίνητη επιλογή BPM";
  if (source === "metadata") return "BPM από tag αρχείου";
  if (source.startsWith("metadata:")) return "BPM από μεταδεδομένα τίτλου ή καλλιτέχνη";
  if (source === "local") {
    const confidence = track.bpm_analyzed_confidence;
    return `Ανάλυση ήχου (${track.bpm_analyzed_method || "librosa"})${confidence ? ` · ${Math.round(confidence * 100)}% εμπιστοσύνη` : ""}`;
  }
  return "Συμφωνία αναλύσεων BPM";
}
