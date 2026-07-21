// Duplicate detection — builds review groups, never deletes or moves files.
// Exact-semantics port of backend/app/services/duplicate_detector.py.
//
// Two passes:
//   1. Exact: identical quick_hash -> same bytes (highest confidence).
//   2. Metadata suspect: normalised artist+title match with similar
//      duration. Different remix / radio edit are flagged for HUMAN review,
//      not resolved.
//
// This module only ever INSERTs into duplicate_groups/duplicate_group_tracks
// and DELETEs previously auto-generated (`needs_review`) groups — it never
// writes to `tracks` and never deletes/merges a track, matching the
// data-safety invariant: duplicate detection flags groups for review only.

import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "../utils/time.ts";
import type { Track } from "../types/models.ts";

const DUR_TOLERANCE = 5.0; // seconds — within this, "same recording" suspect

const BRACKET_RE = /[([].*?[)\]]/g;
const NOISE_WORDS_RE = /\b(original mix|extended mix|radio edit|remaster(ed)?|\d+bit)\b/g;
const NON_ALNUM_RE = /[^a-z0-9]+/g;

export function normalizeTitle(artist: string | null, title: string | null): string {
  let raw = `${artist ?? ""} ${title ?? ""}`.toLowerCase();
  raw = raw.replace(BRACKET_RE, " ");
  raw = raw.replace(NOISE_WORDS_RE, " ");
  raw = raw.replace(NON_ALNUM_RE, " ");
  return raw
    .split(/\s+/)
    .filter((s) => s.length > 0)
    .join(" ");
}

/** Removes previous auto-generated groups still needing review so a re-run
 * is idempotent. Resolved/ignored groups (human decisions) are preserved. */
function clearUnreviewed(db: DatabaseSync): void {
  const stale = db
    .prepare("SELECT id FROM duplicate_groups WHERE status = 'needs_review'")
    .all() as { id: number }[];
  if (stale.length === 0) return;
  const ids = stale.map((s) => s.id);
  const placeholders = ids.map(() => "?").join(", ");
  db.prepare(`DELETE FROM duplicate_group_tracks WHERE group_id IN (${placeholders})`).run(
    ...ids,
  );
  db.prepare(`DELETE FROM duplicate_groups WHERE id IN (${placeholders})`).run(...ids);
}

function createGroup(db: DatabaseSync, reason: string): number {
  const result = db
    .prepare("INSERT INTO duplicate_groups (reason, status, created_at) VALUES (?, 'needs_review', ?)")
    .run(reason, nowIso());
  return Number(result.lastInsertRowid);
}

function addGroupTrack(db: DatabaseSync, groupId: number, trackId: number): void {
  db.prepare(
    "INSERT INTO duplicate_group_tracks (group_id, track_id, role) VALUES (?, ?, NULL)",
  ).run(groupId, trackId);
}

export interface DuplicateDetectResult {
  groups_created: number;
  exact_groups: number;
  metadata_groups: number;
}

export function detectDuplicates(db: DatabaseSync): DuplicateDetectResult {
  clearUnreviewed(db);
  const tracks = db.prepare("SELECT * FROM tracks WHERE missing = 0").all() as unknown as Track[];

  const groupedTrackIds = new Set<number>();
  let exactCount = 0;
  let metadataCount = 0;

  // --- exact byte duplicates ---
  const byHash = new Map<string, Track[]>();
  for (const tr of tracks) {
    if (tr.quick_hash) {
      const list = byHash.get(tr.quick_hash) ?? [];
      list.push(tr);
      byHash.set(tr.quick_hash, list);
    }
  }
  for (const members of byHash.values()) {
    if (members.length < 2) continue;
    const groupId = createGroup(db, "exact: identical quick_hash");
    for (const tr of members) {
      addGroupTrack(db, groupId, tr.id);
      groupedTrackIds.add(tr.id);
    }
    exactCount += 1;
  }

  // --- metadata suspects (same normalised artist/title, similar duration) ---
  const byNorm = new Map<string, Track[]>();
  for (const tr of tracks) {
    if (groupedTrackIds.has(tr.id)) continue;
    const norm = normalizeTitle(tr.artist, tr.title);
    if (norm) {
      const list = byNorm.get(norm) ?? [];
      list.push(tr);
      byNorm.set(norm, list);
    }
  }

  for (const members of byNorm.values()) {
    if (members.length < 2) continue;
    // split into duration-similar clusters so radio edit vs extended don't
    // auto-merge: cluster only those within tolerance of each other
    const sorted = [...members].sort((a, b) => (a.duration ?? 0) - (b.duration ?? 0));
    const clusters: Track[][] = [];
    for (const tr of sorted) {
      let placed = false;
      for (const cl of clusters) {
        const base = cl[0].duration;
        if (base === null || tr.duration === null) continue;
        if (Math.abs((tr.duration ?? 0) - base) <= DUR_TOLERANCE) {
          cl.push(tr);
          placed = true;
          break;
        }
      }
      if (!placed) clusters.push([tr]);
    }
    for (const cl of clusters) {
      if (cl.length < 2) continue;
      const groupId = createGroup(db, "metadata: same artist/title, similar duration — review");
      for (const tr of cl) {
        addGroupTrack(db, groupId, tr.id);
        groupedTrackIds.add(tr.id);
      }
      metadataCount += 1;
    }
  }

  return {
    groups_created: exactCount + metadataCount,
    exact_groups: exactCount,
    metadata_groups: metadataCount,
  };
}
