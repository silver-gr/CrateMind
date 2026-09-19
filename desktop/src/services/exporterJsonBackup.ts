// JSON backup of canonical custom metadata (the data CrateMind owns) — the
// portable, human-readable backup independent of the SQLite file. Port of
// backend/app/services/backup.py:export_json.
//
// Always overwrites (no conflict check, no overwrite param) — matches the
// Python route (`export.py:export_json_backup`), which always calls
// `backup.export_json(session, dest, overwrite=True)` regardless of the
// request body's `overwrite` field.

import type { DatabaseSync } from "node:sqlite";
import { ensureParentDir } from "./exporterM3u.ts";
import { nowIso } from "../utils/time.ts";

// Boolean-ish INTEGER 0/1 columns per table (see schema.sql / models.py).
// Python's `model_dump(mode="json")` emits real `true`/`false` for these;
// the port must do the same instead of leaking raw SQLite integers.
const BOOL_COLUMNS: Record<string, readonly string[]> = {
  tracks: ["missing"],
  artist_profiles: ["needs_review"],
  track_dj_profile: [
    "can_cut_into",
    "can_cut_out_of",
    "dramatic_transition_candidate",
    "human_confirmed",
  ],
};

function dumpTable(db: DatabaseSync, table: string): Record<string, unknown>[] {
  const rows = db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
  const boolCols = BOOL_COLUMNS[table] ?? [];
  if (boolCols.length === 0) return rows;
  return rows.map((row) => {
    const out = { ...row };
    for (const col of boolCols) {
      if (out[col] === null || out[col] === undefined) continue;
      out[col] = out[col] === 1;
    }
    return out;
  });
}

/** Dumps every taste-metadata table to a JSON backup at `dest`, always
 * overwriting. Table coverage + key names mirror backup.py's payload
 * exactly (`profiles` = track_dj_profile, `pair_notes` = track_pair_notes). */
export function exportJsonBackup(db: DatabaseSync, dest: string): string {
  ensureParentDir(dest);

  const payload = {
    exported_at: nowIso(),
    version: 2,
    tracks: dumpTable(db, "tracks"),
    artist_profiles: dumpTable(db, "artist_profiles"),
    profiles: dumpTable(db, "track_dj_profile"),
    tags: dumpTable(db, "tags"),
    track_tags: dumpTable(db, "track_tags"),
    sets: dumpTable(db, "sets"),
    set_tracks: dumpTable(db, "set_tracks"),
    pair_notes: dumpTable(db, "track_pair_notes"),
    play_events: dumpTable(db, "play_events"),
  };

  // Python: dest.write_text(json.dumps(payload, indent=2, default=str)) —
  // no trailing newline added.
  Deno.writeTextFileSync(dest, JSON.stringify(payload, null, 2));
  return dest;
}
