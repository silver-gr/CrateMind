// Tracks API — list/search/count, detail, DJ-profile editing, play logging,
// batch-profile, and audio streaming. Port of backend/app/api/tracks.py.
// Route ordering matters: literal paths before /:id within this family.

import type { DatabaseSync } from "node:sqlite";
import type { AppContext, RouteDef } from "./dispatch.ts";
import { bindable, HttpError, json, readJson, toBools } from "../utils/http.ts";
import { reindexTrack, withTx } from "../db/database.ts";
import { nowIso } from "../utils/time.ts";
import { countTracks, searchTracks } from "../services/searchExecutor.ts";
import { AUDIO_MIME, streamResponse, UnsupportedMediaError } from "../services/streaming.ts";
import { trackSoundCloudDetail } from "../services/soundcloud.ts";
import { effectiveBpm } from "../services/tempo.ts";
import type {
  ArtistProfileRow,
  BatchProfileUpdate,
  PlayLog,
  ProfileUpdate,
  Tag,
  Track,
  TrackDJProfile,
} from "../types/models.ts";

const PROFILE_BOOL_KEYS: (keyof TrackDJProfile)[] = [
  "can_cut_into",
  "can_cut_out_of",
  "dramatic_transition_candidate",
  "human_confirmed",
];

/** Whitelisted, hard-coded column names for the dynamic profile UPDATE below —
 * only these keys of a ProfileUpdate body are ever interpolated into SQL, and
 * only as column *names*; all values remain bound parameters. */
const PROFILE_COLUMNS: (keyof TrackDJProfile)[] = [
  "energy",
  "intensity",
  "darkness",
  "melody",
  "weirdness",
  "mixability",
  "confidence",
  "chaos_level",
  "set_role",
  "transition_role",
  "groove_type",
  "vocal_density",
  "breakdown_profile",
  "drop_profile",
  "bassline_type",
  "lead_character",
  "psy_substyle",
  "festival_time",
  "ritual_factor",
  "crowd_risk",
  "personal_status",
  "tempo_bridge_score",
  "bpm_jump_tolerance",
  "can_cut_into",
  "can_cut_out_of",
  "dramatic_transition_candidate",
  "notes",
  "human_confirmed",
];

function serializeProfile(profile: TrackDJProfile): Record<string, unknown> {
  return toBools(profile, PROFILE_BOOL_KEYS) as unknown as Record<string, unknown>;
}

function jsonArray(value: string | null): string[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Port of tracks.py:_artist_prefill_payload. `needs_review`/`bpm_conflict`
 * must be real JSON booleans — top-level toBools() never reaches into this
 * nested object, so they're converted explicitly here. */
function artistPrefillPayload(
  track: Track,
  artistProfile: ArtistProfileRow | null | undefined,
): Record<string, unknown> | null {
  if (!artistProfile) return null;
  const trackBpm = effectiveBpm(track);
  const bpmMin = artistProfile.typical_bpm_min;
  const bpmMax = artistProfile.typical_bpm_max;
  let bpmConflict = false;
  if (typeof trackBpm === "number" && typeof bpmMin === "number" && typeof bpmMax === "number") {
    bpmConflict = !(bpmMin <= trackBpm && trackBpm <= bpmMax);
  }

  return {
    artist_profile_id: artistProfile.id,
    canonical_name: artistProfile.canonical_name,
    scene_cluster: artistProfile.scene_cluster,
    primary_subgenre: artistProfile.primary_subgenre,
    secondary_subgenres: jsonArray(artistProfile.secondary_subgenres_json),
    energy_range: [artistProfile.energy_min, artistProfile.energy_max],
    set_role_hints: jsonArray(artistProfile.set_role_hints_json),
    confidence_label: artistProfile.confidence_label,
    needs_review: artistProfile.needs_review === 1,
    bpm_conflict: bpmConflict,
    reason: "artist profile prefill",
  };
}

function getTrackRow(db: DatabaseSync, id: number): Track | undefined {
  return db.prepare(`SELECT * FROM tracks WHERE id = ?`).get(id) as Track | undefined;
}

function getProfileRow(db: DatabaseSync, trackId: number): TrackDJProfile | undefined {
  return db.prepare(`SELECT * FROM track_dj_profile WHERE track_id = ?`).get(trackId) as
    | TrackDJProfile
    | undefined;
}

function getArtistProfileRow(db: DatabaseSync, normalizedName: string): ArtistProfileRow | undefined {
  return db.prepare(`SELECT * FROM artist_profiles WHERE normalized_name = ?`).get(normalizedName) as
    | ArtistProfileRow
    | undefined;
}

/** Port of tracks.py:_track_payload. */
function trackPayload(db: DatabaseSync, track: Track): Record<string, unknown> {
  const profile = getProfileRow(db, track.id);
  const artistProfile = track.artist_normalized ? getArtistProfileRow(db, track.artist_normalized) : undefined;
  const tags = db
    .prepare(
      `SELECT tg.* FROM tags tg JOIN track_tags tt ON tt.tag_id = tg.id WHERE tt.track_id = ?`,
    )
    .all(track.id) as unknown as Tag[];

  return {
    track: {
      ...(toBools(track, ["missing"]) as unknown as Record<string, unknown>),
      artist_prefill: artistPrefillPayload(track, artistProfile),
    },
    profile: profile ? serializeProfile(profile) : null,
    tags,
    ...trackSoundCloudDetail(db, track.id),
  };
}

/** Bulk profile / SoundCloud / artist-profile lookups for listPayload (no N+1). */
function loadListLookups(db: DatabaseSync, tracks: Track[]) {
  const ids = tracks.map((t) => t.id);
  const normalizedNames = [...new Set(tracks.map((t) => t.artist_normalized).filter((n): n is string => !!n))];

  const profileMap = new Map<number, TrackDJProfile>();
  const soundcloudMap = new Map<number, { playback_count: number | null; likes_count: number | null }>();
  if (ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT * FROM track_dj_profile WHERE track_id IN (${placeholders})`)
      .all(...ids) as unknown as TrackDJProfile[];
    for (const row of rows) profileMap.set(row.track_id, row);
    const soundcloudRows = db
      .prepare(
        `SELECT m.track_id, s.playback_count, s.likes_count
           FROM track_soundcloud_matches m
           JOIN soundcloud_tracks s ON s.soundcloud_track_id = m.soundcloud_track_id
          WHERE m.track_id IN (${placeholders})`,
      )
      .all(...ids) as unknown as {
        track_id: number;
        playback_count: number | null;
        likes_count: number | null;
      }[];
    for (const row of soundcloudRows) soundcloudMap.set(row.track_id, row);
  }

  const artistMap = new Map<string, ArtistProfileRow>();
  if (normalizedNames.length > 0) {
    const placeholders = normalizedNames.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT * FROM artist_profiles WHERE normalized_name IN (${placeholders})`)
      .all(...normalizedNames) as unknown as ArtistProfileRow[];
    for (const row of rows) artistMap.set(row.normalized_name, row);
  }

  return { profileMap, soundcloudMap, artistMap };
}

/** Port of tracks.py:_list_payload — one bulk profile/artist-profile lookup
 * (no N+1), merging a small DJ-profile summary into each row. */
function listPayload(db: DatabaseSync, tracks: Track[]): Record<string, unknown>[] {
  const { profileMap, soundcloudMap, artistMap } = loadListLookups(db, tracks);

  return tracks.map((t) => {
    const p = profileMap.get(t.id);
    const soundcloud = soundcloudMap.get(t.id);
    return {
      ...(toBools(t, ["missing"]) as unknown as Record<string, unknown>),
      personal_status: p ? p.personal_status : null,
      energy: p ? p.energy : null,
      darkness: p ? p.darkness : null,
      set_role: p ? p.set_role : null,
      soundcloud_playback_count: soundcloud?.playback_count ?? null,
      soundcloud_likes_count: soundcloud?.likes_count ?? null,
      artist_prefill: artistPrefillPayload(t, t.artist_normalized ? artistMap.get(t.artist_normalized) : undefined),
    };
  });
}

function parseLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (raw === null || raw === "") return 200;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 200;
  return Math.min(n, 10000);
}

function parseOffset(url: URL): number {
  const raw = url.searchParams.get("offset");
  if (raw === null || raw === "") return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function plainList(db: DatabaseSync, limit: number, offset: number): Track[] {
  return db
    .prepare(`SELECT * FROM tracks ORDER BY artist, title LIMIT ? OFFSET ?`)
    .all(limit, offset) as unknown as Track[];
}

function trackIdFromParams(params: Record<string, string | undefined>): number {
  const id = params.id !== undefined ? Number(params.id) : NaN;
  if (!Number.isInteger(id)) {
    throw new HttpError(404, "track not found");
  }
  return id;
}

// ---- handlers ----------------------------------------------------------

function listTracks(req: Request, _params: Record<string, string | undefined>, ctx: AppContext): Response {
  const url = new URL(req.url);
  const q = url.searchParams.get("q");
  const limit = parseLimit(url);
  const offset = parseOffset(url);
  const tracks = q ? searchTracks(ctx.db, q, limit, offset) : plainList(ctx.db, limit, offset);
  return json(listPayload(ctx.db, tracks));
}

function searchTracksRoute(req: Request, _params: Record<string, string | undefined>, ctx: AppContext): Response {
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const limit = parseLimit(url);
  const offset = parseOffset(url);
  const tracks = searchTracks(ctx.db, q, limit, offset);
  return json(listPayload(ctx.db, tracks));
}

function countTracksRoute(req: Request, _params: Record<string, string | undefined>, ctx: AppContext): Response {
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  return json({ count: countTracks(ctx.db, q) });
}

function keyStats(_req: Request, _params: Record<string, string | undefined>, ctx: AppContext): Response {
  const counts: Record<string, number> = {};
  for (let n = 1; n <= 12; n++) {
    counts[`${n}A`] = 0;
    counts[`${n}B`] = 0;
  }
  const stats = { total: 0, keyed: 0, missing: 0, unrecognized: 0, counts, metadata: 0, analyzed: 0 };
  const groups = ctx.db.prepare(`
    SELECT cratemind_key(key_text, key_analyzed) AS code,
           CASE WHEN cratemind_key_text(key_text, NULL) IS NOT NULL THEN 'metadata'
                WHEN cratemind_key_text(NULL, key_analyzed) IS NOT NULL THEN 'analyzed'
                ELSE 'missing' END AS source,
           COUNT(*) AS count
      FROM tracks
     GROUP BY code, source
  `).all() as unknown as { code: string | null; source: "metadata" | "analyzed" | "missing"; count: number }[];
  for (const group of groups) {
    stats.total += group.count;
    if (group.code !== null) {
      stats.keyed += group.count;
      stats.counts[group.code] += group.count;
      if (group.source === "metadata" || group.source === "analyzed") stats[group.source] += group.count;
    } else if (group.source === "missing") {
      stats.missing += group.count;
    } else {
      stats.unrecognized += group.count;
    }
  }
  return json(stats);
}

function getTrack(_req: Request, params: Record<string, string | undefined>, ctx: AppContext): Response {
  const id = trackIdFromParams(params);
  const track = getTrackRow(ctx.db, id);
  if (!track) throw new HttpError(404, "track not found");
  return json(trackPayload(ctx.db, track));
}

function normalizeExt(ext: string): string {
  return ext.toLowerCase().replace(/^\./, "");
}

async function streamAudio(
  req: Request,
  params: Record<string, string | undefined>,
  ctx: AppContext,
): Promise<Response> {
  const id = trackIdFromParams(params);
  const track = getTrackRow(ctx.db, id);
  if (!track) throw new HttpError(404, "track not found");

  // Unsupported-extension check happens before touching the filesystem,
  // mirroring streaming.py's stream_audio (415 precedes the 410 file check).
  if (!(normalizeExt(track.extension) in AUDIO_MIME)) {
    throw new HttpError(415, `unsupported audio format for in-browser audition: .${track.extension}`);
  }

  let size: number;
  try {
    const stat = await Deno.stat(track.absolute_path);
    if (!stat.isFile) throw new Error("not a file");
    size = stat.size;
  } catch {
    throw new HttpError(410, "audio file no longer present on disk");
  }

  try {
    return await streamResponse(track.absolute_path, track.extension, req.headers.get("range"), size);
  } catch (e) {
    if (e instanceof UnsupportedMediaError) {
      throw new HttpError(415, e.message);
    }
    throw e;
  }
}

/** Partial upsert of a track's DJ profile: only keys present in `update`
 * (exclude-unset semantics) are written; other columns are left untouched.
 * Port of tracks.py:_apply_profile. */
function applyProfile(db: DatabaseSync, trackId: number, update: ProfileUpdate): TrackDJProfile {
  const existing = db.prepare(`SELECT track_id FROM track_dj_profile WHERE track_id = ?`).get(trackId);
  if (existing === undefined) {
    db.prepare(
      `INSERT INTO track_dj_profile (track_id, personal_status, human_confirmed, updated_at)
       VALUES (?, 'unknown', 0, ?)`,
    ).run(trackId, nowIso());
  }

  const provided = (Object.keys(update) as (keyof ProfileUpdate)[]).filter((k) =>
    (PROFILE_COLUMNS as string[]).includes(k)
  );
  const setClauses = [...provided.map((k) => `${k} = ?`), "updated_at = ?"];
  const values: (string | number | null)[] = [
    ...provided.map((k) => bindable((update as Record<string, unknown>)[k])),
    nowIso(),
  ];

  db.prepare(`UPDATE track_dj_profile SET ${setClauses.join(", ")} WHERE track_id = ?`).run(
    ...values,
    trackId,
  );

  reindexTrack(db, trackId);

  return getProfileRow(db, trackId) as TrackDJProfile;
}

async function updateProfile(
  req: Request,
  params: Record<string, string | undefined>,
  ctx: AppContext,
): Promise<Response> {
  const id = trackIdFromParams(params);
  if (!getTrackRow(ctx.db, id)) throw new HttpError(404, "track not found");
  const update = await readJson<ProfileUpdate>(req);
  const profile = withTx(ctx.db, () => applyProfile(ctx.db, id, update));
  return json(serializeProfile(profile));
}

async function logPlay(
  req: Request,
  params: Record<string, string | undefined>,
  ctx: AppContext,
): Promise<Response> {
  const id = trackIdFromParams(params);
  if (!getTrackRow(ctx.db, id)) throw new HttpError(404, "track not found");
  const body = await readJson<PlayLog>(req);
  const now = nowIso();

  const playCount = withTx(ctx.db, () => {
    ctx.db
      .prepare(
        `INSERT INTO play_events (track_id, set_id, played_at, context, crowd_reaction, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        bindable(body.set_id),
        now,
        bindable(body.context),
        bindable(body.crowd_reaction),
        bindable(body.notes),
      );
    ctx.db
      .prepare(`UPDATE tracks SET play_count = play_count + 1, last_played_at = ? WHERE id = ?`)
      .run(now, id);
    const row = ctx.db.prepare(`SELECT play_count FROM tracks WHERE id = ?`).get(id) as {
      play_count: number;
    };
    return row.play_count;
  });

  return json({ track_id: id, play_count: playCount, last_played_at: now });
}

async function batchProfile(
  req: Request,
  _params: Record<string, string | undefined>,
  ctx: AppContext,
): Promise<Response> {
  const body = await readJson<BatchProfileUpdate>(req);
  const updated = withTx(ctx.db, () => {
    let count = 0;
    for (const trackId of body.track_ids) {
      if (!getTrackRow(ctx.db, trackId)) continue;
      applyProfile(ctx.db, trackId, body.profile);
      count += 1;
    }
    return count;
  });
  return json({ updated });
}

export function routes(): RouteDef[] {
  return [
    { method: "GET", pattern: new URLPattern({ pathname: "/api/tracks" }), handler: listTracks },
    { method: "GET", pattern: new URLPattern({ pathname: "/api/tracks/search" }), handler: searchTracksRoute },
    { method: "GET", pattern: new URLPattern({ pathname: "/api/tracks/count" }), handler: countTracksRoute },
    { method: "GET", pattern: new URLPattern({ pathname: "/api/tracks/key-stats" }), handler: keyStats },
    { method: "POST", pattern: new URLPattern({ pathname: "/api/tracks/batch-profile" }), handler: batchProfile },
    { method: "GET", pattern: new URLPattern({ pathname: "/api/tracks/:id" }), handler: getTrack },
    { method: "GET", pattern: new URLPattern({ pathname: "/api/tracks/:id/audio" }), handler: streamAudio },
    { method: "PATCH", pattern: new URLPattern({ pathname: "/api/tracks/:id/profile" }), handler: updateProfile },
    { method: "POST", pattern: new URLPattern({ pathname: "/api/tracks/:id/play" }), handler: logPlay },
  ];
}
