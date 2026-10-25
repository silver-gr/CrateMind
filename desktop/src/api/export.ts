// Export API — writes playlist/CSV/markdown/JSON-backup artifacts into the
// configured exports folder. Never touches the source library. Port of
// backend/app/api/export.py.
//
// Filename sanitization is a DELIBERATE TIGHTENING vs Python (see plan's
// "Deliberate Divergences"): Python does `out_dir / filename` unguarded,
// which can escape out_dir via an absolute path or `..` segments. This port
// rejects any filename containing "/", "\\", or ".." (which also catches
// absolute paths, since those always contain a "/" or drive-letter-style
// separator) for ALL four formats, including json-backup.

import type { AppContext, RouteDef } from "./dispatch.ts";
import { err, HttpError, json, readJson } from "../utils/http.ts";
import { exportM3u, FileExistsError } from "../services/exporterM3u.ts";
import { exportCsv } from "../services/exporterCsv.ts";
import { exportMarkdown } from "../services/exporterMarkdown.ts";
import { exportJsonBackup } from "../services/exporterJsonBackup.ts";
import type { DatabaseSync } from "node:sqlite";
import type { DJSetRow, ExportRequest, Track } from "../types/models.ts";

/** Resolves the export destination inside `exportsDir`: rejects any
 * filename containing a path separator or "..", falls back to `defaultName`
 * when no filename was given, and asserts the canonical result still lives
 * inside `exportsDir` (defense in depth — sanitization above already
 * guarantees this since a clean filename has no path segments). */
function resolveDest(
  filename: string | null | undefined,
  defaultName: string,
  exportsDir: string,
): string {
  const name = filename && filename.trim().length > 0 ? filename : defaultName;
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new HttpError(400, `invalid filename: ${name}`);
  }
  const dest = `${exportsDir}/${name}`;
  if (!dest.startsWith(`${exportsDir}/`)) {
    throw new HttpError(400, `invalid filename: ${name}`);
  }
  return dest;
}

/** Mirrors export.py's `_resolve_tracks`: set_id -> ordered set tracks
 * (INNER JOIN naturally skips vanished/deleted tracks), else track_ids in
 * the given order (missing ids skipped).
 * Shared clients send all_tracks:true to explicitly export the available
 * library. Legacy desktop clients may still omit selection to export all;
 * Python requires the explicit flag. */
function resolveTracks(db: DatabaseSync, req: ExportRequest): Track[] {
  if (req.set_id !== undefined && req.set_id !== null) {
    return db
      .prepare(
        `SELECT t.* FROM set_tracks st JOIN tracks t ON t.id = st.track_id
         WHERE st.set_id = ? ORDER BY st.position`,
      )
      .all(req.set_id) as unknown as Track[];
  }
  if (req.track_ids && req.track_ids.length > 0) {
    const stmt = db.prepare("SELECT * FROM tracks WHERE id = ?");
    const out: Track[] = [];
    for (const id of req.track_ids) {
      const row = stmt.get(id) as unknown as Track | undefined;
      if (row) out.push(row);
    }
    return out;
  }
  return db
    .prepare(
      "SELECT * FROM tracks WHERE missing = 0 ORDER BY artist, title",
    )
    .all() as unknown as Track[];
}

async function handleM3u(req: Request, _params: Record<string, string | undefined>, ctx: AppContext): Promise<Response> {
  const body = await readJson<ExportRequest>(req);
  const tracks = resolveTracks(ctx.db, body);
  if (tracks.length === 0) {
    return err(400, "no tracks to export");
  }
  const dest = resolveDest(body.filename, "cratemind.m3u8", ctx.config.exportsDir);
  try {
    const path = exportM3u(tracks, dest, body.overwrite ?? false);
    return json({ path, count: tracks.length });
  } catch (e) {
    if (e instanceof FileExistsError) return err(409, e.message);
    throw e;
  }
}

async function handleCsv(req: Request, _params: Record<string, string | undefined>, ctx: AppContext): Promise<Response> {
  const body = await readJson<ExportRequest>(req);
  const tracks = resolveTracks(ctx.db, body);
  if (tracks.length === 0) {
    return err(400, "no tracks to export");
  }
  const dest = resolveDest(body.filename, "cratemind.csv", ctx.config.exportsDir);
  try {
    const path = exportCsv(ctx.db, tracks, dest, body.overwrite ?? false);
    return json({ path, count: tracks.length });
  } catch (e) {
    if (e instanceof FileExistsError) return err(409, e.message);
    throw e;
  }
}

async function handleMarkdown(req: Request, _params: Record<string, string | undefined>, ctx: AppContext): Promise<Response> {
  const body = await readJson<ExportRequest>(req);
  if (body.set_id === undefined || body.set_id === null) {
    return err(400, "markdown export requires set_id");
  }
  const djSet = ctx.db.prepare("SELECT * FROM sets WHERE id = ?").get(body.set_id) as
    | unknown as DJSetRow
    | undefined;
  if (!djSet) {
    return err(404, "set not found");
  }
  const tracks = resolveTracks(ctx.db, body);
  const dest = resolveDest(body.filename, `set-${body.set_id}.md`, ctx.config.exportsDir);
  try {
    const path = exportMarkdown(djSet, tracks, dest, body.overwrite ?? false);
    return json({ path, count: tracks.length });
  } catch (e) {
    if (e instanceof FileExistsError) return err(409, e.message);
    throw e;
  }
}

async function handleJsonBackup(req: Request, _params: Record<string, string | undefined>, ctx: AppContext): Promise<Response> {
  const body = await readJson<ExportRequest>(req);
  const dest = resolveDest(body.filename, "cratemind-backup.json", ctx.config.exportsDir);
  const path = exportJsonBackup(ctx.db, dest);
  return json({ path });
}

export function routes(): RouteDef[] {
  return [
    { method: "POST", pattern: new URLPattern({ pathname: "/api/export/m3u" }), handler: handleM3u },
    { method: "POST", pattern: new URLPattern({ pathname: "/api/export/csv" }), handler: handleCsv },
    { method: "POST", pattern: new URLPattern({ pathname: "/api/export/markdown" }), handler: handleMarkdown },
    {
      method: "POST",
      pattern: new URLPattern({ pathname: "/api/export/json-backup" }),
      handler: handleJsonBackup,
    },
  ];
}
