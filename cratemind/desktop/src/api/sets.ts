// Sets + pair-notes API routes. Port of backend/app/api/sets.py: set CRUD,
// ordered-track membership, position reorder, analysis panel, next-track
// recommender context assembly, play logging, and pair-note transition memory.

import type { DatabaseSync } from "node:sqlite";
import type { AppContext, RouteDef } from "./dispatch.ts";
import { bindable, HttpError, json, readJson, toBools } from "../utils/http.ts";
import { nowIso } from "../utils/time.ts";
import { withTx } from "../db/database.ts";
import { effectiveBpm, effectiveKey, recommend } from "../services/recommender.ts";
import type { Context } from "../services/recommender.ts";
import type {
  DJSetRow,
  PairNoteCreate,
  PlayLog,
  RecommendQuery,
  SetCreate,
  SetReorder,
  SetTrackAdd,
  SetTrackRow,
  Track,
  TrackDJProfile,
  TrackPairNoteRow,
} from "../types/models.ts";

const TRACK_BOOL_KEYS: (keyof Track)[] = ["missing"];
const PROFILE_BOOL_KEYS: (keyof TrackDJProfile)[] = [
  "can_cut_into",
  "can_cut_out_of",
  "dramatic_transition_candidate",
  "human_confirmed",
];

// ---- shared helpers -----------------------------------------------------

function getSet(db: DatabaseSync, setId: number): DJSetRow | undefined {
  return db.prepare("SELECT * FROM sets WHERE id = ?").get(setId) as
    | DJSetRow
    | undefined;
}

function getTrack(db: DatabaseSync, trackId: number): Track | undefined {
  return db.prepare("SELECT * FROM tracks WHERE id = ?").get(trackId) as
    | Track
    | undefined;
}

function getProfile(db: DatabaseSync, trackId: number): TrackDJProfile | undefined {
  return db.prepare("SELECT * FROM track_dj_profile WHERE track_id = ?").get(
    trackId,
  ) as TrackDJProfile | undefined;
}

/** Port of sets.py:_ordered_tracks — links joined to their track, ordered by
 * position, skipping any link whose track no longer exists. */
function orderedTracks(
  db: DatabaseSync,
  setId: number,
): { link: SetTrackRow; track: Track }[] {
  const links = db
    .prepare("SELECT * FROM set_tracks WHERE set_id = ? ORDER BY position")
    .all(setId) as unknown as SetTrackRow[];
  const out: { link: SetTrackRow; track: Track }[] = [];
  for (const link of links) {
    const tr = getTrack(db, link.track_id);
    if (tr !== undefined) out.push({ link, track: tr });
  }
  return out;
}

// ---- set CRUD -------------------------------------------------------------

function listSets(db: DatabaseSync): DJSetRow[] {
  return db.prepare("SELECT * FROM sets ORDER BY id DESC").all() as unknown as DJSetRow[];
}

async function createSet(req: Request, ctx: AppContext): Promise<Response> {
  const body = await readJson<SetCreate>(req);
  const now = nowIso();
  const result = ctx.db
    .prepare(
      `INSERT INTO sets (title, date, target_duration, target_bpm_arc, target_energy_arc, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      body.title,
      bindable(body.date ?? null),
      bindable(body.target_duration ?? null),
      bindable(body.target_bpm_arc ?? null),
      bindable(body.target_energy_arc ?? null),
      bindable(body.notes ?? null),
      now,
    );
  const id = Number(result.lastInsertRowid);
  return json(getSet(ctx.db, id));
}

function getSetDetail(setId: number, ctx: AppContext): Response {
  const djSet = getSet(ctx.db, setId);
  if (djSet === undefined) throw new HttpError(404, "set not found");
  const tracks = orderedTracks(ctx.db, setId).map(({ link, track }) => {
    const prof = getProfile(ctx.db, track.id);
    return {
      position: link.position,
      note: link.note,
      track: toBools(track, TRACK_BOOL_KEYS),
      profile: prof ? toBools(prof, PROFILE_BOOL_KEYS) : null,
    };
  });
  return json({ set: djSet, tracks });
}

async function addTrack(
  req: Request,
  setId: number,
  ctx: AppContext,
): Promise<Response> {
  if (getSet(ctx.db, setId) === undefined) {
    throw new HttpError(404, "set not found");
  }
  const body = await readJson<SetTrackAdd>(req);
  if (getTrack(ctx.db, body.track_id) === undefined) {
    throw new HttpError(404, "track not found");
  }
  const existing = orderedTracks(ctx.db, setId);
  const position = body.position != null
    ? body.position
    : existing.length > 0
    ? existing[existing.length - 1].link.position + 1
    : 0;
  ctx.db
    .prepare(
      `INSERT INTO set_tracks (set_id, position, track_id, note) VALUES (?, ?, ?, ?)`,
    )
    .run(setId, position, body.track_id, bindable(body.note ?? null));
  return json({ set_id: setId, position, track_id: body.track_id });
}

async function reorder(
  req: Request,
  setId: number,
  ctx: AppContext,
): Promise<Response> {
  if (getSet(ctx.db, setId) === undefined) {
    throw new HttpError(404, "set not found");
  }
  const body = await readJson<SetReorder>(req);

  withTx(ctx.db, () => {
    const existing = orderedTracks(ctx.db, setId);
    const byTrackId = new Map(existing.map((e) => [e.track.id, e.link]));

    // rewrite positions in two passes to avoid PK (set_id, position) collisions
    for (const link of byTrackId.values()) {
      ctx.db
        .prepare(
          "UPDATE set_tracks SET position = ? WHERE set_id = ? AND position = ?",
        )
        .run(link.position + 100000, setId, link.position);
    }
    body.ordered_track_ids.forEach((trackId, newPos) => {
      const link = byTrackId.get(trackId);
      if (link !== undefined) {
        ctx.db
          .prepare(
            "UPDATE set_tracks SET position = ? WHERE set_id = ? AND position = ?",
          )
          .run(newPos, setId, link.position + 100000);
      }
    });
  });

  return json({ set_id: setId, order: body.ordered_track_ids });
}

function removeTrack(setId: number, trackId: number, ctx: AppContext): Response {
  const links = ctx.db
    .prepare("SELECT * FROM set_tracks WHERE set_id = ? AND track_id = ?")
    .all(setId, trackId) as unknown as SetTrackRow[];
  if (links.length === 0) {
    throw new HttpError(404, "track not in set");
  }
  // NO position compaction — intentional Python-parity quirk.
  ctx.db
    .prepare("DELETE FROM set_tracks WHERE set_id = ? AND track_id = ?")
    .run(setId, trackId);
  return json({ removed: true });
}

// ---- analysis ---------------------------------------------------------

function analysis(setId: number, ctx: AppContext): Response {
  if (getSet(ctx.db, setId) === undefined) {
    throw new HttpError(404, "set not found");
  }
  const rows = orderedTracks(ctx.db, setId);

  const bpmCurve: (number | null)[] = [];
  const energyCurve: (number | null)[] = [];
  const darknessCurve: (number | null)[] = [];
  const artists = new Map<string, number>();
  const risky: { position: number; track_id: number; label: string }[] = [];
  const notApproved: { position: number; track_id: number; label: string }[] = [];
  const transitionWarnings: { from_position: number; message: string }[] = [];
  let totalDuration = 0;
  let prev: { track: Track; profile: TrackDJProfile | undefined } | null = null;

  for (const { link, track } of rows) {
    const prof = getProfile(ctx.db, track.id);
    totalDuration += track.duration ?? 0;
    bpmCurve.push(effectiveBpm(track));
    energyCurve.push(prof?.energy ?? null);
    darknessCurve.push(prof?.darkness ?? null);
    if (track.artist) {
      artists.set(track.artist, (artists.get(track.artist) ?? 0) + 1);
    }
    const status = prof?.personal_status ?? "unknown";
    if (status === "retired" || status === "avoid" || (prof && (prof.weirdness ?? 0) >= 8)) {
      risky.push({ position: link.position, track_id: track.id, label: `${track.artist} - ${track.title}` });
    }
    if (status !== "approved" && status !== "weapon") {
      notApproved.push({ position: link.position, track_id: track.id, label: `${track.artist} - ${track.title}` });
    }
    if (prev !== null) {
      const ptr = prev.track;
      const pbpm = effectiveBpm(ptr);
      const cbpm = effectiveBpm(track);
      if (pbpm && cbpm && Math.abs(pbpm - cbpm) > 8) {
        transitionWarnings.push({
          from_position: link.position - 1,
          message: `BPM jump ${pbpm}->${cbpm}`,
        });
      }
      if (ptr.artist && track.artist && ptr.artist === track.artist) {
        transitionWarnings.push({
          from_position: link.position - 1,
          message: `same artist back-to-back: ${track.artist}`,
        });
      }
    }
    prev = { track, profile: prof };
  }

  const repeated: Record<string, number> = {};
  for (const [artist, count] of artists) {
    if (count > 1) repeated[artist] = count;
  }

  return json({
    track_count: rows.length,
    total_duration: totalDuration,
    bpm_curve: bpmCurve,
    energy_curve: energyCurve,
    darkness_curve: darknessCurve,
    repeated_artists: repeated,
    risky_tracks: risky,
    not_approved: notApproved,
    transition_warnings: transitionWarnings,
  });
}

// ---- recommend-next -----------------------------------------------------

async function recommendNext(
  req: Request,
  setId: number,
  ctx: AppContext,
): Promise<Response> {
  if (getSet(ctx.db, setId) === undefined) {
    throw new HttpError(404, "set not found");
  }
  const body = await readJson<RecommendQuery>(req);
  const rows = orderedTracks(ctx.db, setId);
  const inSet = new Set(rows.map((r) => r.track.id));

  let lastTrack: Track | undefined;
  if (body.after_track_id != null) {
    lastTrack = getTrack(ctx.db, body.after_track_id);
  } else if (rows.length > 0) {
    lastTrack = rows[rows.length - 1].track;
  }

  // bridge target: the track the candidate must lead INTO (Track B)
  let nextTrack: Track | undefined;
  if (body.before_track_id != null) {
    nextTrack = getTrack(ctx.db, body.before_track_id);
  }

  const recentCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const recentRows = ctx.db
    .prepare("SELECT track_id FROM play_events WHERE played_at >= ?")
    .all(recentCutoff) as unknown as { track_id: number }[];
  const recentIds = new Set(recentRows.map((r) => r.track_id));

  const recCtx: Context = {
    previous_key: lastTrack ? effectiveKey(lastTrack) : null,
    previous_bpm: lastTrack ? effectiveBpm(lastTrack) : null,
    next_key: nextTrack ? effectiveKey(nextTrack) : null,
    next_bpm: nextTrack ? effectiveBpm(nextTrack) : null,
    after_track_id: lastTrack ? lastTrack.id : null,
    before_track_id: nextTrack ? nextTrack.id : null,
    target_bpm: body.target_bpm || (lastTrack ? effectiveBpm(lastTrack) : null),
    target_energy: body.target_energy ?? null,
    target_role: body.target_role ?? null,
    max_weirdness: body.max_weirdness ?? null,
    approved_only: body.approved_only ?? false,
    need_bridge: body.need_bridge || nextTrack !== undefined,
    exclude_ids: inSet,
    recently_played_ids: recentIds,
  };

  return json(recommend(ctx.db, recCtx, body.limit ?? 20));
}

// ---- log-play -----------------------------------------------------------

async function logPlay(
  req: Request,
  setId: number,
  ctx: AppContext,
): Promise<Response> {
  if (getSet(ctx.db, setId) === undefined) {
    throw new HttpError(404, "set not found");
  }
  const body = await readJson<PlayLog>(req);
  const rows = orderedTracks(ctx.db, setId);
  const now = nowIso();

  withTx(ctx.db, () => {
    for (const { track } of rows) {
      ctx.db
        .prepare(
          `INSERT INTO play_events (track_id, set_id, played_at, context, crowd_reaction, notes)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          track.id,
          setId,
          now,
          bindable(body.context ?? null),
          bindable(body.crowd_reaction ?? null),
          bindable(body.notes ?? null),
        );
      ctx.db
        .prepare(
          "UPDATE tracks SET play_count = play_count + 1, last_played_at = ? WHERE id = ?",
        )
        .run(now, track.id);
    }
  });

  return json({ set_id: setId, tracks_logged: rows.length });
}

// ---- pair notes -----------------------------------------------------------

function listPairNotes(trackId: number | null, ctx: AppContext): Response {
  let rows: TrackPairNoteRow[];
  if (trackId !== null) {
    rows = ctx.db
      .prepare(
        `SELECT * FROM track_pair_notes
          WHERE from_track_id = ? OR to_track_id = ?
          ORDER BY id DESC`,
      )
      .all(trackId, trackId) as unknown as TrackPairNoteRow[];
  } else {
    rows = ctx.db
      .prepare("SELECT * FROM track_pair_notes ORDER BY id DESC")
      .all() as unknown as TrackPairNoteRow[];
  }
  return json(rows);
}

async function createPairNote(req: Request, ctx: AppContext): Promise<Response> {
  const body = await readJson<PairNoteCreate>(req);
  const now = nowIso();
  const result = ctx.db
    .prepare(
      `INSERT INTO track_pair_notes (from_track_id, to_track_id, rating, transition_type, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      body.from_track_id,
      body.to_track_id,
      bindable(body.rating ?? null),
      bindable(body.transition_type ?? null),
      bindable(body.notes ?? null),
      now,
    );
  const id = Number(result.lastInsertRowid);
  const row = ctx.db.prepare("SELECT * FROM track_pair_notes WHERE id = ?").get(id);
  return json(row);
}

// ---- routes ---------------------------------------------------------------

export function routes(): RouteDef[] {
  return [
    {
      method: "GET",
      pattern: new URLPattern({ pathname: "/api/sets" }),
      handler: (_req, _params, ctx) => json(listSets(ctx.db)),
    },
    {
      method: "POST",
      pattern: new URLPattern({ pathname: "/api/sets" }),
      handler: (req, _params, ctx) => createSet(req, ctx),
    },
    {
      method: "GET",
      pattern: new URLPattern({ pathname: "/api/sets/:id" }),
      handler: (_req, params, ctx) => getSetDetail(Number(params.id), ctx),
    },
    {
      method: "POST",
      pattern: new URLPattern({ pathname: "/api/sets/:id/tracks" }),
      handler: (req, params, ctx) => addTrack(req, Number(params.id), ctx),
    },
    {
      method: "PATCH",
      pattern: new URLPattern({ pathname: "/api/sets/:id/tracks/reorder" }),
      handler: (req, params, ctx) => reorder(req, Number(params.id), ctx),
    },
    {
      method: "DELETE",
      pattern: new URLPattern({ pathname: "/api/sets/:id/tracks/:trackId" }),
      handler: (_req, params, ctx) =>
        removeTrack(Number(params.id), Number(params.trackId), ctx),
    },
    {
      method: "GET",
      pattern: new URLPattern({ pathname: "/api/sets/:id/analysis" }),
      handler: (_req, params, ctx) => analysis(Number(params.id), ctx),
    },
    {
      method: "POST",
      pattern: new URLPattern({ pathname: "/api/sets/:id/recommend-next" }),
      handler: (req, params, ctx) => recommendNext(req, Number(params.id), ctx),
    },
    {
      method: "POST",
      pattern: new URLPattern({ pathname: "/api/sets/:id/log-play" }),
      handler: (req, params, ctx) => logPlay(req, Number(params.id), ctx),
    },
    {
      method: "GET",
      pattern: new URLPattern({ pathname: "/api/pair-notes" }),
      handler: (req, _params, ctx) => {
        const trackIdParam = new URL(req.url).searchParams.get("track_id");
        const trackId = trackIdParam !== null ? Number(trackIdParam) : null;
        return listPairNotes(trackId, ctx);
      },
    },
    {
      method: "POST",
      pattern: new URLPattern({ pathname: "/api/pair-notes" }),
      handler: (req, _params, ctx) => createPairNote(req, ctx),
    },
  ];
}
