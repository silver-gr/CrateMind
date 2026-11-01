import type { BackendCapabilities } from "./capabilities";
import type { DesktopConfig, LibraryRoot } from "./desktopRuntime";
import type { ExchangePreview, ExchangeExport } from "./libraryExchange";
import type {
  ArtistProfile,
  ArtistStats,
  BpmAnalysisSummary,
  BpmReviewPage,
  BpmReviewTrack,
  DJSet,
  DuplicateGroup,
  BeatGridDto,
  Job,
  DjayImportStatus,
  KeyStats,
  PairNote,
  Profile,
  Recommendation,
  SavedSearch,
  SetAnalysis,
  SetTrackRow,
  SoundCloudImportResult,
  SoundCloudReviewPage,
  SoundCloudSummary,
  Tag,
  Track,
  TrackCue,
  TrackCueCreate,
  TrackCueUpdate,
  SoundCloudTrackDetail,
} from "./types";

const BASE = "/api";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...(init?.body instanceof FormData ? {} : { headers: { "Content-Type": "application/json" } }),
    ...init,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const value = (await res.json()).detail;
      if (typeof value === "string") detail = value;
      else if (Array.isArray(value)) detail = value.map(entry => entry.msg).filter(Boolean).join(" · ") || detail;
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status}: ${detail}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/** Binary GET (detail waveform). With `etag`, a 304 means the caller's cached copy is still valid. */
async function reqBuffer(path: string, opts: { etag?: string | null; signal?: AbortSignal } = {}):
  Promise<{ status: 200; data: ArrayBuffer; etag: string | null } | { status: 304 }> {
  const res = await fetch(BASE + path, { signal: opts.signal, headers: opts.etag ? { "If-None-Match": opts.etag } : undefined });
  if (res.status === 304) return { status: 304 };
  if (!res.ok) throw new Error(`${res.status}: ${res.statusText}`);
  return { status: 200, data: await res.arrayBuffer(), etag: res.headers.get("ETag") };
}

export const api = {
  capabilities: () => req<BackendCapabilities>("/capabilities"),
  health: () => req<Record<string, unknown>>("/health"),
  settings: () => req<Record<string, unknown>>("/settings"),
  desktopConfig: () => req<DesktopConfig>("/desktop/config"),
  patchDesktopConfig: (library_roots: LibraryRoot[]) => req<DesktopConfig>("/desktop/config", {
    method: "PATCH", body: JSON.stringify({ library_roots }),
  }),
  exportExchange: (chooseDestination = false) => req<ExchangeExport>("/exchange/export", {
    method: "POST", body: JSON.stringify({ choose_destination: chooseDestination }),
  }),
  inspectExchange: (file: File) => {
    const body = new FormData(); body.append("file", file);
    return req<ExchangePreview>("/exchange/inspect", { method: "POST", body });
  },
  commitExchange: (preview: ExchangePreview, decision: "import" | "replace") =>
    req<{ accepted: boolean }>("/desktop/exchange/commit", { method: "POST", body: JSON.stringify({
      preview_id: preview.preview_id, decision, local_digest: preview.local_digest,
    }) }),

  // tracks
  listTracks: (q?: string, limit = 300) =>
    req<Track[]>(`/tracks?limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}`),
  getTrack: (id: number) => req<SoundCloudTrackDetail>(`/tracks/${id}`),
  getTrackCues: (trackId: number) => req<TrackCue[]>(`/tracks/${trackId}/cues`),
  createTrackCue: (trackId: number, input: TrackCueCreate) =>
    req<TrackCue>(`/tracks/${trackId}/cues`, { method: "POST", body: JSON.stringify(input) }),
  updateTrackCue: (trackId: number, cueId: number, input: TrackCueUpdate) =>
    req<TrackCue>(`/tracks/${trackId}/cues/${cueId}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteTrackCue: (trackId: number, cueId: number) =>
    req<void>(`/tracks/${trackId}/cues/${cueId}`, { method: "DELETE" }),
  getWaveform: (id: number) => req<{ peaks: number[]; rms?: number[]; duration?: number; version?: number }>(`/tracks/${id}/waveform`),
  getWaveformDetail: (id: number, opts?: { etag?: string | null; signal?: AbortSignal }) => reqBuffer(`/tracks/${id}/waveform/detail`, opts),
  /** The stored beat grid, or null when the track has none (404). */
  getBeatGrid: async (id: number): Promise<BeatGridDto | null> => {
    try { return await req<BeatGridDto>(`/tracks/${id}/beatgrid`); }
    catch (cause) { if (cause instanceof Error && cause.message.startsWith("404:")) return null; throw cause; }
  },
  updateProfile: (id: number, patch: Partial<Profile>) =>
    req<Profile>(`/tracks/${id}/profile`, { method: "PATCH", body: JSON.stringify(patch) }),
  batchProfile: (track_ids: number[], profile: Partial<Profile>) =>
    req<{ updated: number }>(`/tracks/batch-profile`, {
      method: "POST",
      body: JSON.stringify({ track_ids, profile }),
    }),
  logPlay: (trackId: number, body: Record<string, unknown> = {}) =>
    req<{ play_count: number }>(`/tracks/${trackId}/play`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  trackCount: (q: string) =>
    req<{ count: number }>(`/tracks/count?q=${encodeURIComponent(q)}`),
  keyStats: (signal?: AbortSignal) => req<KeyStats>("/tracks/key-stats", { signal }),

  // artists
  listArtists: (opts?: {
    q?: string;
    confidence_label?: string;
    needs_review?: boolean;
    min_track_count?: number;
    limit?: number;
    offset?: number;
  }) => {
    const params = new URLSearchParams();
    if (opts?.q) params.set("q", opts.q);
    if (opts?.confidence_label) params.set("confidence_label", opts.confidence_label);
    if (typeof opts?.needs_review === "boolean") params.set("needs_review", String(opts.needs_review));
    if (typeof opts?.min_track_count === "number") params.set("min_track_count", String(opts.min_track_count));
    if (typeof opts?.limit === "number") params.set("limit", String(opts.limit));
    if (typeof opts?.offset === "number") params.set("offset", String(opts.offset));
    const qs = params.toString();
    return req<ArtistProfile[]>(`/artists${qs ? `?${qs}` : ""}`);
  },
  getArtist: (id: number) => req<ArtistProfile>(`/artists/${id}`),
  compareArtists: () => req<{job: Job; snapshot: string}>("/artists/compare", {method: "POST", body: "{}"}),
  artistComparisonStatus: () => req<Job | null>("/artists/comparison-status"),
  chooseArtistFinding: (id: number, choice: string, subgenre?: string) => req<ArtistProfile>(`/artists/${id}/review`, {method: "POST", body: JSON.stringify({choice, subgenre})}),
  artistStats: () => req<ArtistStats>("/artists/stats"),
  rebuildArtists: () => req<Record<string, number>>("/artists/rebuild", { method: "POST", body: "{}" }),
  enrichArtists: (body: { limit?: number } = {}) =>
    req<Job>("/artists/enrich", { method: "POST", body: JSON.stringify(body) }),
  acceptArtistPrefill: (trackId: number, patch: Partial<Profile>) =>
    req<Profile>(`/artists/tracks/${trackId}/accept-prefill`, {
      method: "POST",
      body: JSON.stringify(patch),
    }),

  // saved searches / Memory Crates
  listSearches: () => req<SavedSearch[]>("/searches"),
  createSearch: (name: string, query: string) =>
    req<SavedSearch>("/searches", { method: "POST", body: JSON.stringify({ name, query }) }),
  updateSearch: (id: number, patch: Partial<SavedSearch>) =>
    req<SavedSearch>(`/searches/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteSearch: (id: number) =>
    req<unknown>(`/searches/${id}`, { method: "DELETE" }),

  // pair notes
  listPairNotes: (trackId: number) =>
    req<PairNote[]>(`/pair-notes?track_id=${trackId}`),
  listAllPairNotes: () => req<PairNote[]>("/pair-notes"),
  createPairNote: (body: Record<string, unknown>) =>
    req<PairNote>("/pair-notes", { method: "POST", body: JSON.stringify(body) }),
  logSetPlay: (setId: number, body: Record<string, unknown> = {}) =>
    req<{ tracks_logged: number }>(`/sets/${setId}/log-play`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // tags
  listTags: () => req<Tag[]>("/tags"),
  assignTag: (trackId: number, name: string) =>
    req<unknown>(`/tracks/${trackId}/tags`, { method: "POST", body: JSON.stringify({ name }) }),
  removeTag: (trackId: number, tagId: number) =>
    req<unknown>(`/tracks/${trackId}/tags/${tagId}`, { method: "DELETE" }),

  // scan
  startScan: (roots?: string[], mode: "full" | "delta" = "full") =>
    req<Job>("/scan/start", { method: "POST", body: JSON.stringify({ roots: roots ?? null, mode }) }),
  scanStatus: (jobId?: number) =>
    req<Job | null>(`/scan/status${jobId ? `?job_id=${jobId}` : ""}`),
  getDjayImport: () => req<DjayImportStatus>("/import/djay"),
  startDjayImport: () => req<Job>("/import/djay", { method: "POST", body: "{}" }),
  removeDjayBeatgrids: () => req<{ removed: number }>("/import/djay", { method: "DELETE" }),
  startDuplicateScan: () => req<Job>("/scan/duplicates", { method: "POST", body: "{}" }),
  startFingerprint: () => req<Job>("/scan/fingerprint", { method: "POST", body: "{}" }),
  startAnalyze: (opts?: { force?: boolean; limit?: number }) =>
    req<Job>("/scan/analyze", {
      method: "POST",
      body: JSON.stringify({ force: opts?.force ?? false, limit: opts?.limit ?? null }),
    }),
  bpmAnalysisSummary: () => req<BpmAnalysisSummary>("/analysis/bpm/summary"),
  bpmReview: (scope: "review" | "conflicts" = "conflicts", limit = 40, offset = 0) =>
    req<BpmReviewPage>(
      `/analysis/bpm/review?scope=${scope}&limit=${limit}&offset=${offset}`,
    ),
  recomputeBpmConsensus: () =>
    req<BpmAnalysisSummary>("/analysis/bpm/recompute", {
      method: "POST",
      body: "{}",
    }),
  retryBpmFailures: () =>
    req<{ reccobeats_reset: number }>("/analysis/bpm/retry-failures", {
      method: "POST",
      body: "{}",
    }),
  resolveBpm: (
    trackId: number,
    source:
      | "auto"
      | "metadata"
      | "local"
      | "essentia"
      | "reccobeats"
      | "getsongbpm"
      | "cyanite",
  ) =>
    req<BpmReviewTrack>(`/analysis/bpm/tracks/${trackId}/resolve`, {
      method: "POST",
      body: JSON.stringify({ source }),
    }),

  // SoundCloud likes metadata
  soundCloudSummary: () => req<SoundCloudSummary>("/soundcloud/summary"),
  soundCloudReview: (limit = 40, offset = 0) =>
    req<SoundCloudReviewPage>(`/soundcloud/review?limit=${limit}&offset=${offset}`),
  acceptSoundCloudCandidate: (trackId: number, soundCloudTrackId: number) =>
    req<unknown>(`/soundcloud/review/${trackId}/${soundCloudTrackId}/accept`, {
      method: "POST",
      body: "{}",
    }),
  rejectSoundCloudCandidate: (trackId: number, soundCloudTrackId: number) =>
    req<unknown>(`/soundcloud/review/${trackId}/${soundCloudTrackId}/reject`, {
      method: "POST",
      body: "{}",
    }),
  importSoundCloudBatch: (body: { run_id: string; items: unknown[]; complete: boolean }) =>
    req<SoundCloudImportResult>("/soundcloud/import-batch", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // duplicates
  listDuplicates: () => req<DuplicateGroup[]>("/duplicates"),
  resolveDuplicate: (
    groupId: number,
    body: { status: string; master_track_id?: number; roles?: Record<number, string> },
  ) => req<unknown>(`/duplicates/${groupId}/resolve`, { method: "POST", body: JSON.stringify(body) }),

  // sets
  listSets: () => req<DJSet[]>("/sets"),
  createSet: (title: string) =>
    req<DJSet>("/sets", { method: "POST", body: JSON.stringify({ title }) }),
  getSet: (id: number) => req<{ set: DJSet; tracks: SetTrackRow[] }>(`/sets/${id}`),
  addSetTrack: (setId: number, trackId: number) =>
    req<unknown>(`/sets/${setId}/tracks`, {
      method: "POST",
      body: JSON.stringify({ track_id: trackId }),
    }),
  reorderSet: (setId: number, ordered_track_ids: number[], ordered_positions?: number[]) =>
    req<unknown>(`/sets/${setId}/tracks/reorder`, {
      method: "PATCH",
      body: JSON.stringify({ ordered_track_ids, ordered_positions }),
    }),
  removeSetTrack: (setId: number, trackId: number, position: number) =>
    req<unknown>(`/sets/${setId}/tracks/${trackId}?position=${position}`, { method: "DELETE" }),
  setAnalysis: (setId: number) => req<SetAnalysis>(`/sets/${setId}/analysis`),
  recommendNext: (
    setId: number,
    body: Record<string, unknown>,
  ) =>
    req<Recommendation[]>(`/sets/${setId}/recommend-next`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // export
  exportArtifact: (
    fmt: "m3u" | "csv" | "json-backup" | "markdown",
    body: { all_tracks?: boolean; set_id?: number; track_ids?: number[]; filename?: string; overwrite?: boolean },
  ) => req<{ path: string; count?: number }>(`/export/${fmt}`, {
    method: "POST",
    body: JSON.stringify(body),
  }),

  // import (desktop backend only — restores a JSON backup's taste metadata)
  importBackup: (payload: unknown) =>
    req<Record<string, number>>("/import/json-backup", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
};
