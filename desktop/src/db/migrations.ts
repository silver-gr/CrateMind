// Ordered schema migrations. version 1 loads the full schema.sql (idempotent
// DDL). Future migrations are appended here with version = previous + 1.

import type { DatabaseSync } from "node:sqlite";
import { withTx } from "./database.ts";
import { nowIso } from "../utils/time.ts";
// Text import: embeds schema.sql into compiled desktop builds — a runtime
// Deno.readTextFileSync would fail inside the bundled .app where the file
// doesn't exist on disk.
import schemaSql from "./schema.sql" with { type: "text" };

export interface Migration {
  version: number;
  apply: (db: DatabaseSync) => void;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    apply: (db) => {
      db.exec(schemaSql);
    },
  },
  {
    version: 2,
    apply: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS soundcloud_tracks (
          soundcloud_track_id INTEGER PRIMARY KEY,
          urn TEXT,
          permalink_url TEXT,
          title TEXT,
          uploader_id INTEGER,
          uploader_username TEXT,
          uploader_permalink_url TEXT,
          duration_ms INTEGER,
          full_duration_ms INTEGER,
          genre TEXT,
          tag_list TEXT,
          description TEXT,
          label_name TEXT,
          release_date TEXT,
          created_at TEXT,
          display_date TEXT,
          liked_at TEXT,
          likes_count INTEGER,
          reposts_count INTEGER,
          playback_count INTEGER,
          comment_count INTEGER,
          download_count INTEGER,
          downloadable BOOLEAN,
          artwork_url TEXT,
          waveform_url TEXT,
          publisher_metadata_json TEXT,
          raw_json TEXT NOT NULL,
          available BOOLEAN NOT NULL DEFAULT 1,
          last_seen_run_id TEXT,
          fetched_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS ix_soundcloud_tracks_title
          ON soundcloud_tracks (title);
        CREATE INDEX IF NOT EXISTS ix_soundcloud_tracks_permalink_url
          ON soundcloud_tracks (permalink_url);
        CREATE INDEX IF NOT EXISTS ix_soundcloud_tracks_uploader_id
          ON soundcloud_tracks (uploader_id);
        CREATE INDEX IF NOT EXISTS ix_soundcloud_tracks_available
          ON soundcloud_tracks (available);

        CREATE TABLE IF NOT EXISTS track_soundcloud_matches (
          track_id INTEGER PRIMARY KEY REFERENCES tracks (id),
          soundcloud_track_id INTEGER NOT NULL REFERENCES soundcloud_tracks (soundcloud_track_id),
          confidence REAL NOT NULL,
          method TEXT NOT NULL,
          reasons_json TEXT NOT NULL,
          matched_at TEXT NOT NULL,
          confirmed_at TEXT
        );

        CREATE INDEX IF NOT EXISTS ix_track_soundcloud_matches_soundcloud_track_id
          ON track_soundcloud_matches (soundcloud_track_id);

        CREATE TABLE IF NOT EXISTS soundcloud_match_candidates (
          track_id INTEGER NOT NULL REFERENCES tracks (id),
          soundcloud_track_id INTEGER NOT NULL REFERENCES soundcloud_tracks (soundcloud_track_id),
          score REAL NOT NULL,
          reasons_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
          evaluated_at TEXT NOT NULL,
          decided_at TEXT,
          PRIMARY KEY (track_id, soundcloud_track_id)
        );

        CREATE INDEX IF NOT EXISTS ix_soundcloud_match_candidates_status
          ON soundcloud_match_candidates (status);
      `);
    },
  },
  {
    version: 3,
    apply: (db) => {
      // Python catalogs may already have these fields. Keep migration safe
      // for both shared catalogs and older desktop-only databases.
      const columns = new Set((db.prepare("PRAGMA table_info(tracks)").all() as { name: string }[]).map((row) => row.name));
      if (!columns.has("bpm_consensus")) db.exec("ALTER TABLE tracks ADD COLUMN bpm_consensus REAL");
      if (!columns.has("bpm_consensus_sources")) db.exec("ALTER TABLE tracks ADD COLUMN bpm_consensus_sources TEXT");
    },
  },
];

function currentVersion(db: DatabaseSync): number {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const row = db
    .prepare("SELECT MAX(version) AS v FROM schema_migrations")
    .get() as { v: number | null };
  return row.v ?? 0;
}

/** Applies every migration with version > current DB version, in ascending
 * order, each inside its own transaction. Idempotent — re-running with no
 * pending migrations is a no-op. */
export function runMigrations(db: DatabaseSync, migrations: Migration[] = MIGRATIONS): void {
  const current = currentVersion(db);
  const pending = migrations
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    withTx(db, () => {
      migration.apply(db);
      db.prepare(
        "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      ).run(migration.version, nowIso());
    });
  }
}
