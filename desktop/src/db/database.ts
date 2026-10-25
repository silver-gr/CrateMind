// SQLite engine, schema init, FTS5 maintenance, and launch backup.
// Port of backend/app/db.py onto node:sqlite's DatabaseSync.

import { DatabaseSync } from "node:sqlite";
import { bindable } from "../utils/http.ts";
import { runMigrations } from "./migrations.ts";
import { canonicalKeyOf, effectiveKeyText } from "../services/camelot.ts";
import { effectiveBpm } from "../services/tempo.ts";

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
 * uniquely-named throwaway virtual table (avoids colliding with real tables
 * or concurrent probes). Throws loudly if the sqlite build lacks FTS5. */
export function verifySqliteFeatures(db: DatabaseSync): void {
  const probeTable = `__fts5_probe_${crypto.randomUUID().replace(/-/g, "")}`;
  try {
    db.exec(`CREATE VIRTUAL TABLE ${probeTable} USING fts5(x);`);
    db.exec(`INSERT INTO ${probeTable} (rowid, x) VALUES (1, 'probe');`);
    db.prepare(`SELECT x FROM ${probeTable} WHERE ${probeTable} MATCH 'probe'`).all();
  } catch (e) {
    throw new Error(
      `SQLite build is missing required FTS5 support: ${(e as Error).message}`,
    );
  } finally {
    db.exec(`DROP TABLE IF EXISTS ${probeTable};`);
  }
}

/** Runs all pending schema migrations (see migrations.ts) up to the latest
 * version, recording each in schema_migrations. Idempotent. */
export function initDb(db: DatabaseSync): void {
  db.function("cratemind_bpm", { deterministic: true }, (bpm, analyzed, consensus, sources) => {
    return effectiveBpm({
      bpm: typeof bpm === "number" ? bpm : null,
      bpm_consensus: typeof consensus === "number" ? consensus : null,
      bpm_consensus_sources: typeof sources === "string" ? sources : null,
      bpm_analyzed: typeof analyzed === "number" ? analyzed : null,
    });
  });
  db.function("cratemind_key", { deterministic: true }, (tag, analyzed) => {
    return canonicalKeyOf(effectiveKeyText(
      typeof tag === "string" ? tag : null,
      typeof analyzed === "string" ? analyzed : null,
    ));
  });
  db.function("cratemind_key_text", { deterministic: true }, (tag, analyzed) => {
    return effectiveKeyText(
      typeof tag === "string" ? tag : null,
      typeof analyzed === "string" ? analyzed : null,
    );
  });
  runMigrations(db);
}

/** Runs `fn` inside a BEGIN IMMEDIATE/COMMIT transaction, rolling back and
 * rethrowing if `fn` throws. */
export function withTx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

function backupStamp(): string {
  const d = new Date();
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/** Returns a filesystem path under `backupDir` for the given base filename
 * that does not already exist, appending -2, -3, ... on collision. */
function uniqueBackupPath(backupDir: string, base: string): string {
  let candidate = `${backupDir}/${base}.sqlite`;
  let n = 2;
  while (true) {
    try {
      Deno.statSync(candidate);
    } catch {
      return candidate;
    }
    candidate = `${backupDir}/${base}-${n}.sqlite`;
    n++;
  }
}

/** Snapshots dbFile into backupDir as cratemind-YYYY-MM-DD-HHMMSS.sqlite and
 * prunes to the last `keep`. No-op (returns null) if dbFile doesn't exist.
 *
 * Consistency: runs before the app opens its main connection; a
 * `wal_checkpoint(TRUNCATE)` first flushes every committed page from the WAL
 * into the main file, so a plain file copy is a complete snapshot. VACUUM INTO
 * is deliberately NOT used — it attaches its target internally, and the
 * compiled desktop runtime pins SQLite's attach limit to 0 ("too many
 * attached databases - max 0" at startup in the packaged .app). */
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

  const dest = uniqueBackupPath(backupDir, `cratemind-${backupStamp()}`);

  const source = new DatabaseSync(dbFile);
  try {
    source.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } finally {
    source.close();
  }
  Deno.copyFileSync(dbFile, dest);
  pruneBackups(backupDir, keep);
  return dest;
}

/** Deletes the oldest cratemind-*.sqlite snapshots in backupDir, keeping the
 * last `keep` (minimum 1). Best-effort: removal errors are ignored. */
function pruneBackups(backupDir: string, keep: number): void {
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
