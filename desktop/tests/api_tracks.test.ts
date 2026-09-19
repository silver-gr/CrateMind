import { assert, assertEquals, assertExists } from "@std/assert";
import { routes } from "../src/api/tracks.ts";
import { dispatch } from "../src/api/dispatch.ts";
import type { AppContext } from "../src/api/dispatch.ts";
import { makeTestCtx, seedProfile, seedTrack } from "./helpers.ts";
import { searchTracks } from "../src/services/searchExecutor.ts";

const OWN_ROUTES = routes();

function apiUrl(ctx: AppContext, path: string): string {
  return `http://${ctx.config.host}:${ctx.config.port}${path}`;
}

function get(ctx: AppContext, path: string): Request {
  return new Request(apiUrl(ctx, path), { method: "GET" });
}

function mutate(ctx: AppContext, method: string, path: string, body?: unknown): Request {
  return new Request(apiUrl(ctx, path), {
    method,
    headers: {
      host: `${ctx.config.host}:${ctx.config.port}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// Full key set for a TrackListRow: every column of the `tracks` table
// (mirrors backend/app/models.py Track.model_dump()) plus the five fields
// `_list_payload` (tracks.py) merges in.
const TRACK_ROW_KEYS = [
  "id", "absolute_path", "normalized_path", "volume_root", "file_name", "extension",
  "file_size", "modified_time", "created_time", "duration", "bitrate", "sample_rate",
  "channels", "codec", "container", "artist", "artist_normalized", "title", "album",
  "label", "year", "genre", "comment", "bpm", "key_text", "rating", "bpm_analyzed",
  "bpm_analyzed_raw", "bpm_analyzed_confidence", "bpm_analyzed_method", "key_analyzed",
  "key_analyzed_confidence", "analyzed_at", "analysis_error", "quick_hash", "full_hash",
  "play_count", "last_played_at", "imported_at", "last_scanned_at", "missing",
];
const LIST_ROW_KEYS = [...TRACK_ROW_KEYS, "personal_status", "energy", "darkness", "set_role", "artist_prefill"];

Deno.test("GET /api/tracks: default limit is 200, rows carry full enrichment key set", async () => {
  const t = await makeTestCtx();
  try {
    const { db } = t.ctx;
    for (let i = 0; i < 205; i++) {
      seedTrack(db, { absolute_path: `/lib/track-${i}.mp3`, artist: `Artist ${i}`, title: `Title ${i}` });
    }

    const res = await dispatch(OWN_ROUTES, get(t.ctx, "/api/tracks"), t.ctx);
    assertEquals(res.status, 200);
    const rows = (await res.json()) as Record<string, unknown>[];
    assertEquals(rows.length, 200);

    const keys = new Set(Object.keys(rows[0]));
    assertEquals(keys, new Set(LIST_ROW_KEYS));
    assertEquals(typeof rows[0].missing, "boolean");
  } finally {
    await t.cleanup();
  }
});

Deno.test("GET /api/tracks: enrichment merges profile summary + artist_prefill with real nested booleans", async () => {
  const t = await makeTestCtx();
  try {
    const { db } = t.ctx;
    const id = seedTrack(db, {
      absolute_path: "/lib/prefill.mp3",
      artist: "Prefill Artist",
      artist_normalized: "prefill artist",
      bpm: 150,
    });
    seedProfile(db, id, { energy: 8, darkness: 6, set_role: "peak", personal_status: "approved" });

    db.prepare(
      `INSERT INTO artist_profiles
        (normalized_name, canonical_name, aliases_json, track_count, scene_cluster,
         primary_subgenre, secondary_subgenres_json, typical_bpm_min, typical_bpm_max,
         energy_min, energy_max, set_role_hints_json, confidence_label, needs_review,
         notes, raw_llm_json, last_enriched_at, created_at, updated_at)
       VALUES (?, ?, NULL, 1, NULL, NULL, ?, ?, ?, NULL, NULL, ?, 'high', ?, NULL, NULL, NULL, ?, ?)`,
    ).run(
      "prefill artist",
      "Prefill Artist",
      JSON.stringify(["techno"]),
      140,
      145, // typical_bpm_max < track bpm (150) -> bpm_conflict should be true
      JSON.stringify(["peak"]),
      1,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );

    const res = await dispatch(OWN_ROUTES, get(t.ctx, "/api/tracks"), t.ctx);
    const rows = (await res.json()) as Record<string, unknown>[];
    const row = rows.find((r) => r.id === id)!;

    assertEquals(row.personal_status, "approved");
    assertEquals(row.energy, 8);
    assertEquals(row.darkness, 6);
    assertEquals(row.set_role, "peak");

    const prefill = row.artist_prefill as Record<string, unknown>;
    assertExists(prefill);
    assertEquals(typeof prefill.needs_review, "boolean");
    assertEquals(prefill.needs_review, true);
    assertEquals(typeof prefill.bpm_conflict, "boolean");
    assertEquals(prefill.bpm_conflict, true);
    assertEquals(prefill.secondary_subgenres, ["techno"]);
    assertEquals(prefill.set_role_hints, ["peak"]);
    assertEquals(prefill.energy_range, [null, null]);
  } finally {
    await t.cleanup();
  }
});

Deno.test("GET /api/tracks?q=: search branch returns same enrichment shape", async () => {
  const t = await makeTestCtx();
  try {
    const { db } = t.ctx;
    seedTrack(db, { absolute_path: "/lib/findme.mp3", artist: "Findme", title: "Unique Title" });
    seedTrack(db, { absolute_path: "/lib/other.mp3", artist: "Other", title: "Other Title" });

    const res = await dispatch(OWN_ROUTES, get(t.ctx, "/api/tracks?q=Unique"), t.ctx);
    assertEquals(res.status, 200);
    const rows = (await res.json()) as Record<string, unknown>[];
    assertEquals(rows.length, 1);
    assertEquals(rows[0].title, "Unique Title");
  } finally {
    await t.cleanup();
  }
});

Deno.test("GET /api/tracks/search", async () => {
  const t = await makeTestCtx();
  try {
    const { db } = t.ctx;
    seedTrack(db, { absolute_path: "/lib/a.mp3", title: "Alpha" });
    seedTrack(db, { absolute_path: "/lib/b.mp3", title: "Beta" });

    const res = await dispatch(OWN_ROUTES, get(t.ctx, "/api/tracks/search?q=Alpha"), t.ctx);
    assertEquals(res.status, 200);
    const rows = (await res.json()) as Record<string, unknown>[];
    assertEquals(rows.length, 1);
    assertEquals(rows[0].title, "Alpha");
  } finally {
    await t.cleanup();
  }
});

Deno.test("GET /api/tracks/count", async () => {
  const t = await makeTestCtx();
  try {
    const { db } = t.ctx;
    seedTrack(db, { absolute_path: "/lib/a.mp3", title: "Alpha" });
    seedTrack(db, { absolute_path: "/lib/b.mp3", title: "Beta" });

    const res = await dispatch(OWN_ROUTES, get(t.ctx, "/api/tracks/count"), t.ctx);
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { count: 2 });

    const filtered = await dispatch(OWN_ROUTES, get(t.ctx, "/api/tracks/count?q=Alpha"), t.ctx);
    assertEquals(await filtered.json(), { count: 1 });
  } finally {
    await t.cleanup();
  }
});

Deno.test("GET /api/tracks/:id — 404 for unknown id, full detail shape for known id", async () => {
  const t = await makeTestCtx();
  try {
    const { db } = t.ctx;
    const id = seedTrack(db, { absolute_path: "/lib/detail.mp3", title: "Detail Track" });
    seedProfile(db, id, { energy: 5, can_cut_into: 1, human_confirmed: 1 });

    const missing = await dispatch(OWN_ROUTES, get(t.ctx, "/api/tracks/999999"), t.ctx);
    assertEquals(missing.status, 404);
    assertEquals(await missing.json(), { detail: "track not found" });

    const res = await dispatch(OWN_ROUTES, get(t.ctx, `/api/tracks/${id}`), t.ctx);
    assertEquals(res.status, 200);
    const body = (await res.json()) as { track: Record<string, unknown>; profile: Record<string, unknown>; tags: unknown[] };

    assertEquals(new Set(Object.keys(body.track)), new Set([...TRACK_ROW_KEYS, "artist_prefill"]));
    assertEquals(typeof body.track.missing, "boolean");
    assertEquals(body.track.artist_prefill, null);
    assertExists(body.profile);
    assertEquals(body.profile!.energy, 5);
    assertEquals(typeof body.profile!.can_cut_into, "boolean");
    assertEquals(body.profile!.can_cut_into, true);
    assertEquals(typeof body.profile!.human_confirmed, "boolean");
    assertEquals(body.tags, []);
  } finally {
    await t.cleanup();
  }
});

Deno.test("PATCH /api/tracks/:id/profile — partial upsert, only provided fields, FTS visibility after reindex", async () => {
  const t = await makeTestCtx();
  try {
    const { db } = t.ctx;
    const id = seedTrack(db, { absolute_path: "/lib/profile.mp3", title: "Profile Track" });

    // First partial update creates the profile row with only `energy` set.
    const res1 = await dispatch(
      OWN_ROUTES,
      mutate(t.ctx, "PATCH", `/api/tracks/${id}/profile`, { energy: 8 }),
      t.ctx,
    );
    assertEquals(res1.status, 200);
    const p1 = await res1.json();
    assertEquals(p1.energy, 8);
    assertEquals(p1.darkness, null);
    assertEquals(p1.personal_status, "unknown");
    assertEquals(typeof p1.human_confirmed, "boolean");
    assertEquals(p1.human_confirmed, false);
    assertExists(p1.updated_at);

    // Second partial update sets a different field; the first field must survive.
    const res2 = await dispatch(
      OWN_ROUTES,
      mutate(t.ctx, "PATCH", `/api/tracks/${id}/profile`, { darkness: 6, notes: "banger for peak hour" }),
      t.ctx,
    );
    assertEquals(res2.status, 200);
    const p2 = await res2.json();
    assertEquals(p2.energy, 8); // preserved from the earlier partial update
    assertEquals(p2.darkness, 6);
    assertEquals(p2.notes, "banger for peak hour");

    // reindexTrack was called -> the new note is now findable via FTS search.
    assertEquals(searchTracks(db, "banger").map((r) => r.id), [id]);

    const notFound = await dispatch(
      OWN_ROUTES,
      mutate(t.ctx, "PATCH", "/api/tracks/999999/profile", { energy: 1 }),
      t.ctx,
    );
    assertEquals(notFound.status, 404);
  } finally {
    await t.cleanup();
  }
});

Deno.test("POST /api/tracks/:id/play — increments play_count/last_played_at; not_recent:30 stops matching", async () => {
  const t = await makeTestCtx();
  try {
    const { db } = t.ctx;
    const id = seedTrack(db, { absolute_path: "/lib/play.mp3", title: "Play Track", play_count: 0 });

    // Never played -> matches not_recent:30 before the play is logged.
    assert(searchTracks(db, "not_recent:30").some((r) => r.id === id));

    const res = await dispatch(
      OWN_ROUTES,
      mutate(t.ctx, "POST", `/api/tracks/${id}/play`, { context: "peak set", crowd_reaction: 5 }),
      t.ctx,
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.track_id, id);
    assertEquals(body.play_count, 1);
    assertExists(body.last_played_at);

    const playEvents = db.prepare("SELECT * FROM play_events WHERE track_id = ?").all(id);
    assertEquals(playEvents.length, 1);

    // Just played -> excluded by not_recent:30 now.
    assert(!searchTracks(db, "not_recent:30").some((r) => r.id === id));

    const notFound = await dispatch(OWN_ROUTES, mutate(t.ctx, "POST", "/api/tracks/999999/play", {}), t.ctx);
    assertEquals(notFound.status, 404);
  } finally {
    await t.cleanup();
  }
});

Deno.test("POST /api/tracks/batch-profile — updates only existing track ids, returns {updated}", async () => {
  const t = await makeTestCtx();
  try {
    const { db } = t.ctx;
    const id1 = seedTrack(db, { absolute_path: "/lib/batch1.mp3" });
    const id2 = seedTrack(db, { absolute_path: "/lib/batch2.mp3" });
    seedProfile(db, id2, { energy: 1 });

    const res = await dispatch(
      OWN_ROUTES,
      mutate(t.ctx, "POST", "/api/tracks/batch-profile", {
        track_ids: [id1, id2, 999999],
        profile: { energy: 7, set_role: "builder" },
      }),
      t.ctx,
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { updated: 2 });

    const p1 = db.prepare("SELECT energy, set_role FROM track_dj_profile WHERE track_id = ?").get(id1);
    const p2 = db.prepare("SELECT energy, set_role FROM track_dj_profile WHERE track_id = ?").get(id2);
    assertEquals(p1, { energy: 7, set_role: "builder" });
    assertEquals(p2, { energy: 7, set_role: "builder" });
  } finally {
    await t.cleanup();
  }
});

async function writeAudioFile(dir: string, name: string, bytes: Uint8Array): Promise<string> {
  const path = `${dir}/${name}`;
  await Deno.writeFile(path, bytes);
  return path;
}

Deno.test("GET /api/tracks/:id/audio — status ladder: 200/206/416/404/410/415", async () => {
  const t = await makeTestCtx();
  try {
    const { db, dir: ctxDir } = { db: t.ctx.db, dir: t.dir };
    const bytes = new TextEncoder().encode("0123456789"); // 10 bytes
    const path = await writeAudioFile(ctxDir, "audio.mp3", bytes);
    const id = seedTrack(db, { absolute_path: path, extension: "mp3" });

    // 200: full file, no Range header.
    const full = await dispatch(OWN_ROUTES, get(t.ctx, `/api/tracks/${id}/audio`), t.ctx);
    assertEquals(full.status, 200);
    assertEquals(full.headers.get("content-length"), "10");
    assertEquals(new TextDecoder().decode(await full.arrayBuffer()), "0123456789");

    // 206: valid partial range.
    const partialReq = new Request(apiUrl(t.ctx, `/api/tracks/${id}/audio`), {
      headers: { range: "bytes=0-3" },
    });
    const partial = await dispatch(OWN_ROUTES, partialReq, t.ctx);
    assertEquals(partial.status, 206);
    assertEquals(partial.headers.get("content-range"), "bytes 0-3/10");
    assertEquals(new TextDecoder().decode(await partial.arrayBuffer()), "0123");

    // 416: unsatisfiable range.
    const badReq = new Request(apiUrl(t.ctx, `/api/tracks/${id}/audio`), {
      headers: { range: "bytes=9999-19999" },
    });
    const bad = await dispatch(OWN_ROUTES, badReq, t.ctx);
    assertEquals(bad.status, 416);
    assertEquals(bad.headers.get("content-range"), "bytes */10");
    assertEquals((await bad.arrayBuffer()).byteLength, 0);

    // 404: unknown track id.
    const notFound = await dispatch(OWN_ROUTES, get(t.ctx, "/api/tracks/999999/audio"), t.ctx);
    assertEquals(notFound.status, 404);
    assertEquals(await notFound.json(), { detail: "track not found" });

    // 410: track row points at a file that no longer exists on disk.
    const goneId = seedTrack(db, { absolute_path: `${ctxDir}/does-not-exist.mp3`, extension: "mp3" });
    const gone = await dispatch(OWN_ROUTES, get(t.ctx, `/api/tracks/${goneId}/audio`), t.ctx);
    assertEquals(gone.status, 410);
    assertEquals(await gone.json(), { detail: "audio file no longer present on disk" });

    // 415: unsupported extension (AIFF is deliberately excluded from AUDIO_MIME).
    const aiffPath = await writeAudioFile(ctxDir, "audio.aiff", bytes);
    const aiffId = seedTrack(db, { absolute_path: aiffPath, extension: "aiff" });
    const unsupported = await dispatch(OWN_ROUTES, get(t.ctx, `/api/tracks/${aiffId}/audio`), t.ctx);
    assertEquals(unsupported.status, 415);
    const unsupportedBody = await unsupported.json();
    assert(String(unsupportedBody.detail).includes("unsupported audio format"));
  } finally {
    await t.cleanup();
  }
});
