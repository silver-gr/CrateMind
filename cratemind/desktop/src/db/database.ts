// SQLite engine, schema init, FTS5 maintenance, and launch backup.
// Port of backend/app/db.py onto node:sqlite's DatabaseSync.

import { DatabaseSync } from "node:sqlite";
import { bindable } from "../utils/http.ts";
import { nowIso } from "../utils/time.ts";

const SCHEMA_PATH = new URL("./schema.sql", import.meta.url);

/** Opens (creating if absent) the SQLite DB file with WAL journaling,
 * foreign keys enforced, and a 5s busy timeout. */
export function openDb(dbFile: string): DatabaseSync {
  const db = new DatabaseSync(dbFile);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

/** Probes that FTS5 is actually available by creating, using, and dropping a
 * throwaway virtual table. Throws loudly if the sqlite build lacks FTS5. */
export function verifySqliteFeatures(db: DatabaseSync): void {
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS __fts5_probe USING fts5(x);");
    db.exec("INSERT INTO __fts5_probe (rowid, x) VALUES (1, 'probe');");
    db.prepare("SELECT x FROM __fts5_probe WHERE __fts5_probe MATCH 'probe'").all();
    db.exec("DROP TABLE __fts5_probe;");
  } catch (e) {
    throw new Error(
      `SQLite build is missing required FTS5 support: ${(e as Error).message}`,
    );
  }
}

/** Creates all tables/indexes/FTS table from schema.sql (idempotent — all
 * DDL uses IF NOT EXISTS) and records schema_migrations version 1. */
export function initDb(db: DatabaseSync): void {
  const schemaSql = Deno.readTextFileSync(SCHEMA_PATH);
  db.exec(schemaSql);
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
  ).run(1, nowIso());
}

function backupStamp(): string {
  const d = new Date();
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/** Snapshots dbFile into backupDir as cratemind-YYYY-MM-DD-HHMMSS.sqlite and
 * prunes to the last `keep`. No-op (returns null) if dbFile doesn't exist. */
export function backupOnLaunch(
  dbFile: string,
  backupDir: string,
  keep: number,
): string | null {
  try {
    const stat = Deno.statSync(dbFile);
    if (!stat.isFile) return null;
  } catch {
    return null;
  }

  const dest = `${backupDir}/cratemind-${backupStamp()}.sqlite`;
  Deno.copyFileSync(dbFile, dest);

  const backups: string[] = [];
  for (const entry of Deno.readDirSync(backupDir)) {
    if (entry.isFile && entry.name.startsWith("cratemind-") && entry.name.endsWith(".sqlite")) {
      backups.push(entry.name);
    }
  }
  backups.sort();
  const effectiveKeep = Math.max(1, keep);
  const toDelete = backups.slice(0, Math.max(0, backups.length - effectiveKeep));
  for (const name of toDelete) {
    try {
      Deno.removeSync(`${backupDir}/${name}`);
    } catch {
      // best-effort prune, mirrors Python's `except OSError: pass`
    }
  }

  return dest;
}

/** Rebuilds the FTS row for one track from tracks + profile.notes + tags.
 * Exact port of backend/app/db.py:reindex_track. */
export function reindexTrack(db: DatabaseSync, trackId: number): void {
  const row = db
    .prepare(
      `
      SELECT t.artist, t.title, t.album, t.label, t.genre, t.comment,
             p.notes AS notes,
             (SELECT group_concat(tg.name, ' ')
                FROM track_tags tt JOIN tags tg ON tg.id = tt.tag_id
               WHERE tt.track_id = t.id) AS tags
        FROM tracks t
        LEFT JOIN track_dj_profile p ON p.track_id = t.id
       WHERE t.id = ?
      `,
    )
    .get(trackId) as
    | {
        artist: string | null;
        title: string | null;
        album: string | null;
        label: string | null;
        genre: string | null;
        comment: string | null;
        notes: string | null;
        tags: string | null;
      }
    | undefined;

  db.prepare("DELETE FROM track_search WHERE rowid = ?").run(trackId);

  if (row === undefined) {
    return;
  }

  db.prepare(
    `
    INSERT INTO track_search
        (rowid, artist, title, album, label, genre, comment, notes, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    trackId,
    bindable(row.artist) ?? "",
    bindable(row.title) ?? "",
    bindable(row.album) ?? "",
    bindable(row.label) ?? "",
    bindable(row.genre) ?? "",
    bindable(row.comment) ?? "",
    bindable(row.notes) ?? "",
    bindable(row.tags) ?? "",
  );
}

/** Reindexes every track's FTS row; returns the number of tracks processed. */
export function reindexAll(db: DatabaseSync): number {
  const ids = db.prepare("SELECT id FROM tracks").all() as { id: number }[];
  for (const { id } of ids) {
    reindexTrack(db, id);
  }
  return ids.length;
}
