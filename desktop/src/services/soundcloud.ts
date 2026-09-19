// SoundCloud snapshot persistence and conservative local-track matching.
// Provider data is read-only: this module never updates source files or local tags.

import type { DatabaseSync } from "node:sqlite";
import { withTx } from "../db/database.ts";
import { nowIso } from "../utils/time.ts";
import type {
  SoundCloudMatchCandidateRow,
  SoundCloudTrackRow,
  Track,
  TrackSoundCloudMatchRow,
} from "../types/models.ts";

const SENSITIVE_SUBSTRINGS = ["token", "authorization", "client_id", "oauth", "cookie"];
const AUDIO_EXTENSION = /\.(?:aac|aiff?|alac|flac|m4a|mp3|ogg|opus|wav|wma)\s*$/giu;
const LEADING_TRACK_NUMBER = /^\s*\d{1,3}\s*(?:[-._)]\s*|\s+)/u;
const DOWNLOAD_NOISE = /\b(?:\d{2,4}\s*(?:kbps|kb\/s)|free\s*download|download)\b/giu;
const BRACKETED_BPM = /[\[({]\s*\d{2,3}(?:\.\d+)?\s*bpm\s*[\])}]/giu;
const FEATURE_SEPARATOR = /\b(?:feat(?:\.|uring)?|f[.\s]*t|versus|vs)\.?\b/giu;

interface ParsedSoundCloudItem {
  snapshot: Omit<SoundCloudTrackRow, "available" | "last_seen_run_id" | "fetched_at">;
}

interface MatchMetrics {
  score: number;
  reasons: string[];
  automatic: boolean;
  candidate: boolean;
}

export interface SoundCloudImportResult {
  received: number;
  inserted: number;
  updated: number;
  auto_confirmed: number;
  pending_candidates: number;
  malformed: number;
  completed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSensitiveName(name: string): boolean {
  const normalized = name.toLowerCase();
  return SENSITIVE_SUBSTRINGS.some((part) => normalized.includes(part));
}

function redactUrlParams(value: string): string {
  try {
    const url = new URL(value);
    for (const [key] of url.searchParams) {
      if (isSensitiveName(key)) url.searchParams.set(key, "[REDACTED]");
    }
    return url.toString();
  } catch {
    return value;
  }
}

/** Redacts credentials before any provider JSON is stored. Values under a
 * sensitive key are replaced recursively, and sensitive URL parameters are
 * redacted without dropping the otherwise-useful URL. */
function redactRaw(value: unknown, key?: string): unknown {
  if (key !== undefined && isSensitiveName(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((entry) => redactRaw(entry));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [childKey, redactRaw(childValue, childKey)]),
    );
  }
  return typeof value === "string" ? redactUrlParams(value) : value;
}

function text(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return redactUrlParams(value.trim());
}

function integer(value: unknown): number | null {
  if (typeof value === "boolean") return null;
  const number = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isSafeInteger(number) ? number : null;
}

function booleanInt(value: unknown): 0 | 1 | null {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === 0 || value === 1) return value;
  return null;
}

function jsonOrNull(value: unknown): string | null {
  return isRecord(value) || Array.isArray(value) ? JSON.stringify(value) ?? null : null;
}

/** Tracks arrive inside a SoundCloud like item; accepting a direct track
 * object too keeps the local import endpoint useful for already-extracted
 * metadata without accepting non-object payloads. */
function firstInteger(...values: unknown[]): number | null {
  for (const value of values) {
    const result = integer(value);
    if (result !== null && result > 0) return result;
  }
  return null;
}

function parseItem(value: unknown): ParsedSoundCloudItem | null {
  if (!isRecord(value)) return null;
  const redactedItem = redactRaw(value);
  if (!isRecord(redactedItem)) return null;
  const rawTrack = isRecord(redactedItem.track) ? redactedItem.track : redactedItem;
  const redactedTrack = rawTrack;
  if (!isRecord(redactedTrack)) return null;

  const soundcloudTrackId = firstInteger(redactedTrack.id, redactedTrack.soundcloud_track_id);
  const title = text(redactedTrack.title);
  if (soundcloudTrackId === null || title === null) return null;

  const uploader = isRecord(redactedTrack.user) ? redactedTrack.user : {};
  const itemLikedAt = text(redactedItem.liked_at) ?? text(redactedItem.created_at);
  return {
    snapshot: {
      soundcloud_track_id: soundcloudTrackId,
      urn: text(redactedTrack.urn),
      permalink_url: text(redactedTrack.permalink_url),
      title,
      uploader_id: firstInteger(uploader.id, redactedTrack.uploader_id, redactedTrack.user_id),
      uploader_username: text(uploader.username) ?? text(redactedTrack.uploader_username),
      uploader_permalink_url: text(uploader.permalink_url) ?? text(redactedTrack.uploader_permalink_url),
      duration_ms: integer(redactedTrack.duration) ?? integer(redactedTrack.duration_ms),
      full_duration_ms: integer(redactedTrack.full_duration) ?? integer(redactedTrack.full_duration_ms),
      genre: text(redactedTrack.genre),
      tag_list: text(redactedTrack.tag_list),
      description: text(redactedTrack.description),
      label_name: text(redactedTrack.label_name),
      release_date: text(redactedTrack.release_date),
      created_at: text(redactedTrack.created_at),
      display_date: text(redactedTrack.display_date),
      liked_at: itemLikedAt ?? text(redactedTrack.liked_at),
      likes_count: integer(redactedTrack.likes_count),
      reposts_count: integer(redactedTrack.reposts_count),
      playback_count: integer(redactedTrack.playback_count),
      comment_count: integer(redactedTrack.comment_count),
      download_count: integer(redactedTrack.download_count),
      downloadable: booleanInt(redactedTrack.downloadable),
      artwork_url: text(redactedTrack.artwork_url),
      waveform_url: text(redactedTrack.waveform_url),
      publisher_metadata_json: jsonOrNull(redactedTrack.publisher_metadata),
      raw_json: JSON.stringify(redactedItem) ?? "{}",
    },
  };
}

/** Locale-independent canonical comparison form. This removes only known
 * filename/download/BPM noise; remix and version tokens intentionally remain
 * part of the comparison to prevent wrong-identity matches. */
export function normalizeSoundCloudText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\p{M}+/gu, "")
    .replace(AUDIO_EXTENSION, " ")
    .replace(LEADING_TRACK_NUMBER, "")
    .replace(BRACKETED_BPM, " ")
    .replace(DOWNLOAD_NOISE, " ")
    .replace(FEATURE_SEPARATOR, " ")
    .replace(/[\p{P}\p{S}\p{Z}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function tokenJaccard(left: string, right: string): number {
  const leftTokens = new Set(left.split(" ").filter(Boolean));
  const rightTokens = new Set(right.split(" ").filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  return intersection / (leftTokens.size + rightTokens.size - intersection);
}

function parsedPublisherMetadata(row: Pick<SoundCloudTrackRow, "publisher_metadata_json">): Record<string, unknown> | null {
  if (!row.publisher_metadata_json) return null;
  try {
    const parsed = JSON.parse(row.publisher_metadata_json);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function publisherArtist(row: Pick<SoundCloudTrackRow, "publisher_metadata_json" | "uploader_username">): string | null {
  const publisher = parsedPublisherMetadata(row);
  const artist = publisher ? text(publisher.artist) : null;
  return artist?.trim() ? artist : row.uploader_username;
}

function providerDurationSeconds(row: Pick<SoundCloudTrackRow, "duration_ms" | "full_duration_ms">): number | null {
  const durationMs = row.full_duration_ms ?? row.duration_ms;
  return durationMs === null ? null : durationMs / 1000;
}

function durationDelta(local: Track, provider: SoundCloudTrackRow): number | null {
  const providerSeconds = providerDurationSeconds(provider);
  return local.duration === null || providerSeconds === null
    ? null
    : Math.abs(local.duration - providerSeconds);
}

function commentMatchesProvider(local: Track, provider: SoundCloudTrackRow): boolean {
  const comment = local.comment;
  if (!comment) return false;
  const idPattern = new RegExp(`(?<!\\d)${String(provider.soundcloud_track_id)}(?!\\d)`, "u");
  if (idPattern.test(comment)) return true;
  const permalink = provider.permalink_url?.replace(/\/+$/u, "");
  return !!permalink && comment.includes(permalink);
}

function matchMetrics(local: Track, provider: SoundCloudTrackRow): MatchMetrics {
  const localTitle = normalizeSoundCloudText(local.title ?? local.file_name);
  const localArtist = normalizeSoundCloudText(local.artist);
  const providerTitle = normalizeSoundCloudText(provider.title);
  const providerArtist = normalizeSoundCloudText(publisherArtist(provider));
  const titleExact = localTitle.length > 0 && localTitle === providerTitle;
  const artistExact = localArtist.length > 0 && localArtist === providerArtist;
  const titleScore = titleExact ? 1 : tokenJaccard(localTitle, providerTitle);
  const artistScore = artistExact ? 1 : tokenJaccard(localArtist, providerArtist);
  const delta = durationDelta(local, provider);
  const durationScore = delta === null ? 0 : Math.max(0, 1 - delta / 15);
  const score = 0.55 * titleScore + 0.30 * artistScore + 0.15 * durationScore;
  const directIdentity = commentMatchesProvider(local, provider);
  const strongMetadata = titleExact && artistExact && delta !== null && delta <= 3;
  const strongArtistTitle = artistExact && titleScore > 0.70 && delta !== null && delta <= 15;

  const reasons: string[] = [];
  if (directIdentity) reasons.push("exact SoundCloud ID or permalink in local comment");
  if (titleExact) reasons.push("exact normalized title");
  else if (titleScore > 0) reasons.push(`title token overlap ${Math.round(titleScore * 100)}%`);
  if (artistExact) reasons.push("exact normalized artist");
  else if (artistScore > 0) reasons.push(`artist token overlap ${Math.round(artistScore * 100)}%`);
  if (delta === null) reasons.push("missing local or provider duration");
  else reasons.push(`duration difference ${delta.toFixed(1)} seconds`);

  const publisher = parsedPublisherMetadata(provider);
  const publisherName = publisher ? text(publisher.artist) : null;
  if (publisherName && provider.uploader_username &&
    normalizeSoundCloudText(publisherName) !== normalizeSoundCloudText(provider.uploader_username)) {
    reasons.push("uploader differs from publisher artist");
  }
  if (!artistExact && titleExact && providerArtist) reasons.push("artist evidence does not exactly agree");
  if (strongArtistTitle && !strongMetadata) reasons.push("exact normalized artist with strong title overlap");

  const candidate = score >= 0.65 && titleScore >= 0.60 && artistScore >= 0.20 &&
    (delta === null || delta <= 15);
  return { score, reasons, automatic: directIdentity || strongMetadata || strongArtistTitle, candidate };
}

function upsertSnapshot(db: DatabaseSync, item: ParsedSoundCloudItem, runId: string, fetchedAt: string): boolean {
  const snapshot = item.snapshot;
  const existing = db
    .prepare("SELECT soundcloud_track_id FROM soundcloud_tracks WHERE soundcloud_track_id = ?")
    .get(snapshot.soundcloud_track_id);
  db.prepare(
    `
      INSERT INTO soundcloud_tracks (
        soundcloud_track_id, urn, permalink_url, title, uploader_id, uploader_username,
        uploader_permalink_url, duration_ms, full_duration_ms, genre, tag_list, description,
        label_name, release_date, created_at, display_date, liked_at, likes_count, reposts_count,
        playback_count, comment_count, download_count, downloadable, artwork_url, waveform_url,
        publisher_metadata_json, raw_json, available, last_seen_run_id, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(soundcloud_track_id) DO UPDATE SET
        urn = excluded.urn,
        permalink_url = excluded.permalink_url,
        title = excluded.title,
        uploader_id = excluded.uploader_id,
        uploader_username = excluded.uploader_username,
        uploader_permalink_url = excluded.uploader_permalink_url,
        duration_ms = excluded.duration_ms,
        full_duration_ms = excluded.full_duration_ms,
        genre = excluded.genre,
        tag_list = excluded.tag_list,
        description = excluded.description,
        label_name = excluded.label_name,
        release_date = excluded.release_date,
        created_at = excluded.created_at,
        display_date = excluded.display_date,
        liked_at = excluded.liked_at,
        likes_count = excluded.likes_count,
        reposts_count = excluded.reposts_count,
        playback_count = excluded.playback_count,
        comment_count = excluded.comment_count,
        download_count = excluded.download_count,
        downloadable = excluded.downloadable,
        artwork_url = excluded.artwork_url,
        waveform_url = excluded.waveform_url,
        publisher_metadata_json = excluded.publisher_metadata_json,
        raw_json = excluded.raw_json,
        available = 1,
        last_seen_run_id = excluded.last_seen_run_id,
        fetched_at = excluded.fetched_at
    `,
  ).run(
    snapshot.soundcloud_track_id,
    snapshot.urn,
    snapshot.permalink_url,
    snapshot.title,
    snapshot.uploader_id,
    snapshot.uploader_username,
    snapshot.uploader_permalink_url,
    snapshot.duration_ms,
    snapshot.full_duration_ms,
    snapshot.genre,
    snapshot.tag_list,
    snapshot.description,
    snapshot.label_name,
    snapshot.release_date,
    snapshot.created_at,
    snapshot.display_date,
    snapshot.liked_at,
    snapshot.likes_count,
    snapshot.reposts_count,
    snapshot.playback_count,
    snapshot.comment_count,
    snapshot.download_count,
    snapshot.downloadable,
    snapshot.artwork_url,
    snapshot.waveform_url,
    snapshot.publisher_metadata_json,
    snapshot.raw_json,
    runId,
    fetchedAt,
  );
  return existing !== undefined;
}

function upsertCandidate(
  db: DatabaseSync,
  trackId: number,
  soundcloudTrackId: number,
  metrics: MatchMetrics,
  evaluatedAt: string,
): void {
  db.prepare(
    `
      INSERT INTO soundcloud_match_candidates
        (track_id, soundcloud_track_id, score, reasons_json, status, evaluated_at, decided_at)
      VALUES (?, ?, ?, ?, 'pending', ?, NULL)
      ON CONFLICT(track_id, soundcloud_track_id) DO UPDATE SET
        score = excluded.score,
        reasons_json = excluded.reasons_json,
        evaluated_at = excluded.evaluated_at
      WHERE soundcloud_match_candidates.status = 'pending'
    `,
  ).run(trackId, soundcloudTrackId, metrics.score, JSON.stringify(metrics.reasons), evaluatedAt);
}

function scalar(db: DatabaseSync, statement: string, ...params: (string | number)[]): number {
  const row = db.prepare(statement).get(...params) as { count: number };
  return row.count;
}

function confirmedTrackIds(db: DatabaseSync): Set<number> {
  const rows = db.prepare("SELECT track_id FROM track_soundcloud_matches").all() as { track_id: number }[];
  return new Set(rows.map((row) => row.track_id));
}

function automaticCandidatesForTrack(
  db: DatabaseSync,
  local: Track,
): { candidate: SoundCloudMatchCandidateRow; provider: SoundCloudTrackRow; metrics: MatchMetrics }[] {
  const candidates = db
    .prepare(
      `SELECT * FROM soundcloud_match_candidates
       WHERE track_id = ? AND status != 'rejected'`,
    )
    .all(local.id) as unknown as SoundCloudMatchCandidateRow[];
  const automatic: { candidate: SoundCloudMatchCandidateRow; provider: SoundCloudTrackRow; metrics: MatchMetrics }[] = [];
  for (const candidate of candidates) {
    const provider = getSnapshot(db, candidate.soundcloud_track_id);
    if (!provider) continue;
    const metrics = matchMetrics(local, provider);
    if (metrics.automatic) automatic.push({ candidate, provider, metrics });
  }
  return automatic;
}

/** Stores one bounded import batch atomically. Valid rows are never split into
 * separate commits; malformed rows are counted and safely skipped. */
export function importSoundCloudBatch(
  db: DatabaseSync,
  runId: string,
  items: unknown[],
  complete: boolean,
): SoundCloudImportResult {
  const parsed = new Map<number, ParsedSoundCloudItem>();
  let malformed = 0;
  for (const item of items) {
    const result = parseItem(item);
    if (result === null) malformed += 1;
    else parsed.set(result.snapshot.soundcloud_track_id, result);
  }

  return withTx(db, () => {
    let inserted = 0;
    let updated = 0;
    const fetchedAt = nowIso();
    const affectedProviderIds = new Set<number>();
    for (const item of parsed.values()) {
      if (upsertSnapshot(db, item, runId, fetchedAt)) updated += 1;
      else inserted += 1;
      affectedProviderIds.add(item.snapshot.soundcloud_track_id);
    }

    const locals = db.prepare("SELECT * FROM tracks").all() as unknown as Track[];
    const confirmed = confirmedTrackIds(db);
    const potentialAutomaticLocals = new Map<number, Track>();
    const matchingProviderIds = complete
      ? new Set(
        (db.prepare("SELECT soundcloud_track_id FROM soundcloud_tracks WHERE last_seen_run_id = ?")
          .all(runId) as { soundcloud_track_id: number }[])
          .map((row) => row.soundcloud_track_id),
      )
      : affectedProviderIds;
    for (const soundcloudTrackId of matchingProviderIds) {
      const provider = getSnapshot(db, soundcloudTrackId);
      if (!provider) continue;
      for (const local of locals) {
        const metrics = matchMetrics(local, provider);
        if (!metrics.candidate && !metrics.automatic) {
          db.prepare(
            `DELETE FROM soundcloud_match_candidates
             WHERE track_id = ? AND soundcloud_track_id = ? AND status = 'pending'`,
          ).run(local.id, provider.soundcloud_track_id);
          continue;
        }
        if (confirmed.has(local.id)) continue;
        upsertCandidate(db, local.id, provider.soundcloud_track_id, metrics, fetchedAt);
        if (complete && metrics.automatic) potentialAutomaticLocals.set(local.id, local);
      }
    }

    let autoConfirmed = 0;
    for (const local of potentialAutomaticLocals.values()) {
      if (confirmed.has(local.id)) continue;
      const automatic = automaticCandidatesForTrack(db, local);
      if (automatic.length !== 1) continue;
      const selected = automatic[0];
      const now = nowIso();
      db.prepare(
        `
          INSERT INTO track_soundcloud_matches
            (track_id, soundcloud_track_id, confidence, method, reasons_json, matched_at, confirmed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(track_id) DO NOTHING
        `,
      ).run(
        local.id,
        selected.provider.soundcloud_track_id,
        selected.metrics.score,
        commentMatchesProvider(local, selected.provider) ? "comment_identity" : "exact_metadata",
        JSON.stringify(selected.metrics.reasons),
        now,
        now,
      );
      const linked = db
        .prepare("SELECT track_id FROM track_soundcloud_matches WHERE track_id = ?")
        .get(local.id);
      if (linked === undefined) continue;
      db.prepare(
        `UPDATE soundcloud_match_candidates
            SET status = 'accepted', decided_at = ?
          WHERE track_id = ? AND soundcloud_track_id = ?`,
      ).run(now, local.id, selected.provider.soundcloud_track_id);
      db.prepare(
        `UPDATE soundcloud_match_candidates
            SET status = 'rejected', decided_at = ?
          WHERE track_id = ? AND soundcloud_track_id != ? AND status = 'pending'`,
      ).run(now, local.id, selected.provider.soundcloud_track_id);
      confirmed.add(local.id);
      autoConfirmed += 1;
    }

    const persistedForRun = scalar(
      db,
      "SELECT COUNT(*) AS count FROM soundcloud_tracks WHERE last_seen_run_id = ?",
      runId,
    );
    const completed = complete && persistedForRun > 0;
    if (completed) {
      db.prepare(
        `UPDATE soundcloud_tracks
            SET available = 0
          WHERE available = 1 AND last_seen_run_id IS NOT ?`,
      ).run(runId);
    }

    return {
      received: items.length,
      inserted,
      updated,
      auto_confirmed: autoConfirmed,
      pending_candidates: scalar(
        db,
        "SELECT COUNT(*) AS count FROM soundcloud_match_candidates WHERE status = 'pending'",
      ),
      malformed,
      completed,
    };
  });
}

export function getSnapshot(db: DatabaseSync, soundcloudTrackId: number): SoundCloudTrackRow | undefined {
  return db
    .prepare("SELECT * FROM soundcloud_tracks WHERE soundcloud_track_id = ?")
    .get(soundcloudTrackId) as SoundCloudTrackRow | undefined;
}

function parseReasons(reasonsJson: string): string[] {
  try {
    const parsed = JSON.parse(reasonsJson);
    return Array.isArray(parsed) ? parsed.filter((reason): reason is string => typeof reason === "string") : [];
  } catch {
    return [];
  }
}

export function soundCloudTrackPayload(row: SoundCloudTrackRow): Record<string, unknown> {
  const {
    raw_json: _rawJson,
    publisher_metadata_json,
    downloadable,
    available,
    ...snapshot
  } = row;
  return {
    ...snapshot,
    downloadable: downloadable === null ? null : downloadable === 1,
    available: available === 1,
    publisher_metadata: parsedPublisherMetadata({ publisher_metadata_json }),
  };
}

function matchPayload(row: TrackSoundCloudMatchRow): Record<string, unknown> {
  return {
    track_id: row.track_id,
    soundcloud_track_id: row.soundcloud_track_id,
    confidence: row.confidence,
    method: row.method,
    matched_at: row.matched_at,
    confirmed_at: row.confirmed_at,
    reasons: parseReasons(row.reasons_json),
  };
}

export function trackSoundCloudDetail(db: DatabaseSync, trackId: number): {
  soundcloud: Record<string, unknown> | null;
  soundcloud_candidates: Record<string, unknown>[];
} {
  const match = db
    .prepare("SELECT * FROM track_soundcloud_matches WHERE track_id = ?")
    .get(trackId) as TrackSoundCloudMatchRow | undefined;
  const soundcloud = match ? getSnapshot(db, match.soundcloud_track_id) : undefined;
  const candidates = db
    .prepare(
      `SELECT * FROM soundcloud_match_candidates
       WHERE track_id = ? AND status = 'pending'
       ORDER BY score DESC, soundcloud_track_id ASC`,
    )
    .all(trackId) as unknown as SoundCloudMatchCandidateRow[];

  return {
    soundcloud: match && soundcloud ? { track: soundCloudTrackPayload(soundcloud), match: matchPayload(match) } : null,
    soundcloud_candidates: candidates.flatMap((candidate) => {
      const candidateTrack = getSnapshot(db, candidate.soundcloud_track_id);
      if (!candidateTrack) return [];
      return [{
        track_id: candidate.track_id,
        soundcloud_track_id: candidate.soundcloud_track_id,
        score: candidate.score,
        reasons: parseReasons(candidate.reasons_json),
        status: candidate.status,
        evaluated_at: candidate.evaluated_at,
        decided_at: candidate.decided_at,
        soundcloud_track: soundCloudTrackPayload(candidateTrack),
      }];
    }),
  };
}

export function soundCloudSummary(db: DatabaseSync): Record<string, number | string | null> {
  const last = db
    .prepare(
      `SELECT last_seen_run_id FROM soundcloud_tracks
       WHERE last_seen_run_id IS NOT NULL
       ORDER BY fetched_at DESC, soundcloud_track_id DESC LIMIT 1`,
    )
    .get() as { last_seen_run_id: string } | undefined;
  return {
    snapshots: scalar(db, "SELECT COUNT(*) AS count FROM soundcloud_tracks"),
    available: scalar(db, "SELECT COUNT(*) AS count FROM soundcloud_tracks WHERE available = 1"),
    unavailable: scalar(db, "SELECT COUNT(*) AS count FROM soundcloud_tracks WHERE available = 0"),
    confirmed_local_tracks: scalar(db, "SELECT COUNT(*) AS count FROM track_soundcloud_matches"),
    pending_candidates: scalar(
      db,
      "SELECT COUNT(*) AS count FROM soundcloud_match_candidates WHERE status = 'pending'",
    ),
    pending_local_tracks: scalar(
      db,
      "SELECT COUNT(DISTINCT track_id) AS count FROM soundcloud_match_candidates WHERE status = 'pending'",
    ),
    rejected_candidates: scalar(
      db,
      "SELECT COUNT(*) AS count FROM soundcloud_match_candidates WHERE status = 'rejected'",
    ),
    unmatched_soundcloud_tracks: scalar(
      db,
      `SELECT COUNT(*) AS count FROM soundcloud_tracks s
       WHERE s.available = 1 AND NOT EXISTS (
         SELECT 1 FROM track_soundcloud_matches m
         WHERE m.soundcloud_track_id = s.soundcloud_track_id
       )`,
    ),
    last_import_run_id: last?.last_seen_run_id ?? null,
  };
}

export function soundCloudReview(
  db: DatabaseSync,
  limit: number,
  offset: number,
): Record<string, unknown> {
  const candidates = db
    .prepare(
      `SELECT * FROM soundcloud_match_candidates
       WHERE status = 'pending'
       ORDER BY score DESC, track_id ASC
       LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as unknown as SoundCloudMatchCandidateRow[];
  const items = candidates.flatMap((candidate) => {
    const local = db.prepare("SELECT * FROM tracks WHERE id = ?").get(candidate.track_id) as Track | undefined;
    const provider = getSnapshot(db, candidate.soundcloud_track_id);
    if (!local || !provider) return [];
    return [{
      local_track: { ...local, missing: local.missing === 1 },
      candidate: {
        track_id: candidate.track_id,
        soundcloud_track_id: candidate.soundcloud_track_id,
        score: candidate.score,
        reasons: parseReasons(candidate.reasons_json),
        status: candidate.status,
        evaluated_at: candidate.evaluated_at,
        decided_at: candidate.decided_at,
        soundcloud_track: soundCloudTrackPayload(provider),
      },
    }];
  });
  return {
    total: scalar(
      db,
      "SELECT COUNT(*) AS count FROM soundcloud_match_candidates WHERE status = 'pending'",
    ),
    offset,
    limit,
    items,
  };
}

function requireReviewRows(
  db: DatabaseSync,
  trackId: number,
  soundcloudTrackId: number,
): SoundCloudMatchCandidateRow {
  const local = db.prepare("SELECT id FROM tracks WHERE id = ?").get(trackId);
  if (!local) throw new Error("track not found");
  const provider = getSnapshot(db, soundcloudTrackId);
  if (!provider) throw new Error("SoundCloud track not found");
  const candidate = db
    .prepare(
      `SELECT * FROM soundcloud_match_candidates
       WHERE track_id = ? AND soundcloud_track_id = ?`,
    )
    .get(trackId, soundcloudTrackId) as SoundCloudMatchCandidateRow | undefined;
  if (!candidate) throw new Error("SoundCloud candidate not found");
  return candidate;
}

export function acceptSoundCloudCandidate(
  db: DatabaseSync,
  trackId: number,
  soundcloudTrackId: number,
): { track_id: number; soundcloud_track_id: number; status: "accepted" } {
  return withTx(db, () => {
    const candidate = requireReviewRows(db, trackId, soundcloudTrackId);
    if (candidate.status === "rejected") throw new Error("SoundCloud candidate was rejected");
    const now = nowIso();
    db.prepare(
      `
        INSERT INTO track_soundcloud_matches
          (track_id, soundcloud_track_id, confidence, method, reasons_json, matched_at, confirmed_at)
        VALUES (?, ?, ?, 'manual_review', ?, ?, ?)
        ON CONFLICT(track_id) DO UPDATE SET
          soundcloud_track_id = excluded.soundcloud_track_id,
          confidence = excluded.confidence,
          method = excluded.method,
          reasons_json = excluded.reasons_json,
          matched_at = excluded.matched_at,
          confirmed_at = excluded.confirmed_at
      `,
    ).run(trackId, soundcloudTrackId, candidate.score, candidate.reasons_json, now, now);
    db.prepare(
      `UPDATE soundcloud_match_candidates
          SET status = 'accepted', decided_at = ?
        WHERE track_id = ? AND soundcloud_track_id = ?`,
    ).run(now, trackId, soundcloudTrackId);
    db.prepare(
      `UPDATE soundcloud_match_candidates
          SET status = 'rejected', decided_at = ?
          WHERE track_id = ? AND soundcloud_track_id != ?`,
    ).run(now, trackId, soundcloudTrackId);
    return { track_id: trackId, soundcloud_track_id: soundcloudTrackId, status: "accepted" };
  });
}

export function rejectSoundCloudCandidate(
  db: DatabaseSync,
  trackId: number,
  soundcloudTrackId: number,
): { track_id: number; soundcloud_track_id: number; status: "rejected" } {
  return withTx(db, () => {
    const candidate = requireReviewRows(db, trackId, soundcloudTrackId);
    if (candidate.status !== "pending") throw new Error("SoundCloud candidate is not pending");
    db.prepare(
      `UPDATE soundcloud_match_candidates
          SET status = 'rejected', decided_at = ?
        WHERE track_id = ? AND soundcloud_track_id = ?`,
    ).run(nowIso(), trackId, soundcloudTrackId);
    return { track_id: trackId, soundcloud_track_id: soundcloudTrackId, status: "rejected" };
  });
}
