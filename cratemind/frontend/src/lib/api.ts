import type {
  DJSet,
  DuplicateGroup,
  Job,
  Profile,
  Recommendation,
  SetAnalysis,
  SetTrackRow,
  Tag,
  Track,
  TrackDetail,
} from "./types";

const BASE = "/api";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status}: ${detail}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  health: () => req<Record<string, unknown>>("/health"),
  settings: () => req<Record<string, unknown>>("/settings"),

  // tracks
  listTracks: (q?: string, limit = 300) =>
    req<Track[]>(`/tracks?limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}`),
  getTrack: (id: number) => req<TrackDetail>(`/tracks/${id}`),
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

  // tags
  listTags: () => req<Tag[]>("/tags"),
  assignTag: (trackId: number, name: string) =>
    req<unknown>(`/tracks/${trackId}/tags`, { method: "POST", body: JSON.stringify({ name }) }),
  removeTag: (trackId: number, tagId: number) =>
    req<unknown>(`/tracks/${trackId}/tags/${tagId}`, { method: "DELETE" }),

  // scan
  startScan: (roots?: string[]) =>
    req<Job>("/scan/start", { method: "POST", body: JSON.stringify({ roots: roots ?? null }) }),
  scanStatus: (jobId?: number) =>
    req<Job | null>(`/scan/status${jobId ? `?job_id=${jobId}` : ""}`),
  startDuplicateScan: () => req<Job>("/scan/duplicates", { method: "POST", body: "{}" }),
  startFingerprint: () => req<Job>("/scan/fingerprint", { method: "POST", body: "{}" }),

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
  reorderSet: (setId: number, ordered_track_ids: number[]) =>
    req<unknown>(`/sets/${setId}/tracks/reorder`, {
      method: "PATCH",
      body: JSON.stringify({ ordered_track_ids }),
    }),
  removeSetTrack: (setId: number, trackId: number) =>
    req<unknown>(`/sets/${setId}/tracks/${trackId}`, { method: "DELETE" }),
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
    body: { set_id?: number; track_ids?: number[]; filename?: string; overwrite?: boolean },
  ) => req<{ path: string; count?: number }>(`/export/${fmt}`, {
    method: "POST",
    body: JSON.stringify(body),
  }),
};
