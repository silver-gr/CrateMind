// Markdown setlist export — for notes, posts, event reviews. Port of
// backend/app/services/exporter_markdown.py.

import type { DJSetRow, Track } from "../types/models.ts";
import { ensureParentDir, fileExists, FileExistsError } from "./exporterM3u.ts";

/** m:ss duration formatting matching exporter_markdown.py's _fmt_dur
 * ("--:--" for falsy/zero duration). */
function fmtDur(seconds: number | null): string {
  if (!seconds) return "--:--";
  const total = Math.trunc(seconds);
  const m = Math.trunc(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Writes a Markdown setlist for `djSet`/`tracks` to `dest`. Mirrors
 * exporter_markdown.export_markdown line-for-line. */
export function exportMarkdown(
  djSet: DJSetRow,
  tracks: Track[],
  dest: string,
  overwrite: boolean,
): string {
  if (fileExists(dest) && !overwrite) {
    throw new FileExistsError(dest);
  }
  ensureParentDir(dest);

  const lines = [`# ${djSet.title}`, ""];
  if (djSet.date) {
    lines.push(`**Date:** ${djSet.date}`);
  }
  const total = tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
  lines.push(`**Tracks:** ${tracks.length} · **Duration:** ${fmtDur(total)}`);
  lines.push("");
  tracks.forEach((t, i) => {
    const bpm = t.bpm ? ` — ${t.bpm} BPM` : "";
    const key = t.key_text ? ` — ${t.key_text}` : "";
    lines.push(
      `${i + 1}. ${t.artist || "Unknown"} — ${t.title || t.file_name} (${fmtDur(t.duration)})${bpm}${key}`,
    );
  });
  if (djSet.notes) {
    lines.push("", "## Notes", "", djSet.notes);
  }
  Deno.writeTextFileSync(dest, lines.join("\n") + "\n");
  return dest;
}
