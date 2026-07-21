// Artist intelligence foundation endpoints. Port of backend/app/api/artists.py
// + backend/app/services/artist_catalog.py (DB-only aggregation).
//
// Isolation note (plan A11/T11): Python's artists.py imports `_apply_profile`
// from tracks.py. tracks.ts is owned/edited by a different Wave-2 task
// concurrently, so importing it here would transitively type-check a file
// this task doesn't own. Instead `applyProfilePartial` below is a small,
// self-contained inlined port of the same semantics (get-or-create the
// track_dj_profile row, set only the fields present in the request body,
// stamp updated_at, reindex FTS) — deliberately not sharing code with
// tracks.ts. It intentionally does not write to audit_log: that behavior
// belongs to tracks.ts's own (separately owned) profile-update path.
//
// Deliberate divergence: POST /api/artists/enrich always returns 501 —
// Python's enrich job calls out to an external LLM, and this app makes no
// external network calls.

import type { DatabaseSync } from "node:sqlite";
import type { AppContext, RouteDef } from "./dispatch.ts";
import { bindable, err, json, readJson, toBools } from "../utils/http.ts";
import { reindexTrack, withTx } from "../db/database.ts";
import { nowIso } from "../utils/time.ts";
import { normalizeArtist, primaryArtistName } from "../services/artistNormalizer.ts";
import type { ArtistProfileRow, TrackDJProfile } from "../types/models.ts";

function artistPayload(row: ArtistProfileRow) {
  return toBools(row, ["needs_review"]);
}

function profilePayload(row: TrackDJProfile) {
  return toBools(row, [
    "can_cut_into",
    "can_cut_out_of",
    "dramatic_transition_candidate",
    "human_confirmed",
  ]);
}

// Whitelisted, hard-coded column set — never build SQL from request body keys
// directly (Global Constraints: "Parameterized SQL only. Column/operator
// names only from hard-coded maps").
const PROFILE_FIELDS = new Set([
  "energy",
  "intensity",
  "darkness",
  "melody",
  "weirdness",
  "mixability",
  "confidence",
  "chaos_level",
  "set_role",
  "transition_role",
  "groove_type",
  "vocal_density",
  "breakdown_profile",
  "drop_profile",
  "bassline_type",
  "lead_character",
  "psy_substyle",
  "festival_time",
  "ritual_factor",
  "crowd_risk",
  "personal_status",
  "tempo_bridge_score",
  "bpm_jump_tolerance",
  "can_cut_into",
  "can_cut_out_of",
  "dramatic_transition_candidate",
  "notes",
  "human_confirmed",
]);

/** Inlined port of tracks.py's `_apply_profile` (see isolation note above):
 * get-or-create the track_dj_profile row, write only the fields present in
 * `update` (mirrors Pydantic's `exclude_unset=True`), stamp updated_at, and
 * reindex FTS since `notes` feeds track_search. */
function applyProfilePartial(
  db: DatabaseSync,
  trackId: number,
  update: Record<string, unknown>,
): TrackDJProfile {
  return withTx(db, () => {
    const existing = db
      .prepare("SELECT track_id FROM track_dj_profile WHERE track_id = ?")
      .get(trackId);
    const now = nowIso();

    if (existing === undefined) {
      db.prepare(
        `INSERT INTO track_dj_profile (track_id, personal_status, human_confirmed, updated_at)
         VALUES (?, 'unknown', 0, ?)`,
      ).run(trackId, now);
    }

    const fields = Object.keys(update).filter((k) => PROFILE_FIELDS.has(k));
    if (fields.length > 0) {
      const setClause = fields.map((k) => `${k} = ?`).join(", ");
      const values = fields.map((k) => bindable(update[k]));
      db.prepare(
        `UPDATE track_dj_profile SET ${setClause}, updated_at = ? WHERE track_id = ?`,
      ).run(...values, now, trackId);
    } else {
      db.prepare("UPDATE track_dj_profile SET updated_at = ? WHERE track_id = ?").run(
        now,
        trackId,
      );
    }

    reindexTrack(db, trackId);

    return db
      .prepare("SELECT * FROM track_dj_profile WHERE track_id = ?")
      .get(trackId) as unknown as TrackDJProfile;
  });
}

interface RebuildResult {
  tracks_seen: number;
  tracks_updated: number;
  artists_seen: number;
  artists_created: number;
  artists_updated: number;
}

/** Port of artist_catalog.py:rebuild_artist_profiles — refreshes
 * tracks.artist_normalized and aggregates artist_profiles from tracks, all
 * in one transaction (mirrors Python's single session.commit() at the end). */
export function rebuildArtistProfiles(db: DatabaseSync): RebuildResult {
  return withTx(db, () => {
    const tracks = db
      .prepare("SELECT id, artist, artist_normalized FROM tracks WHERE missing = 0")
      .all() as { id: number; artist: string | null; artist_normalized: string | null }[];

    // normalized_name -> canonical_name -> count (mirrors Python's
    // dict[str, Counter[str]]; Map preserves insertion order for tie-breaks).
    const buckets = new Map<string, Map<string, number>>();
    let tracksUpdated = 0;
    const now = nowIso();

    for (const track of tracks) {
      const normalized = normalizeArtist(track.artist);
      if (track.artist_normalized !== normalized) {
        db.prepare("UPDATE tracks SET artist_normalized = ? WHERE id = ?").run(
          bindable(normalized),
          track.id,
        );
        tracksUpdated += 1;
      }
      if (normalized === null) continue;
      const canonical = primaryArtistName(track.artist) ?? track.artist ?? normalized;
      const counter = buckets.get(normalized) ?? new Map<string, number>();
      counter.set(canonical, (counter.get(canonical) ?? 0) + 1);
      buckets.set(normalized, counter);
    }

    const existingRows = db
      .prepare("SELECT * FROM artist_profiles")
      .all() as unknown as ArtistProfileRow[];
    const existing = new Map(existingRows.map((row) => [row.normalized_name, row]));

    let created = 0;
    let updatedProfiles = 0;

    for (const [normalizedName, names] of buckets) {
      // Counter.most_common(1)[0][0]: highest count wins; ties keep the
      // first-inserted name (stable sort) — strict `>` below preserves that.
      let mostCommon = "";
      let mostCommonCount = -1;
      let trackCount = 0;
      for (const [name, count] of names) {
        trackCount += count;
        if (count > mostCommonCount) {
          mostCommon = name;
          mostCommonCount = count;
        }
      }

      const profile = existing.get(normalizedName);
      if (profile === undefined) {
        db.prepare(
          `INSERT INTO artist_profiles
             (normalized_name, canonical_name, track_count, needs_review, created_at, updated_at)
           VALUES (?, ?, ?, 0, ?, ?)`,
        ).run(normalizedName, mostCommon, trackCount, now, now);
        created += 1;
      } else {
        db.prepare(
          "UPDATE artist_profiles SET canonical_name = ?, track_count = ?, updated_at = ? WHERE id = ?",
        ).run(mostCommon, trackCount, now, profile.id);
        updatedProfiles += 1;
      }
    }

    for (const [normalizedName, profile] of existing) {
      if (buckets.has(normalizedName)) continue;
      if (profile.track_count !== 0) {
        db.prepare(
          "UPDATE artist_profiles SET track_count = 0, updated_at = ? WHERE id = ?",
        ).run(now, profile.id);
        updatedProfiles += 1;
      }
    }

    return {
      tracks_seen: tracks.length,
      tracks_updated: tracksUpdated,
      artists_seen: buckets.size,
      artists_created: created,
      artists_updated: updatedProfiles,
    };
  });
}

export function routes(): RouteDef[] {
  return [
    {
      method: "GET",
      pattern: new URLPattern({ pathname: "/api/artists" }),
      handler: (req, _params, ctx) => {
        const url = new URL(req.url);
        const q = url.searchParams.get("q");
        const confidenceLabel = url.searchParams.get("confidence_label");
        const needsReviewParam = url.searchParams.get("needs_review");
        const needsReview = needsReviewParam === null ? null : needsReviewParam === "true";
        const minTrackCountRaw = Number(url.searchParams.get("min_track_count") ?? "0");
        const minTrackCount = Number.isFinite(minTrackCountRaw) ? minTrackCountRaw : 0;
        const limitRaw = Number(url.searchParams.get("limit") ?? "200");
        const limit = Math.min(Number.isFinite(limitRaw) ? limitRaw : 200, 5000);
        const offsetRaw = Number(url.searchParams.get("offset") ?? "0");
        const offset = Number.isFinite(offsetRaw) ? offsetRaw : 0;

        const conditions: string[] = [];
        const args: unknown[] = [];
        if (q) {
          conditions.push("(canonical_name LIKE ? OR normalized_name LIKE ?)");
          args.push(`%${q}%`, `%${q}%`);
        }
        if (confidenceLabel) {
          conditions.push("confidence_label = ?");
          args.push(confidenceLabel);
        }
        if (needsReview !== null) {
          conditions.push("needs_review = ?");
          args.push(needsReview ? 1 : 0);
        }
        if (minTrackCount > 0) {
          conditions.push("track_count >= ?");
          args.push(minTrackCount);
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const rows = ctx.db
          .prepare(
            `SELECT * FROM artist_profiles ${where}
             ORDER BY track_count DESC, canonical_name ASC
             LIMIT ? OFFSET ?`,
          )
          .all(...args.map((a) => bindable(a)), limit, offset) as unknown as ArtistProfileRow[];

        return json(rows.map(artistPayload));
      },
    },

    {
      method: "GET",
      pattern: new URLPattern({ pathname: "/api/artists/stats" }),
      handler: (_req, _params, ctx) => {
        const totalArtists = ctx.db
          .prepare("SELECT COUNT(*) AS c FROM artist_profiles")
          .get() as { c: number };
        const activeArtists = ctx.db
          .prepare("SELECT COUNT(*) AS c FROM artist_profiles WHERE track_count > 0")
          .get() as { c: number };
        const unenrichedArtists = ctx.db
          .prepare("SELECT COUNT(*) AS c FROM artist_profiles WHERE last_enriched_at IS NULL")
          .get() as { c: number };
        const needsReviewArtists = ctx.db
          .prepare("SELECT COUNT(*) AS c FROM artist_profiles WHERE needs_review = 1")
          .get() as { c: number };

        return json({
          total_artists: totalArtists.c,
          active_artists: activeArtists.c,
          unenriched_artists: unenrichedArtists.c,
          needs_review_artists: needsReviewArtists.c,
        });
      },
    },

    {
      method: "POST",
      pattern: new URLPattern({ pathname: "/api/artists/rebuild" }),
      handler: (_req, _params, ctx) => json(rebuildArtistProfiles(ctx.db)),
    },

    {
      method: "POST",
      pattern: new URLPattern({ pathname: "/api/artists/enrich" }),
      handler: () => err(501, "Not available in desktop build"),
    },

    {
      method: "POST",
      pattern: new URLPattern({ pathname: "/api/artists/tracks/:id/accept-prefill" }),
      handler: async (req, params, ctx) => {
        const trackId = Number(params.id);
        const track = ctx.db.prepare("SELECT id FROM tracks WHERE id = ?").get(trackId);
        if (track === undefined) {
          return err(404, "track not found");
        }
        const body = await readJson<Record<string, unknown>>(req);
        const profile = applyProfilePartial(ctx.db, trackId, body);
        return json(profilePayload(profile));
      },
    },

    {
      method: "GET",
      pattern: new URLPattern({ pathname: "/api/artists/:id" }),
      handler: (_req, params, ctx) => {
        const id = Number(params.id);
        const row = ctx.db
          .prepare("SELECT * FROM artist_profiles WHERE id = ?")
          .get(id) as ArtistProfileRow | undefined;
        if (row === undefined) {
          return err(404, "artist not found");
        }
        return json(artistPayload(row));
      },
    },
  ];
}
