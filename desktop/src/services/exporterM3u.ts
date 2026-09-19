// M3U8 playlist export. Writes into the configured exports folder; never
// touches source library files. Port of backend/app/services/exporter_m3u.py.

import type { Track } from "../types/models.ts";

/** Thrown when `dest` already exists and `overwrite` is false. T10 (export
 * routes) catches this and maps it to HTTP 409. */
export class FileExistsError extends Error {
  constructor(path: string) {
    super(`${path} exists (pass overwrite=true to replace)`);
    this.name = "FileExistsError";
  }
}

/** True iff a filesystem entry exists at `path`. */
export function fileExists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Creates the parent directory of `dest` (recursively) if it has one. */
export function ensureParentDir(dest: string): void {
  const idx = dest.lastIndexOf("/");
  if (idx > 0) {
    Deno.mkdirSync(dest.slice(0, idx), { recursive: true });
  }
}

/** Writes an EXTM3U playlist for `tracks` to `dest`. Mirrors
 * exporter_m3u.export_m3u exactly: `#EXTM3U` header, one `#EXTINF` +
 * absolute-path pair per track, `\n`-joined with a trailing newline. */
export function exportM3u(tracks: Track[], dest: string, overwrite: boolean): string {
  if (fileExists(dest) && !overwrite) {
    throw new FileExistsError(dest);
  }
  ensureParentDir(dest);

  const lines = ["#EXTM3U"];
  for (const t of tracks) {
    const dur = t.duration ? Math.trunc(t.duration) : -1;
    const label = `${t.artist || "Unknown"} - ${t.title || t.file_name}`;
    lines.push(`#EXTINF:${dur},${label}`);
    lines.push(t.absolute_path);
  }
  Deno.writeTextFileSync(dest, lines.join("\n") + "\n");
  return dest;
}
