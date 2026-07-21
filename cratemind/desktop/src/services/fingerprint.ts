// Acoustic fingerprinting via fpcalc / Chromaprint. Exact-semantics port of
// backend/app/services/fingerprint.py. Optional — no-op when fpcalc is
// absent. Read-only on source audio: fpcalc only ever reads the file.

import type { DatabaseSync } from "node:sqlite";
import { bindable } from "../utils/http.ts";
import { nowIso } from "../utils/time.ts";
import type { Track } from "../types/models.ts";

const FINGERPRINT_TIMEOUT_MS = 60_000;

interface FpcalcResult {
  chromaprint: string;
  duration_seconds: number | null;
}

async function computeFingerprint(
  fpcalcPath: string | null,
  filePath: string,
): Promise<FpcalcResult | null> {
  if (!fpcalcPath) return null;

  const command = new Deno.Command(fpcalcPath, {
    args: ["-json", filePath],
    stdout: "piped",
    stderr: "piped",
  });

  let child: Deno.ChildProcess;
  try {
    child = command.spawn();
  } catch {
    return null;
  }

  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // already exited
    }
  }, FINGERPRINT_TIMEOUT_MS);

  try {
    const output = await child.output();
    if (!output.success || output.stdout.byteLength === 0) return null;
    let data: { fingerprint?: string; duration?: number };
    try {
      data = JSON.parse(new TextDecoder().decode(output.stdout));
    } catch {
      return null;
    }
    if (!data.fingerprint) return null;
    return { chromaprint: data.fingerprint, duration_seconds: data.duration ?? null };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Fingerprints one track and upserts its `fingerprints` row. Returns false
 * (no-op, no row written) when fpcalc is unavailable or fails on this file. */
export async function fingerprintFile(
  db: DatabaseSync,
  fpcalcPath: string | null,
  track: Pick<Track, "id" | "absolute_path">,
): Promise<boolean> {
  const result = await computeFingerprint(fpcalcPath, track.absolute_path);
  if (result === null) return false;

  db.prepare(
    `INSERT INTO fingerprints (track_id, chromaprint, duration_seconds, fingerprinted_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (track_id) DO UPDATE SET
       chromaprint = excluded.chromaprint,
       duration_seconds = excluded.duration_seconds,
       fingerprinted_at = excluded.fingerprinted_at`,
  ).run(track.id, result.chromaprint, bindable(result.duration_seconds), nowIso());
  return true;
}

/** Fingerprints every non-missing track lacking a fingerprints row. Returns
 * the count fingerprinted; 0 (no-op) when fpcalc is unavailable. */
export async function fingerprintAll(
  db: DatabaseSync,
  fpcalcPath: string | null,
): Promise<number> {
  if (!fpcalcPath) return 0;
  const tracks = db
    .prepare("SELECT id, absolute_path FROM tracks WHERE missing = 0")
    .all() as { id: number; absolute_path: string }[];

  let done = 0;
  for (const tr of tracks) {
    const existing = db
      .prepare("SELECT track_id FROM fingerprints WHERE track_id = ?")
      .get(tr.id);
    if (existing !== undefined) continue;
    if (await fingerprintFile(db, fpcalcPath, tr)) done += 1;
  }
  return done;
}
