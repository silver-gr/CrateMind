// Shared test scaffolding for Wave 1+ test suites. Every test gets its own
// temp-dir DB via makeTestCtx() — never touches real app data.

import { DatabaseSync } from "node:sqlite";
import { initDb, openDb, reindexTrack } from "../src/db/database.ts";
import { bindable } from "../src/utils/http.ts";
import { nowIso } from "../src/utils/time.ts";
import type { AppContext } from "../src/api/dispatch.ts";
import type { AppConfig } from "../src/services/config.ts";
import type { Track, TrackDJProfile } from "../src/types/models.ts";

export interface TestCtx {
  ctx: AppContext;
  dir: string;
  cleanup(): Promise<void>;
}

/** Builds an isolated AppContext backed by a fresh temp-dir DB. Does not
 * read any CRATEMIND_* env vars — config is constructed directly. */
export async function makeTestCtx(): Promise<TestCtx> {
  const dir = await Deno.makeTempDir({ prefix: "cratemind-test-" });
  const backupDir = `${dir}/backups`;
  const exportsDir = `${dir}/exports`;
  await Deno.mkdir(backupDir, { recursive: true });
  await Deno.mkdir(exportsDir, { recursive: true });

  const config: AppConfig = {
    dataDir: dir,
    dbFile: `${dir}/cratemind.sqlite`,
    backupDir,
    exportsDir,
    backupKeep: 10,
    libraryRoots: [],
    ffprobePath: null,
    fpcalcPath: null,
    ffmpegPath: null,
    host: "127.0.0.1",
    port: 8734,
  };

  const db = openDb(config.dbFile);
  initDb(db);

  const ctx: AppContext = { db, config };

  return {
    ctx,
    dir,
    async cleanup() {
      db.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

let seedCounter = 0;

/** Inserts a minimal valid tracks row (reindexed into FTS), returns its id. */
export function seedTrack(db: DatabaseSync, overrides: Partial<Track> = {}): number {
  seedCounter += 1;
  const now = nowIso();
  const row: Omit<Track, "id"> = {
    absolute_path: `/seed/track-${seedCounter}.mp3`,
    normalized_path: `/seed/track-${seedCounter}.mp3`,
    volume_root: null,
    file_name: `track-${seedCounter}.mp3`,
    extension: "mp3",
    file_size: null,
    modified_time: null,
    created_time: null,
    duration: null,
    bitrate: null,
    sample_rate: null,
    channels: null,
    codec: null,
    container: null,
    artist: "Seed Artist",
    artist_normalized: "seed artist",
    title: `Seed Track ${seedCounter}`,
    album: null,
    label: null,
    year: null,
    genre: null,
    comment: null,
    bpm: null,
    key_text: null,
    rating: null,
    bpm_analyzed: null,
    bpm_analyzed_raw: null,
    bpm_analyzed_confidence: null,
    bpm_analyzed_method: null,
    bpm_consensus: null,
    bpm_consensus_sources: null,
    key_analyzed: null,
    key_analyzed_confidence: null,
    analyzed_at: null,
    analysis_error: null,
    quick_hash: null,
    full_hash: null,
    play_count: 0,
    last_played_at: null,
    imported_at: now,
    last_scanned_at: now,
    missing: 0,
    ...overrides,
  };

  const columns = Object.keys(row) as (keyof typeof row)[];
  const placeholders = columns.map(() => "?").join(", ");
  const result = db
    .prepare(`INSERT INTO tracks (${columns.join(", ")}) VALUES (${placeholders})`)
    .run(...columns.map((c) => bindable(row[c])));
  const id = Number(result.lastInsertRowid);

  reindexTrack(db, id);
  return id;
}

/** Upserts a track_dj_profile row (reindexed into FTS for the `notes` field). */
export function seedProfile(
  db: DatabaseSync,
  trackId: number,
  overrides: Partial<TrackDJProfile> = {},
): void {
  const row: Omit<TrackDJProfile, "track_id"> = {
    energy: null,
    intensity: null,
    darkness: null,
    melody: null,
    weirdness: null,
    mixability: null,
    confidence: null,
    chaos_level: null,
    set_role: null,
    transition_role: null,
    groove_type: null,
    vocal_density: null,
    breakdown_profile: null,
    drop_profile: null,
    bassline_type: null,
    lead_character: null,
    psy_substyle: null,
    festival_time: null,
    ritual_factor: null,
    crowd_risk: null,
    personal_status: "unknown",
    tempo_bridge_score: null,
    bpm_jump_tolerance: null,
    can_cut_into: null,
    can_cut_out_of: null,
    dramatic_transition_candidate: null,
    notes: null,
    human_confirmed: 0,
    updated_at: nowIso(),
    ...overrides,
  };

  const columns = ["track_id", ...Object.keys(row)];
  const values: unknown[] = [trackId, ...Object.values(row)];
  const placeholders = columns.map(() => "?").join(", ");
  const updateAssignments = columns
    .filter((c) => c !== "track_id")
    .map((c) => `${c} = excluded.${c}`)
    .join(", ");

  db.prepare(
    `INSERT INTO track_dj_profile (${columns.join(", ")}) VALUES (${placeholders})
     ON CONFLICT (track_id) DO UPDATE SET ${updateAssignments}`,
  ).run(...values.map((v) => bindable(v)));

  reindexTrack(db, trackId);
}
