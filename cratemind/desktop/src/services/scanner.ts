// Library scanner — idempotent folder traversal into the tracks table.
// Exact-semantics port of backend/app/services/scanner.py.
//
// Guarantees (data-safety invariant — see project CLAUDE.md):
// - Strictly READ-ONLY on source audio: only Deno.stat/readDir/realPath/open
//   (read mode) and ffprobe/fpcalc subprocesses are used against library
//   files. Nothing here ever writes, moves, renames, or deletes a scanned file.
// - Running a scan N times does not duplicate rows or overwrite human work.
// - Embedded-file columns (artist/title/duration/...) mirror the file and are
//   refreshed only when size+mtime change (see _METADATA_COLUMNS/_FILE_COLUMNS
//   split below).
// - Human work (track_dj_profile, track_tags) lives in other tables and is
//   never touched here.
// - Files previously seen under a scanned root but now gone are marked
//   missing, never deleted.
//
// Deliberate divergence from scanner.py: Python has two record-building
// paths — a cheap Mutagen-only path for "unchanged" files and a full path
// (+ ffprobe subprocess) for new/changed files — to avoid unnecessary
// subprocess spawns. The Deno port has no Mutagen equivalent (guide §11):
// ffprobe is the ONLY tag source, so every pass spawns one ffprobe probe per
// file regardless of change state. The column-application split
// (_METADATA_COLUMNS vs _FILE_COLUMNS) is preserved exactly, so observable
// data mutation semantics are unchanged even though I/O cost characteristics
// differ.

import type { DatabaseSync } from "node:sqlite";
import { bindable } from "../utils/http.ts";
import { nowIso } from "../utils/time.ts";
import { reindexTrack } from "../db/database.ts";
import type { AppConfig } from "./config.ts";
import type { JobRow, Track } from "../types/models.ts";
import { probe, readStreamInfo } from "./ffprobe.ts";
import { extractTags, looksLikeLabelName } from "./metadata.ts";
import { normalizeArtist } from "./artistNormalizer.ts";
import { quickHash } from "./hashing.ts";
import { updateJob } from "./jobs.ts";

export const AUDIO_EXTS = new Set([
  ".mp3",
  ".flac",
  ".wav",
  ".aif",
  ".aiff",
  ".m4a",
  ".mp4",
  ".ogg",
  ".opus",
]);

function basename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] ?? p;
}

function extname(p: string): string {
  const base = basename(p);
  const idx = base.lastIndexOf(".");
  return idx > 0 ? base.slice(idx) : "";
}

/** Recursively walks `dir`, yielding absolute file paths. Guards against
 * symlink-directory cycles via a realpath-keyed visited set (a practical
 * safety net beyond scanner.py's file-level realpath dedup, since Deno's
 * manual recursion has no built-in symlink-cycle protection to rely on). */
async function* walkDir(dir: string, visitedDirs: Set<string>): AsyncGenerator<string> {
  let real: string;
  try {
    real = await Deno.realPath(dir);
  } catch {
    return;
  }
  if (visitedDirs.has(real)) return;
  visitedDirs.add(real);

  let entries: Deno.DirEntry[];
  try {
    entries = [];
    for await (const entry of Deno.readDir(dir)) entries.push(entry);
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      yield* walkDir(full, visitedDirs);
    } else {
      // Follow symlinked files too (matches Path.is_file() following
      // symlinks); Deno.stat (not lstat) resolves symlink targets.
      let stat: Deno.FileInfo;
      try {
        stat = await Deno.stat(full);
      } catch {
        continue;
      }
      if (stat.isFile) yield full;
    }
  }
}

/** Yields {root, path} for every audio file under `roots`, deduped by real
 * path (mirrors scanner.py:_iter_audio's seen-realpath dedup). */
export async function* iterAudio(
  roots: string[],
): AsyncGenerator<{ root: string; path: string }> {
  const seenFiles = new Set<string>();
  for (const root of roots) {
    try {
      const st = await Deno.stat(root);
      if (!st.isDirectory) continue;
    } catch {
      continue;
    }
    const visitedDirs = new Set<string>();
    for await (const filePath of walkDir(root, visitedDirs)) {
      let real: string;
      try {
        real = await Deno.realPath(filePath);
      } catch {
        real = filePath;
      }
      if (seenFiles.has(real)) continue;
      seenFiles.add(real);
      if (AUDIO_EXTS.has(extname(filePath).toLowerCase())) {
        yield { root, path: filePath };
      }
    }
  }
}

function volumeRoot(filePath: string): string | null {
  const segments = filePath.split("/");
  if (segments.length >= 3 && segments[0] === "" && segments[1] === "Volumes") {
    return `/${segments[1]}/${segments[2]}`;
  }
  return filePath.startsWith("/") ? "/" : null;
}

/** File creation time, seconds since epoch. macOS/BSD expose true birthtime;
 * elsewhere fall back to ctime, then mtime — closest available. */
function birthtime(st: Deno.FileInfo): number {
  if (st.birthtime) return st.birthtime.getTime() / 1000;
  if (st.ctime) return st.ctime.getTime() / 1000;
  if (st.mtime) return st.mtime.getTime() / 1000;
  return Date.now() / 1000;
}

function folderFallback(filePath: string, root: string, record: FileRecord): void {
  const normRoot = root.endsWith("/") ? root.slice(0, -1) : root;
  let relParts: string[];
  if (filePath.startsWith(`${normRoot}/`)) {
    relParts = filePath.slice(normRoot.length + 1).split("/");
  } else {
    relParts = filePath.split("/").filter((p) => p !== "");
  }

  if (relParts.length === 3 && !record.album) {
    record.album = relParts[1];
  }
  if (!record.artist) {
    if (relParts.length === 3 || relParts.length === 2) {
      if (!looksLikeLabelName(relParts[0])) {
        record.artist = relParts[0];
      }
    }
  }
}

interface FileRecord {
  file_name: string;
  extension: string;
  file_size: number;
  modified_time: number;
  created_time: number;
  normalized_path: string;
  volume_root: string | null;
  quick_hash: string | null;
  artist_normalized: string | null;
  artist?: string;
  title?: string;
  album?: string;
  label?: string;
  genre?: string;
  comment?: string;
  year?: number;
  bpm?: number;
  key_text?: string;
  rating?: number;
  duration?: number;
  bitrate?: number;
  sample_rate?: number;
  channels?: number;
  codec?: string;
  container?: string;
  [key: string]: unknown;
}

/** Builds the full file record: hash + ffprobe-sourced tags/stream info +
 * folder fallback + artist_normalized. See the module-level divergence note
 * above — this always spawns ffprobe, unlike scanner.py's split paths. */
async function readFileRecord(
  filePath: string,
  root: string,
  ffprobePath: string | null,
): Promise<FileRecord> {
  const st = await Deno.stat(filePath);
  const record: FileRecord = {
    file_name: basename(filePath),
    extension: extname(filePath).toLowerCase().replace(/^\./, ""),
    file_size: st.size,
    modified_time: st.mtime ? st.mtime.getTime() / 1000 : 0,
    created_time: birthtime(st),
    normalized_path: filePath.toLowerCase(),
    volume_root: volumeRoot(filePath),
    quick_hash: await quickHash(filePath),
    artist_normalized: null,
  };

  const probeData = await probe(ffprobePath, filePath);
  Object.assign(record, extractTags(probeData, filePath));
  Object.assign(record, readStreamInfo(probeData));

  folderFallback(filePath, root, record);
  record.artist_normalized = normalizeArtist(record.artist ?? null);

  return record;
}

// embedded/file-derived columns the scanner is allowed to refresh
const FILE_COLUMNS = new Set([
  "file_name",
  "extension",
  "file_size",
  "modified_time",
  "created_time",
  "normalized_path",
  "volume_root",
  "quick_hash",
  "artist",
  "artist_normalized",
  "title",
  "album",
  "label",
  "year",
  "genre",
  "comment",
  "bpm",
  "key_text",
  "rating",
  "duration",
  "bitrate",
  "sample_rate",
  "channels",
  "codec",
  "container",
]);
const STREAM_ONLY_COLUMNS = new Set([
  "duration",
  "bitrate",
  "sample_rate",
  "channels",
  "codec",
  "container",
]);
const METADATA_COLUMNS = new Set(
  [...FILE_COLUMNS].filter((c) => !STREAM_ONLY_COLUMNS.has(c)),
);

function computeColumnPatch(
  existing: Track,
  record: FileRecord,
  columns: Set<string>,
): Record<string, unknown> {
  const existingRec = existing as unknown as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const k of columns) {
    if (!(k in record)) continue;
    const incoming = record[k];
    if (existingRec[k] !== incoming) {
      patch[k] = incoming;
    }
  }
  return patch;
}

function applyPatch(db: DatabaseSync, trackId: number, patch: Record<string, unknown>): void {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  const setClause = keys.map((k) => `${k} = ?`).join(", ");
  db.prepare(`UPDATE tracks SET ${setClause} WHERE id = ?`).run(
    ...keys.map((k) => bindable(patch[k])),
    trackId,
  );
}

function insertTrack(
  db: DatabaseSync,
  absolutePath: string,
  record: FileRecord,
  now: string,
): number {
  const row: Record<string, unknown> = {
    absolute_path: absolutePath,
    normalized_path: record.normalized_path,
    volume_root: record.volume_root ?? null,
    file_name: record.file_name,
    extension: record.extension,
    file_size: record.file_size,
    modified_time: record.modified_time,
    created_time: record.created_time,
    duration: record.duration ?? null,
    bitrate: record.bitrate ?? null,
    sample_rate: record.sample_rate ?? null,
    channels: record.channels ?? null,
    codec: record.codec ?? null,
    container: record.container ?? null,
    artist: record.artist ?? null,
    artist_normalized: record.artist_normalized ?? null,
    title: record.title ?? null,
    album: record.album ?? null,
    label: record.label ?? null,
    year: record.year ?? null,
    genre: record.genre ?? null,
    comment: record.comment ?? null,
    bpm: record.bpm ?? null,
    key_text: record.key_text ?? null,
    rating: record.rating ?? null,
    bpm_analyzed: null,
    bpm_analyzed_raw: null,
    bpm_analyzed_confidence: null,
    bpm_analyzed_method: null,
    key_analyzed: null,
    key_analyzed_confidence: null,
    analyzed_at: null,
    analysis_error: null,
    quick_hash: record.quick_hash,
    full_hash: null,
    play_count: 0,
    last_played_at: null,
    imported_at: now,
    last_scanned_at: now,
    missing: 0,
  };
  const columns = Object.keys(row);
  const placeholders = columns.map(() => "?").join(", ");
  const result = db
    .prepare(`INSERT INTO tracks (${columns.join(", ")}) VALUES (${placeholders})`)
    .run(...columns.map((c) => bindable(row[c])));
  const id = Number(result.lastInsertRowid);
  reindexTrack(db, id);
  return id;
}

export interface ScanStats {
  scanned: number;
  added: number;
  updated: number;
  unchanged: number;
  missing: number;
}

/** Scans `roots` for audio files and upserts them into `tracks`, strictly
 * read-only on source files. Identity is by absolute_path only (no
 * moved-file reconciliation, matching scanner.py). `job`, if given, has its
 * `processed` count updated after every file. */
export async function scanRoots(
  db: DatabaseSync,
  config: AppConfig,
  roots: string[],
  job: JobRow | null,
): Promise<ScanStats> {
  const stats: ScanStats = { scanned: 0, added: 0, updated: 0, unchanged: 0, missing: 0 };
  const seenPaths = new Set<string>();
  const now = nowIso();

  for await (const { root, path } of iterAudio(roots)) {
    seenPaths.add(path);
    stats.scanned += 1;

    const existing = db
      .prepare("SELECT * FROM tracks WHERE absolute_path = ?")
      .get(path) as Track | undefined;

    let st: Deno.FileInfo;
    try {
      st = await Deno.stat(path);
    } catch {
      continue;
    }

    if (existing === undefined) {
      const record = await readFileRecord(path, root, config.ffprobePath);
      insertTrack(db, path, record, now);
      stats.added += 1;
    } else {
      const mtime = st.mtime ? st.mtime.getTime() / 1000 : 0;
      const unchanged =
        existing.file_size === st.size &&
        existing.modified_time === mtime &&
        existing.missing === 0;

      const baseUpdates: Record<string, unknown> = {
        last_scanned_at: now,
        missing: 0,
      };
      if (existing.created_time === null) {
        baseUpdates.created_time = birthtime(st);
      }

      const record = await readFileRecord(path, root, config.ffprobePath);
      const columns = unchanged ? METADATA_COLUMNS : FILE_COLUMNS;
      const patch = { ...baseUpdates, ...computeColumnPatch(existing, record, columns) };
      applyPatch(db, existing.id, patch);

      const contentChanged = Object.keys(patch).some(
        (k) => k !== "last_scanned_at" && k !== "missing",
      );
      if (!unchanged || contentChanged) {
        reindexTrack(db, existing.id);
        stats.updated += 1;
      } else {
        stats.unchanged += 1;
      }
    }

    if (job !== null) {
      updateJob(db, job.id, { processed: stats.scanned });
    }

    // Yield to the event loop between files so a long scan doesn't starve
    // HTTP request handling on the same Deno.serve() process.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  // mark missing: rows under the scanned roots not seen this pass
  if (roots.length > 0 && seenPaths.size > 0) {
    const candidates = db
      .prepare("SELECT id, absolute_path FROM tracks WHERE missing = 0")
      .all() as { id: number; absolute_path: string }[];
    for (const tr of candidates) {
      if (seenPaths.has(tr.absolute_path)) continue;
      if (roots.some((r) => tr.absolute_path.startsWith(r))) {
        db.prepare("UPDATE tracks SET missing = 1 WHERE id = ?").run(tr.id);
        stats.missing += 1;
      }
    }
  }

  return stats;
}
