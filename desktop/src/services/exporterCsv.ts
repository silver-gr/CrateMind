// CSV export of tracks + DJ profile, for audit/review/sharing. Port of
// backend/app/services/exporter_csv.py.

import type { DatabaseSync } from "node:sqlite";
import type { Track } from "../types/models.ts";
import { ensureParentDir, fileExists, FileExistsError } from "./exporterM3u.ts";
import { bpmSource, effectiveBpm } from "./tempo.ts";

// Exact column order from exporter_csv.py's _COLUMNS.
const COLUMNS = [
  "id", "artist", "title", "album", "label", "year", "genre", "bpm",
  "key_text", "duration", "energy", "intensity", "darkness", "melody",
  "weirdness", "mixability", "confidence", "set_role", "transition_role",
  "psy_substyle", "personal_status", "absolute_path",
  "effective_bpm", "bpm_source",
] as const;

type Column = (typeof COLUMNS)[number];

interface ProfileCols {
  energy: number | null;
  intensity: number | null;
  darkness: number | null;
  melody: number | null;
  weirdness: number | null;
  mixability: number | null;
  confidence: number | null;
  set_role: string | null;
  transition_role: string | null;
  psy_substyle: string | null;
  personal_status: string | null;
}

const PROFILE_SELECT =
  "SELECT energy, intensity, darkness, melody, weirdness, mixability, confidence, " +
  "set_role, transition_role, psy_substyle, personal_status FROM track_dj_profile WHERE track_id = ?";

/** Quotes a CSV field per Python csv's default (excel) dialect QUOTE_MINIMAL:
 * quote iff the field contains a comma, quote char, or CR/LF; escape quotes
 * by doubling them. `null`/`undefined` render as empty (matches Python's
 * csv module, which writes None as ""). */
function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Writes a CSV of `tracks` (joined with their track_dj_profile row, when
 * present) to `dest`. Header + field order match exporter_csv.py's
 * _COLUMNS; rows use \r\n line endings, matching Python csv's default
 * dialect (file opened with newline=""). */
export function exportCsv(
  db: DatabaseSync,
  tracks: Track[],
  dest: string,
  overwrite: boolean,
): string {
  if (fileExists(dest) && !overwrite) {
    throw new FileExistsError(dest);
  }
  ensureParentDir(dest);

  const profileStmt = db.prepare(PROFILE_SELECT);

  const rows: string[] = [COLUMNS.join(",")];
  for (const t of tracks) {
    const prof = profileStmt.get(t.id) as ProfileCols | undefined;
    const values: Record<Column, unknown> = {
      id: t.id,
      artist: t.artist,
      title: t.title,
      album: t.album,
      label: t.label,
      year: t.year,
      genre: t.genre,
      bpm: t.bpm,
      effective_bpm: effectiveBpm(t),
      bpm_source: bpmSource(t),
      key_text: t.key_text,
      duration: t.duration,
      energy: null,
      intensity: null,
      darkness: null,
      melody: null,
      weirdness: null,
      mixability: null,
      confidence: null,
      set_role: null,
      transition_role: null,
      psy_substyle: null,
      personal_status: null,
      absolute_path: t.absolute_path,
    };
    if (prof) {
      for (const key of [
        "energy",
        "intensity",
        "darkness",
        "melody",
        "weirdness",
        "mixability",
        "confidence",
        "set_role",
        "transition_role",
        "psy_substyle",
        "personal_status",
      ] as const) {
        if (prof[key] !== null) values[key] = prof[key];
      }
    }
    rows.push(COLUMNS.map((c) => csvField(values[c])).join(","));
  }

  Deno.writeTextFileSync(dest, rows.join("\r\n") + "\r\n");
  return dest;
}
