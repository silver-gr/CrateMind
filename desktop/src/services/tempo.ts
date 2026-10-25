// Read-time tempo policy shared with the Python backend and frontend.
// Raw metadata and analysis remain intact for provenance and review.
export interface TempoFields {
  bpm?: number | null;
  bpm_consensus?: number | null;
  bpm_consensus_sources?: string | null;
  bpm_analyzed?: number | null;
}

export function positiveBpm(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

export function resolveBpm(
  track: TempoFields,
): { bpm: number | null; source: string | null } {
  const consensus = positiveBpm(track.bpm_consensus);
  if (
    consensus !== null && track.bpm_consensus_sources?.startsWith("manual:")
  ) {
    return { bpm: consensus, source: track.bpm_consensus_sources };
  }
  const metadata = positiveBpm(track.bpm);
  if (metadata !== null) return { bpm: metadata, source: "metadata" };
  if (consensus !== null) {
    return {
      bpm: consensus,
      source: track.bpm_consensus_sources || "consensus",
    };
  }
  const analyzed = positiveBpm(track.bpm_analyzed);
  return { bpm: analyzed, source: analyzed !== null ? "local" : null };
}

export function effectiveBpm(track: TempoFields): number | null {
  return resolveBpm(track).bpm;
}

export function bpmSource(track: TempoFields): string | null {
  return resolveBpm(track).source;
}

/** Parameter-free SQL expression; callers supply a hard-coded table alias. */
export function effectiveBpmSql(alias = "t"): string {
  return `cratemind_bpm(${alias}.bpm, ${alias}.bpm_analyzed, ${alias}.bpm_consensus, ${alias}.bpm_consensus_sources)`;
}
