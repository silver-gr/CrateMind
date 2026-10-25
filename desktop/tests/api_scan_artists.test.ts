// Wave 2 (T11) test suite: scan.ts, artists.ts, system.ts — dispatched with
// ONLY these three modules' own routes (never router.ts, per Wave 2 test
// isolation rules), against an isolated temp-dir DB from tests/helpers.ts.

import { assert, assertEquals } from "@std/assert";
import { dispatch } from "../src/api/dispatch.ts";
import type { AppContext, RouteDef } from "../src/api/dispatch.ts";
import { routes as scanRoutes } from "../src/api/scan.ts";
import { routes as artistsRoutes } from "../src/api/artists.ts";
import { routes as systemRoutes } from "../src/api/system.ts";
import { makeTestCtx, seedTrack } from "./helpers.ts";
import { getActiveJobPromise } from "../src/services/jobs.ts";

function ownRoutes(): RouteDef[] {
  return [...systemRoutes(), ...scanRoutes(), ...artistsRoutes()];
}

function getReq(ctx: AppContext, path: string): Request {
  return new Request(`http://${ctx.config.host}:${ctx.config.port}${path}`);
}

function postJson(ctx: AppContext, path: string, body: unknown = {}): Request {
  return new Request(`http://${ctx.config.host}:${ctx.config.port}${path}`, {
    method: "POST",
    headers: {
      host: `${ctx.config.host}:${ctx.config.port}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// system.ts
// ---------------------------------------------------------------------------

Deno.test("GET /api/health returns exactly main.py's key set", async () => {
  const t = await makeTestCtx();
  try {
    t.ctx.config.libraryRoots = ["/music/lib"];
    t.ctx.config.ffprobePath = "/usr/bin/ffprobe";
    t.ctx.config.fpcalcPath = null;
    t.ctx.config.ffmpegPath = null;

    const res = await dispatch(ownRoutes(), getReq(t.ctx, "/api/health"), t.ctx);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body, {
      status: "ok",
      library_roots: ["/music/lib"],
      ffprobe: true,
      fpcalc: false,
      ffmpeg: false,
      db: t.ctx.config.dbFile,
    });
  } finally {
    await t.cleanup();
  }
});

Deno.test("GET /api/settings returns exactly main.py's key set", async () => {
  const t = await makeTestCtx();
  try {
    t.ctx.config.ffprobePath = "/usr/bin/ffprobe";
    t.ctx.config.fpcalcPath = null;
    t.ctx.config.ffmpegPath = "/opt/homebrew/bin/ffmpeg";

    const res = await dispatch(ownRoutes(), getReq(t.ctx, "/api/settings"), t.ctx);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body, {
      library_roots: t.ctx.config.libraryRoots,
      output_dir: t.ctx.config.exportsDir,
      db_path: t.ctx.config.dbFile,
      backup_dir: t.ctx.config.backupDir,
      ffprobe: "/usr/bin/ffprobe",
      fpcalc: null,
      ffmpeg: "/opt/homebrew/bin/ffmpeg",
    });
  } finally {
    await t.cleanup();
  }
});

// ---------------------------------------------------------------------------
// scan.ts
// ---------------------------------------------------------------------------

Deno.test("POST /api/scan/start returns 400 when no library roots are configured", async () => {
  const t = await makeTestCtx();
  try {
    t.ctx.config.libraryRoots = [];
    const res = await dispatch(ownRoutes(), postJson(t.ctx, "/api/scan/start", {}), t.ctx);
    assertEquals(res.status, 400);
    assertEquals(await res.json(), {
      detail: "No library roots configured. Set CRATEMIND_LIBRARY_ROOTS.",
    });
  } finally {
    await t.cleanup();
  }
});

Deno.test(
  "POST /api/scan/start scans a temp dir to done with a processed count; source files untouched",
  async () => {
    const t = await makeTestCtx();
    let libDir = "";
    try {
      libDir = await Deno.makeTempDir({ prefix: "cratemind-lib-" });
      const fileA = `${libDir}/track-a.mp3`;
      const fileB = `${libDir}/track-b.mp3`;
      await Deno.writeFile(fileA, new TextEncoder().encode("fixture audio bytes A"));
      await Deno.writeFile(fileB, new TextEncoder().encode("fixture audio bytes B, a bit longer"));
      const beforeA = await Deno.stat(fileA);
      const beforeB = await Deno.stat(fileB);

      t.ctx.config.libraryRoots = [libDir];

      const startRes = await dispatch(ownRoutes(), postJson(t.ctx, "/api/scan/start", {}), t.ctx);
      assertEquals(startRes.status, 200);
      const job = await startRes.json();
      assert(job.id > 0);

      await getActiveJobPromise(job.id);

      const finished = t.ctx.db
        .prepare("SELECT status, processed FROM jobs WHERE id = ?")
        .get(job.id) as { status: string; processed: number };
      assertEquals(finished.status, "done");
      assertEquals(finished.processed, 2);

      const trackCount = t.ctx.db.prepare("SELECT COUNT(*) AS c FROM tracks").get() as {
        c: number;
      };
      assertEquals(trackCount.c, 2);

      // Data-safety invariant: a scan never mutates source audio.
      const afterA = await Deno.stat(fileA);
      const afterB = await Deno.stat(fileB);
      assertEquals(afterA.size, beforeA.size);
      assertEquals(afterA.mtime?.getTime(), beforeA.mtime?.getTime());
      assertEquals(afterB.size, beforeB.size);
      assertEquals(afterB.mtime?.getTime(), beforeB.mtime?.getTime());
      assertEquals(
        new TextDecoder().decode(await Deno.readFile(fileA)),
        "fixture audio bytes A",
      );
    } finally {
      await t.cleanup();
      if (libDir) await Deno.remove(libDir, { recursive: true });
    }
  },
);

Deno.test("POST /api/scan/fingerprint returns 400 without fpcalc on PATH", async () => {
  const t = await makeTestCtx();
  try {
    t.ctx.config.fpcalcPath = null;
    const res = await dispatch(ownRoutes(), postJson(t.ctx, "/api/scan/fingerprint", {}), t.ctx);
    assertEquals(res.status, 400);
    assertEquals(await res.json(), { detail: "fpcalc/Chromaprint not found on PATH." });
  } finally {
    await t.cleanup();
  }
});

Deno.test("POST /api/scan/duplicates runs a job to done", async () => {
  const t = await makeTestCtx();
  try {
    const res = await dispatch(ownRoutes(), postJson(t.ctx, "/api/scan/duplicates", {}), t.ctx);
    assertEquals(res.status, 200);
    const job = await res.json();
    assertEquals(job.kind, "duplicate_scan");

    await getActiveJobPromise(job.id);
    const finished = t.ctx.db.prepare("SELECT status FROM jobs WHERE id = ?").get(job.id) as {
      status: string;
    };
    assertEquals(finished.status, "done");
  } finally {
    await t.cleanup();
  }
});

Deno.test("POST /api/scan/analyze always returns 501", async () => {
  const t = await makeTestCtx();
  try {
    const res = await dispatch(
      ownRoutes(),
      postJson(t.ctx, "/api/scan/analyze", { force: false }),
      t.ctx,
    );
    assertEquals(res.status, 501);
    assertEquals(await res.json(), { detail: "Not available in desktop build" });
  } finally {
    await t.cleanup();
  }
});

Deno.test("GET /api/scan/status: job_id lookup, latest-by-id-desc, 404, and null-when-empty", async () => {
  const t = await makeTestCtx();
  try {
    // no jobs yet -> null
    let res = await dispatch(ownRoutes(), getReq(t.ctx, "/api/scan/status"), t.ctx);
    assertEquals(res.status, 200);
    assertEquals(await res.json(), null);

    // unknown job_id -> 404
    res = await dispatch(ownRoutes(), getReq(t.ctx, "/api/scan/status?job_id=999999"), t.ctx);
    assertEquals(res.status, 404);
    assertEquals(await res.json(), { detail: "job not found" });

    const firstRes = await dispatch(
      ownRoutes(),
      postJson(t.ctx, "/api/scan/duplicates", {}),
      t.ctx,
    );
    const first = await firstRes.json();
    await getActiveJobPromise(first.id);

    const secondRes = await dispatch(
      ownRoutes(),
      postJson(t.ctx, "/api/scan/duplicates", {}),
      t.ctx,
    );
    const second = await secondRes.json();
    await getActiveJobPromise(second.id);

    res = await dispatch(ownRoutes(), getReq(t.ctx, "/api/scan/status"), t.ctx);
    assertEquals((await res.json()).id, second.id);

    res = await dispatch(ownRoutes(), getReq(t.ctx, `/api/scan/status?job_id=${first.id}`), t.ctx);
    assertEquals((await res.json()).id, first.id);
  } finally {
    await t.cleanup();
  }
});

// ---------------------------------------------------------------------------
// artists.ts
// ---------------------------------------------------------------------------

Deno.test(
  "POST /api/artists/rebuild aggregates artist_profiles from tracks (merges underscore variants); GET /api/artists/stats counts",
  async () => {
    const t = await makeTestCtx();
    try {
      seedTrack(t.ctx.db, { artist: "Boards of Canada", artist_normalized: null });
      seedTrack(t.ctx.db, { artist: "Boards_of_Canada", artist_normalized: null });
      seedTrack(t.ctx.db, { artist: "Aphex Twin", artist_normalized: null });

      const res = await dispatch(ownRoutes(), postJson(t.ctx, "/api/artists/rebuild", {}), t.ctx);
      assertEquals(res.status, 200);
      const result = await res.json();
      assertEquals(result, {
        tracks_seen: 3,
        tracks_updated: 3,
        artists_seen: 2,
        artists_created: 2,
        artists_updated: 0,
      });

      const listRes = await dispatch(ownRoutes(), getReq(t.ctx, "/api/artists"), t.ctx);
      const list = (await listRes.json()) as { canonical_name: string; track_count: number; needs_review: boolean }[];
      assertEquals(list.length, 2);
      const boc = list.find((a) => a.canonical_name === "Boards of Canada");
      assert(boc !== undefined);
      assertEquals(boc.track_count, 2);
      assertEquals(typeof boc.needs_review, "boolean");

      const statsRes = await dispatch(ownRoutes(), getReq(t.ctx, "/api/artists/stats"), t.ctx);
      assertEquals(await statsRes.json(), {
        total_artists: 2,
        active_artists: 2,
        unenriched_artists: 2,
        needs_review_artists: 0,
      });

      // re-running rebuild with no track changes updates (not re-creates) profiles
      const res2 = await dispatch(ownRoutes(), postJson(t.ctx, "/api/artists/rebuild", {}), t.ctx);
      const result2 = await res2.json();
      assertEquals(result2.artists_created, 0);
      assertEquals(result2.artists_updated, 2);
      assertEquals(result2.tracks_updated, 0); // artist_normalized already stable
    } finally {
      await t.cleanup();
    }
  },
);

Deno.test("GET /api/artists filters by q, confidence_label, needs_review, min_track_count", async () => {
  const t = await makeTestCtx();
  try {
    seedTrack(t.ctx.db, { artist: "Boards of Canada", artist_normalized: null });
    seedTrack(t.ctx.db, { artist: "Aphex Twin", artist_normalized: null });
    await dispatch(ownRoutes(), postJson(t.ctx, "/api/artists/rebuild", {}), t.ctx);

    let res = await dispatch(ownRoutes(), getReq(t.ctx, "/api/artists?q=boards"), t.ctx);
    let list = await res.json();
    assertEquals(list.length, 1);
    assertEquals(list[0].canonical_name, "Boards of Canada");

    res = await dispatch(ownRoutes(), getReq(t.ctx, "/api/artists?min_track_count=5"), t.ctx);
    list = await res.json();
    assertEquals(list.length, 0);

    res = await dispatch(ownRoutes(), getReq(t.ctx, "/api/artists?needs_review=true"), t.ctx);
    list = await res.json();
    assertEquals(list.length, 0);
  } finally {
    await t.cleanup();
  }
});

Deno.test(
  "POST /api/artists/tracks/:id/accept-prefill writes profile fields, converts booleans, and FTS-reindexes",
  async () => {
    const t = await makeTestCtx();
    try {
      const trackId = seedTrack(t.ctx.db, { artist: "Four Tet", title: "Baby" });

      const res = await dispatch(
        ownRoutes(),
        postJson(t.ctx, `/api/artists/tracks/${trackId}/accept-prefill`, {
          energy: 7,
          set_role: "peak",
          can_cut_into: true,
          notes: "shimmering breakdown",
        }),
        t.ctx,
      );
      assertEquals(res.status, 200);
      const profile = await res.json();
      assertEquals(profile.track_id, trackId);
      assertEquals(profile.energy, 7);
      assertEquals(profile.set_role, "peak");
      assertEquals(profile.can_cut_into, true); // real JSON boolean, not 0/1
      assertEquals(profile.notes, "shimmering breakdown");
      assert(typeof profile.updated_at === "string" && profile.updated_at.length > 0);

      const row = t.ctx.db
        .prepare("SELECT energy, can_cut_into FROM track_dj_profile WHERE track_id = ?")
        .get(trackId) as { energy: number; can_cut_into: number };
      assertEquals(row.energy, 7);
      assertEquals(row.can_cut_into, 1); // stored as SQLite 0/1

      const ftsHit = t.ctx.db
        .prepare("SELECT rowid FROM track_search WHERE track_search MATCH ?")
        .all("shimmering") as { rowid: number }[];
      assertEquals(ftsHit.length, 1);
      assertEquals(ftsHit[0].rowid, trackId);

      const missing = await dispatch(
        ownRoutes(),
        postJson(t.ctx, "/api/artists/tracks/999999/accept-prefill", { energy: 5 }),
        t.ctx,
      );
      assertEquals(missing.status, 404);
      assertEquals(await missing.json(), { detail: "track not found" });
    } finally {
      await t.cleanup();
    }
  },
);

Deno.test("POST /api/artists/enrich always returns 501", async () => {
  const t = await makeTestCtx();
  try {
    const res = await dispatch(ownRoutes(), postJson(t.ctx, "/api/artists/enrich", {}), t.ctx);
    assertEquals(res.status, 501);
    assertEquals(await res.json(), { detail: "Not available in desktop build" });
  } finally {
    await t.cleanup();
  }
});

Deno.test("GET /api/artists/:id: literal routes are not shadowed by /:id, and /:id itself 404s cleanly", async () => {
  const t = await makeTestCtx();
  try {
    seedTrack(t.ctx.db, { artist: "Boards of Canada", artist_normalized: null });
    await dispatch(ownRoutes(), postJson(t.ctx, "/api/artists/rebuild", {}), t.ctx);

    // literal /stats must hit the stats handler, not GET /:id with id="stats"
    const statsRes = await dispatch(ownRoutes(), getReq(t.ctx, "/api/artists/stats"), t.ctx);
    assertEquals(statsRes.status, 200);
    const statsBody = await statsRes.json();
    assert("total_artists" in statsBody);
    assert(!("detail" in statsBody));

    // a real numeric id still resolves via /:id
    const listRes = await dispatch(ownRoutes(), getReq(t.ctx, "/api/artists"), t.ctx);
    const [artist] = await listRes.json();
    const byIdRes = await dispatch(
      ownRoutes(),
      getReq(t.ctx, `/api/artists/${artist.id}`),
      t.ctx,
    );
    assertEquals(byIdRes.status, 200);
    assertEquals((await byIdRes.json()).id, artist.id);

    const notFound = await dispatch(ownRoutes(), getReq(t.ctx, "/api/artists/999999"), t.ctx);
    assertEquals(notFound.status, 404);
    assertEquals(await notFound.json(), { detail: "artist not found" });
  } finally {
    await t.cleanup();
  }
});

Deno.test("GET /api/capabilities declares desktop limits explicitly", async () => {
  const t = await makeTestCtx();
  try {
    const response = await dispatch(ownRoutes(), getReq(t.ctx, "/api/capabilities"), t.ctx);
    assertEquals(response.status, 200);
    assertEquals(await response.json(), { identity: false, analysis: false, artist_enrichment: false, backup_import: true, complete_backup: false });
  } finally {
    await t.cleanup();
  }
});
