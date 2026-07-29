// JSON-backup import (desktop-only feature — Python has export only).
// Restores BPM/key analysis plus taste metadata (profiles, tags, artist
// profiles, sets, pair notes, play history) from a backup.py v2 payload (see
// backend/app/services/backup.py, desktop/src/services/exporterJsonBackup.ts)
// onto an already-scanned library. Never creates tracks or changes paths/file
// metadata; only missing BPM/key fields are filled. Filesystem stays untouched.

import type { DatabaseSync } from "node:sqlite";
import type { AppContext, RouteDef } from "./dispatch.ts";
import { bindable, HttpError, json, readJson } from "../utils/http.ts";
import { nowIso } from "../utils/time.ts";
import { reindexAll, withTx } from "../db/database.ts";

// ---- backup payload shapes (loosely typed — this is untrusted JSON) ----

interface BackupTrackRow {
  id: number;
  absolute_path: string;
  full_hash?: string | null;
  quick_hash?: string | null;
  bpm?: number | null;
  key_text?: string | null;
  bpm_analyzed?: number | null;
  bpm_analyzed_raw?: number | null;
  bpm_analyzed_confidence?: number | null;
  bpm_analyzed_method?: string | null;
  key_analyzed?: string | null;
  key_analyzed_confidence?: number | null;
  analyzed_at?: string | null;
  analysis_error?: string | null;
}

interface BackupProfileRow {
  track_id: number;
  updated_at?: string | null;
  [key: string]: unknown;
}

interface BackupArtistProfileRow {
  normalized_name: string;
  created_at?: string | null;
  updated_at?: string | null;
  [key: string]: unknown;
}

interface BackupTagRow {
  id: number;
  name: string;
  category?: string | null;
}

interface BackupTrackTagRow {
  track_id: number;
  tag_id: number;
  source?: string | null;
  confidence?: number | null;
}

interface BackupSetRow {
  id: number;
  title: string;
  date?: string | null;
  target_duration?: number | null;
  target_bpm_arc?: string | null;
  target_energy_arc?: string | null;
  notes?: string | null;
  created_at?: string | null;
}

interface BackupSetTrackRow {
  set_id: number;
  position: number;
  track_id: number;
  note?: string | null;
}

interface BackupPairNoteRow {
  from_track_id: number;
  to_track_id: number;
  rating?: number | null;
  transition_type?: string | null;
  notes?: string | null;
  created_at?: string | null;
}

interface BackupPlayEventRow {
  track_id: number;
  set_id?: number | null;
  played_at?: string | null;
  context?: string | null;
  crowd_reaction?: number | null;
  notes?: string | null;
}

interface BackupPayload {
  version: number;
  tracks: BackupTrackRow[];
  artist_profiles?: BackupArtistProfileRow[];
  profiles?: BackupProfileRow[];
  tags?: BackupTagRow[];
  track_tags?: BackupTrackTagRow[];
  sets?: BackupSetRow[];
  set_tracks?: BackupSetTrackRow[];
  pair_notes?: BackupPairNoteRow[];
  play_events?: BackupPlayEventRow[];
}

interface ImportCounts {
  matched_tracks: number;
  skipped_tracks: number;
  analysis_tracks: number;
  profiles: number;
  tags: number;
  track_tags: number;
  artist_profiles: number;
  sets: number;
  set_tracks: number;
  pair_notes: number;
  play_events: number;
}

function isBackupPayload(body: unknown): body is BackupPayload {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return typeof b.version === "number" && Array.isArray(b.tracks);
}

// track_dj_profile columns in schema order, excluding the PK (track_id).
const PROFILE_COLUMNS = [
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
  "updated_at",
] as const;

/** Full upsert of a track_dj_profile row onto `newTrackId`, replacing every
 * column with the backup's values. `updated_at` falls back to nowIso() when
 * the backup row omits it. */
function upsertProfile(db: DatabaseSync, newTrackId: number, row: BackupProfileRow): void {
  const columns = ["track_id", ...PROFILE_COLUMNS];
  const values = PROFILE_COLUMNS.map((c) => {
    if (c === "updated_at") return bindable(row.updated_at ?? nowIso());
    // NOT NULL columns fall back to their schema defaults when a
    // hand-built/older payload omits them; real exports always include them.
    if (c === "personal_status") return bindable(row.personal_status ?? "unknown");
    if (c === "human_confirmed") return bindable(row.human_confirmed ?? false);
    return bindable(row[c]);
  });
  const placeholders = columns.map(() => "?").join(", ");
  const updateAssignments = PROFILE_COLUMNS.map((c) => `${c} = excluded.${c}`).join(", ");
  db.prepare(
    `INSERT INTO track_dj_profile (${columns.join(", ")}) VALUES (${placeholders})
     ON CONFLICT (track_id) DO UPDATE SET ${updateAssignments}`,
  ).run(newTrackId, ...values);
}

// artist_profiles columns in schema order, excluding the PK (id) and the
// upsert key (normalized_name).
const ARTIST_PROFILE_COLUMNS = [
  "canonical_name",
  "aliases_json",
  "track_count",
  "scene_cluster",
  "primary_subgenre",
  "secondary_subgenres_json",
  "typical_bpm_min",
  "typical_bpm_max",
  "energy_min",
  "energy_max",
  "set_role_hints_json",
  "confidence_label",
  "needs_review",
  "notes",
  "raw_llm_json",
  "last_enriched_at",
  "created_at",
  "updated_at",
] as const;

/** Full upsert of an artist_profiles row keyed by normalized_name. */
function upsertArtistProfile(db: DatabaseSync, row: BackupArtistProfileRow): void {
  const columns = ["normalized_name", ...ARTIST_PROFILE_COLUMNS];
  const values = ARTIST_PROFILE_COLUMNS.map((c) => {
    if (c === "created_at") return bindable(row.created_at ?? nowIso());
    if (c === "updated_at") return bindable(row.updated_at ?? nowIso());
    return bindable(row[c]);
  });
  const placeholders = columns.map(() => "?").join(", ");
  const updateAssignments = ARTIST_PROFILE_COLUMNS.map((c) => `${c} = excluded.${c}`).join(", ");
  db.prepare(
    `INSERT INTO artist_profiles (${columns.join(", ")}) VALUES (${placeholders})
     ON CONFLICT (normalized_name) DO UPDATE SET ${updateAssignments}`,
  ).run(row.normalized_name, ...values);
}

/** Maps each backup track's old id to a current tracks.id: exact
 * absolute_path match first, then full_hash (only when exactly one current
 * row carries it), then quick_hash likewise. Unmatched backup tracks are
 * omitted from the returned map — the caller skips them entirely. */
function matchTracks(
  db: DatabaseSync,
  backupTracks: BackupTrackRow[],
): { trackIdMap: Map<number, number>; skippedTracks: number } {
  const current = db
    .prepare("SELECT id, absolute_path, quick_hash, full_hash FROM tracks")
    .all() as unknown as {
      id: number;
      absolute_path: string;
      quick_hash: string | null;
      full_hash: string | null;
    }[];

  const byPath = new Map<string, number>();
  const byFullHash = new Map<string, number[]>();
  const byQuickHash = new Map<string, number[]>();
  for (const t of current) {
    byPath.set(t.absolute_path, t.id);
    if (t.full_hash) {
      const arr = byFullHash.get(t.full_hash) ?? [];
      arr.push(t.id);
      byFullHash.set(t.full_hash, arr);
    }
    if (t.quick_hash) {
      const arr = byQuickHash.get(t.quick_hash) ?? [];
      arr.push(t.id);
      byQuickHash.set(t.quick_hash, arr);
    }
  }

  const trackIdMap = new Map<number, number>();
  let skippedTracks = 0;
  for (const bt of backupTracks) {
    let matched = byPath.get(bt.absolute_path);
    if (matched === undefined && bt.full_hash) {
      const candidates = byFullHash.get(bt.full_hash);
      if (candidates && candidates.length === 1) matched = candidates[0];
    }
    if (matched === undefined && bt.quick_hash) {
      const candidates = byQuickHash.get(bt.quick_hash);
      if (candidates && candidates.length === 1) matched = candidates[0];
    }
    if (matched === undefined) {
      skippedTracks += 1;
      continue;
    }
    trackIdMap.set(bt.id, matched);
  }

  return { trackIdMap, skippedTracks };
}

/** Fill missing BPM/key fields from one matched backup track.
 *
 * Existing desktop values win. This makes repeated imports idempotent and
 * avoids replacing analysis produced locally after the backup was exported.
 */
function restoreTrackAnalysis(
  db: DatabaseSync,
  newTrackId: number,
  row: BackupTrackRow,
): boolean {
  const hasBpmOrKey =
    row.bpm != null ||
    row.key_text != null ||
    row.bpm_analyzed != null ||
    row.key_analyzed != null;
  if (!hasBpmOrKey) return false;

  const result = db
    .prepare(
      `UPDATE tracks
          SET bpm = COALESCE(bpm, ?),
              key_text = COALESCE(key_text, ?),
              bpm_analyzed = COALESCE(bpm_analyzed, ?),
              bpm_analyzed_raw = COALESCE(bpm_analyzed_raw, ?),
              bpm_analyzed_confidence = COALESCE(bpm_analyzed_confidence, ?),
              bpm_analyzed_method = COALESCE(bpm_analyzed_method, ?),
              key_analyzed = COALESCE(key_analyzed, ?),
              key_analyzed_confidence = COALESCE(key_analyzed_confidence, ?),
              analyzed_at = COALESCE(analyzed_at, ?),
              analysis_error = CASE
                WHEN bpm_analyzed IS NOT NULL
                  OR key_analyzed IS NOT NULL
                  OR ? IS NOT NULL
                  OR ? IS NOT NULL
                THEN NULL
                ELSE COALESCE(analysis_error, ?)
              END
        WHERE id = ?`,
    )
    .run(
      bindable(row.bpm ?? null),
      bindable(row.key_text ?? null),
      bindable(row.bpm_analyzed ?? null),
      bindable(row.bpm_analyzed_raw ?? null),
      bindable(row.bpm_analyzed_confidence ?? null),
      bindable(row.bpm_analyzed_method ?? null),
      bindable(row.key_analyzed ?? null),
      bindable(row.key_analyzed_confidence ?? null),
      bindable(row.analyzed_at ?? null),
      bindable(row.bpm_analyzed ?? null),
      bindable(row.key_analyzed ?? null),
      bindable(row.analysis_error ?? null),
      newTrackId,
    );
  return result.changes > 0;
}

/** Restores analysis and every taste-metadata table from `payload` onto the current
 * library, returning row counts actually written. Must run inside a
 * transaction — the caller (importJsonBackup) owns that. */
function restore(db: DatabaseSync, payload: BackupPayload): ImportCounts {
  const { trackIdMap, skippedTracks } = matchTracks(db, payload.tracks);

  let analysisTracksCount = 0;
  for (const track of payload.tracks) {
    const newTrackId = trackIdMap.get(track.id);
    if (newTrackId === undefined) continue;
    if (restoreTrackAnalysis(db, newTrackId, track)) analysisTracksCount += 1;
  }

  let profilesCount = 0;
  for (const p of payload.profiles ?? []) {
    const newTrackId = trackIdMap.get(p.track_id);
    if (newTrackId === undefined) continue;
    upsertProfile(db, newTrackId, p);
    profilesCount += 1;
  }

  const tagIdMap = new Map<number, number>();
  let tagsCount = 0;
  for (const t of payload.tags ?? []) {
    const existing = db.prepare("SELECT id FROM tags WHERE name = ?").get(t.name) as
      | { id: number }
      | undefined;
    if (existing) {
      tagIdMap.set(t.id, existing.id);
      continue;
    }
    const result = db
      .prepare("INSERT INTO tags (name, category) VALUES (?, ?)")
      .run(t.name, bindable(t.category ?? null));
    tagIdMap.set(t.id, Number(result.lastInsertRowid));
    tagsCount += 1;
  }

  let trackTagsCount = 0;
  for (const tt of payload.track_tags ?? []) {
    const newTrackId = trackIdMap.get(tt.track_id);
    const newTagId = tagIdMap.get(tt.tag_id);
    if (newTrackId === undefined || newTagId === undefined) continue;
    const existing = db
      .prepare("SELECT 1 FROM track_tags WHERE track_id = ? AND tag_id = ?")
      .get(newTrackId, newTagId);
    if (existing) continue;
    db.prepare(
      "INSERT INTO track_tags (track_id, tag_id, source, confidence) VALUES (?, ?, ?, ?)",
    ).run(newTrackId, newTagId, tt.source ?? "human", bindable(tt.confidence ?? null));
    trackTagsCount += 1;
  }

  let artistProfilesCount = 0;
  for (const ap of payload.artist_profiles ?? []) {
    upsertArtistProfile(db, ap);
    artistProfilesCount += 1;
  }

  const setIdMap = new Map<number, number>();
  let setsCount = 0;
  let setTracksCount = 0;
  const allSetTracks = payload.set_tracks ?? [];
  for (const s of payload.sets ?? []) {
    const existing = db.prepare("SELECT id FROM sets WHERE title = ?").get(s.title);
    if (existing) continue; // duplicate title -> skip set AND its set_tracks

    const result = db
      .prepare(
        `INSERT INTO sets (title, date, target_duration, target_bpm_arc, target_energy_arc, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.title,
        bindable(s.date ?? null),
        bindable(s.target_duration ?? null),
        bindable(s.target_bpm_arc ?? null),
        bindable(s.target_energy_arc ?? null),
        bindable(s.notes ?? null),
        bindable(s.created_at ?? nowIso()),
      );
    const newSetId = Number(result.lastInsertRowid);
    setIdMap.set(s.id, newSetId);
    setsCount += 1;

    for (const st of allSetTracks) {
      if (st.set_id !== s.id) continue;
      const newTrackId = trackIdMap.get(st.track_id);
      if (newTrackId === undefined) continue;
      db.prepare(
        "INSERT INTO set_tracks (set_id, position, track_id, note) VALUES (?, ?, ?, ?)",
      ).run(newSetId, st.position, newTrackId, bindable(st.note ?? null));
      setTracksCount += 1;
    }
  }

  let pairNotesCount = 0;
  for (const n of payload.pair_notes ?? []) {
    const newFrom = trackIdMap.get(n.from_track_id);
    const newTo = trackIdMap.get(n.to_track_id);
    if (newFrom === undefined || newTo === undefined) continue;
    const transitionType = bindable(n.transition_type ?? null);
    const rating = bindable(n.rating ?? null);
    const notes = bindable(n.notes ?? null);
    const existing = db
      .prepare(
        `SELECT 1 FROM track_pair_notes
          WHERE from_track_id = ? AND to_track_id = ?
            AND transition_type IS ? AND rating IS ? AND notes IS ?`,
      )
      .get(newFrom, newTo, transitionType, rating, notes);
    if (existing) continue;
    db.prepare(
      `INSERT INTO track_pair_notes (from_track_id, to_track_id, rating, transition_type, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(newFrom, newTo, rating, transitionType, notes, bindable(n.created_at ?? nowIso()));
    pairNotesCount += 1;
  }

  let playEventsCount = 0;
  const affectedTrackIds = new Set<number>();
  for (const pe of payload.play_events ?? []) {
    const newTrackId = trackIdMap.get(pe.track_id);
    if (newTrackId === undefined) continue;
    affectedTrackIds.add(newTrackId);
    const newSetId = pe.set_id != null ? setIdMap.get(pe.set_id) ?? null : null;
    const playedAt = bindable(pe.played_at ?? null);
    const existing = db
      .prepare("SELECT 1 FROM play_events WHERE track_id = ? AND played_at IS ?")
      .get(newTrackId, playedAt);
    if (existing) continue;
    db.prepare(
      `INSERT INTO play_events (track_id, set_id, played_at, context, crowd_reaction, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      newTrackId,
      bindable(newSetId),
      playedAt,
      bindable(pe.context ?? null),
      bindable(pe.crowd_reaction ?? null),
      bindable(pe.notes ?? null),
    );
    playEventsCount += 1;
  }

  for (const trackId of affectedTrackIds) {
    const agg = db
      .prepare(
        "SELECT COUNT(*) AS cnt, MAX(played_at) AS last FROM play_events WHERE track_id = ?",
      )
      .get(trackId) as unknown as { cnt: number; last: string | null };
    db.prepare("UPDATE tracks SET play_count = ?, last_played_at = ? WHERE id = ?").run(
      agg.cnt,
      bindable(agg.last),
      trackId,
    );
  }

  return {
    matched_tracks: trackIdMap.size,
    skipped_tracks: skippedTracks,
    analysis_tracks: analysisTracksCount,
    profiles: profilesCount,
    tags: tagsCount,
    track_tags: trackTagsCount,
    artist_profiles: artistProfilesCount,
    sets: setsCount,
    set_tracks: setTracksCount,
    pair_notes: pairNotesCount,
    play_events: playEventsCount,
  };
}

async function importJsonBackup(
  req: Request,
  _params: Record<string, string | undefined>,
  ctx: AppContext,
): Promise<Response> {
  const body = await readJson<unknown>(req);
  if (!isBackupPayload(body)) {
    throw new HttpError(
      400,
      "invalid backup payload: expected an object with a numeric version and a tracks array",
    );
  }

  const counts = withTx(ctx.db, () => restore(ctx.db, body));
  reindexAll(ctx.db);

  return json(counts);
}

export function routes(): RouteDef[] {
  return [
    {
      method: "POST",
      pattern: new URLPattern({ pathname: "/api/import/json-backup" }),
      handler: importJsonBackup,
    },
  ];
}
