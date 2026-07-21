// Port of backend/tests/test_sets_effective.py plus lifecycle, reorder,
// no-compaction removal, recommend-next context assembly, log-play recency,
// and pair-note coverage for desktop/src/api/sets.ts (T8).

import { assert, assertEquals } from "@std/assert";
import { routes } from "../src/api/sets.ts";
import { dispatch } from "../src/api/dispatch.ts";
import type { AppContext } from "../src/api/dispatch.ts";
import { makeTestCtx, seedProfile, seedTrack } from "./helpers.ts";

function req(
  ctx: AppContext,
  method: string,
  path: string,
  body?: unknown,
): Request {
  const headers: Record<string, string> = {};
  const init: RequestInit = { method };
  if (method !== "GET") {
    headers["host"] = `${ctx.config.host}:${ctx.config.port}`;
    headers["content-type"] = "application/json";
    if (body !== undefined) init.body = JSON.stringify(body);
  }
  init.headers = headers;
  return new Request(`http://localhost${path}`, init);
}

async function call(
  ctx: AppContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await dispatch(routes(), req(ctx, method, path, body), ctx);
  const text = await res.text();
  return { status: res.status, body: text.length > 0 ? JSON.parse(text) : null };
}

// ---- set lifecycle --------------------------------------------------------

Deno.test("set lifecycle: create, list, get detail", async () => {
  const t = await makeTestCtx();
  try {
    const created = await call(t.ctx, "POST", "/api/sets", { title: "Peak Set" });
    assertEquals(created.status, 200);
    assertEquals(created.body.title, "Peak Set");
    const setId = created.body.id;

    const listed = await call(t.ctx, "GET", "/api/sets");
    assertEquals(listed.status, 200);
    assert(listed.body.some((s: any) => s.id === setId));

    const detail = await call(t.ctx, "GET", `/api/sets/${setId}`);
    assertEquals(detail.status, 200);
    assertEquals(detail.body.set.id, setId);
    assertEquals(detail.body.tracks, []);
  } finally {
    await t.cleanup();
  }
});

Deno.test("get set 404 when missing", async () => {
  const t = await makeTestCtx();
  try {
    const res = await call(t.ctx, "GET", "/api/sets/999");
    assertEquals(res.status, 404);
    assertEquals(res.body, { detail: "set not found" });
  } finally {
    await t.cleanup();
  }
});

Deno.test("add track 404s: set not found, track not found", async () => {
  const t = await makeTestCtx();
  try {
    const missingSet = await call(t.ctx, "POST", "/api/sets/999/tracks", { track_id: 1 });
    assertEquals(missingSet.status, 404);
    assertEquals(missingSet.body, { detail: "set not found" });

    const setId = (await call(t.ctx, "POST", "/api/sets", { title: "S" })).body.id;
    const missingTrack = await call(t.ctx, "POST", `/api/sets/${setId}/tracks`, { track_id: 999 });
    assertEquals(missingTrack.status, 404);
    assertEquals(missingTrack.body, { detail: "track not found" });
  } finally {
    await t.cleanup();
  }
});

Deno.test("add 4 tracks defaults to sequential positions", async () => {
  const t = await makeTestCtx();
  try {
    const setId = (await call(t.ctx, "POST", "/api/sets", { title: "S" })).body.id;
    const ids = [1, 2, 3, 4].map(() => seedTrack(t.ctx.db));
    for (const tid of ids) {
      const res = await call(t.ctx, "POST", `/api/sets/${setId}/tracks`, { track_id: tid });
      assertEquals(res.status, 200);
    }
    const detail = await call(t.ctx, "GET", `/api/sets/${setId}`);
    assertEquals(detail.body.tracks.map((x: any) => x.position), [0, 1, 2, 3]);
    assertEquals(detail.body.tracks.map((x: any) => x.track.id), ids);
  } finally {
    await t.cleanup();
  }
});

Deno.test("add track honors explicit position", async () => {
  const t = await makeTestCtx();
  try {
    const setId = (await call(t.ctx, "POST", "/api/sets", { title: "S" })).body.id;
    const tid = seedTrack(t.ctx.db);
    const res = await call(t.ctx, "POST", `/api/sets/${setId}/tracks`, { track_id: tid, position: 5 });
    assertEquals(res.body, { set_id: setId, position: 5, track_id: tid });
  } finally {
    await t.cleanup();
  }
});

// ---- reorder ----------------------------------------------------------

Deno.test("reorder rewrites positions two-pass, response echoes order", async () => {
  const t = await makeTestCtx();
  try {
    const setId = (await call(t.ctx, "POST", "/api/sets", { title: "S" })).body.id;
    const ids = [1, 2, 3, 4].map(() => seedTrack(t.ctx.db));
    for (const tid of ids) {
      await call(t.ctx, "POST", `/api/sets/${setId}/tracks`, { track_id: tid });
    }
    const reversed = [...ids].reverse();
    const res = await call(t.ctx, "PATCH", `/api/sets/${setId}/tracks/reorder`, {
      ordered_track_ids: reversed,
    });
    assertEquals(res.status, 200);
    assertEquals(res.body, { set_id: setId, order: reversed });

    const detail = await call(t.ctx, "GET", `/api/sets/${setId}`);
    assertEquals(detail.body.tracks.map((x: any) => x.track.id), reversed);
    assertEquals(detail.body.tracks.map((x: any) => x.position), [0, 1, 2, 3]);
  } finally {
    await t.cleanup();
  }
});

Deno.test("reorder 404s when set missing", async () => {
  const t = await makeTestCtx();
  try {
    const res = await call(t.ctx, "PATCH", "/api/sets/999/tracks/reorder", { ordered_track_ids: [] });
    assertEquals(res.status, 404);
  } finally {
    await t.cleanup();
  }
});

// ---- remove: no compaction ----------------------------------------------

Deno.test("remove track: {removed:true}, no position compaction", async () => {
  const t = await makeTestCtx();
  try {
    const setId = (await call(t.ctx, "POST", "/api/sets", { title: "S" })).body.id;
    const [t1, t2, t3] = [1, 2, 3].map(() => seedTrack(t.ctx.db));
    for (const tid of [t1, t2, t3]) {
      await call(t.ctx, "POST", `/api/sets/${setId}/tracks`, { track_id: tid });
    }
    const res = await call(t.ctx, "DELETE", `/api/sets/${setId}/tracks/${t2}`);
    assertEquals(res.status, 200);
    assertEquals(res.body, { removed: true });

    const detail = await call(t.ctx, "GET", `/api/sets/${setId}`);
    // t1 stays at position 0, t3 stays at position 2 — the gap at 1 is NOT
    // compacted (intentional Python-parity quirk).
    assertEquals(
      detail.body.tracks.map((x: any) => [x.position, x.track.id]),
      [[0, t1], [2, t3]],
    );
  } finally {
    await t.cleanup();
  }
});

Deno.test("remove track 404 'track not in set' when link absent", async () => {
  const t = await makeTestCtx();
  try {
    const setId = (await call(t.ctx, "POST", "/api/sets", { title: "S" })).body.id;
    const tid = seedTrack(t.ctx.db);
    const res = await call(t.ctx, "DELETE", `/api/sets/${setId}/tracks/${tid}`);
    assertEquals(res.status, 404);
    assertEquals(res.body, { detail: "track not in set" });
  } finally {
    await t.cleanup();
  }
});

// ---- analysis -----------------------------------------------------------

Deno.test("analysis: bpm_curve falls back to analyzed BPM (test_sets_effective golden)", async () => {
  const t = await makeTestCtx();
  try {
    const tid = seedTrack(t.ctx.db, { bpm: null, bpm_analyzed: 142.0 });
    const setId = (await call(t.ctx, "POST", "/api/sets", { title: "T" })).body.id;
    await call(t.ctx, "POST", `/api/sets/${setId}/tracks`, { track_id: tid });
    const res = await call(t.ctx, "GET", `/api/sets/${setId}/analysis`);
    assertEquals(res.body.bpm_curve, [142.0]);
  } finally {
    await t.cleanup();
  }
});

Deno.test("analysis: curves, repeats, risky/not_approved, transition warnings", async () => {
  const t = await makeTestCtx();
  try {
    const setId = (await call(t.ctx, "POST", "/api/sets", { title: "T" })).body.id;

    const a = seedTrack(t.ctx.db, { artist: "Boris Brejcha", title: "A", bpm: 140, duration: 300 });
    seedProfile(t.ctx.db, a, { energy: 7, darkness: 5, personal_status: "approved" });

    // same artist as `a`, back-to-back, and a BPM jump > 8
    const b = seedTrack(t.ctx.db, { artist: "Boris Brejcha", title: "B", bpm: 152, duration: 300 });
    seedProfile(t.ctx.db, b, { energy: 8, darkness: 6, personal_status: "retired" });

    const c = seedTrack(t.ctx.db, { artist: "Solomun", title: "C", bpm: 150, duration: 300 });
    seedProfile(t.ctx.db, c, { energy: 6, darkness: 4, personal_status: "testing", weirdness: 9 });

    for (const tid of [a, b, c]) {
      await call(t.ctx, "POST", `/api/sets/${setId}/tracks`, { track_id: tid });
    }

    const res = await call(t.ctx, "GET", `/api/sets/${setId}/analysis`);
    const body = res.body;
    assertEquals(body.track_count, 3);
    assertEquals(body.total_duration, 900);
    assertEquals(body.bpm_curve, [140, 152, 150]);
    assertEquals(body.energy_curve, [7, 8, 6]);
    assertEquals(body.darkness_curve, [5, 6, 4]);
    assertEquals(body.repeated_artists, { "Boris Brejcha": 2 });

    // risky: b is retired, c has weirdness 9 >= 8
    assertEquals(body.risky_tracks.map((r: any) => r.track_id).sort(), [b, c].sort());
    // not_approved: b (retired) and c (testing) — a is approved
    assertEquals(body.not_approved.map((r: any) => r.track_id).sort(), [b, c].sort());

    // transition_warnings: a->b same-artist + bpm jump (140->152 = 12 > 8)
    const messages: string[] = body.transition_warnings.map((w: any) => w.message);
    assert(messages.some((m) => m.includes("BPM jump")));
    assert(messages.some((m) => m.includes("same artist back-to-back")));
    assert(body.transition_warnings.every((w: any) => w.from_position === 0));
  } finally {
    await t.cleanup();
  }
});

// ---- recommend-next -------------------------------------------------------

Deno.test("recommend-next: in-set tracks excluded", async () => {
  const t = await makeTestCtx();
  try {
    const setId = (await call(t.ctx, "POST", "/api/sets", { title: "T" })).body.id;
    const inSetTrack = seedTrack(t.ctx.db, { bpm: 140 });
    await call(t.ctx, "POST", `/api/sets/${setId}/tracks`, { track_id: inSetTrack });
    seedTrack(t.ctx.db, { bpm: 140 }); // candidate, not in set

    const res = await call(t.ctx, "POST", `/api/sets/${setId}/recommend-next`, {});
    assertEquals(res.status, 200);
    assert(!res.body.some((r: any) => r.track_id === inSetTrack));
  } finally {
    await t.cleanup();
  }
});

Deno.test("recommend-next: empty set works, returns candidates", async () => {
  const t = await makeTestCtx();
  try {
    const setId = (await call(t.ctx, "POST", "/api/sets", { title: "T" })).body.id;
    seedTrack(t.ctx.db, { bpm: 128 });
    const res = await call(t.ctx, "POST", `/api/sets/${setId}/recommend-next`, {});
    assertEquals(res.status, 200);
    assert(Array.isArray(res.body));
    assert(res.body.length >= 1);
  } finally {
    await t.cleanup();
  }
});

Deno.test("recommend-next: 404 when set missing", async () => {
  const t = await makeTestCtx();
  try {
    const res = await call(t.ctx, "POST", "/api/sets/999/recommend-next", {});
    assertEquals(res.status, 404);
  } finally {
    await t.cleanup();
  }
});

Deno.test("recommend-next: bridge auto-enabled when before_track_id present", async () => {
  const t = await makeTestCtx();
  try {
    const setId = (await call(t.ctx, "POST", "/api/sets", { title: "T" })).body.id;
    const lastTrack = seedTrack(t.ctx.db, { bpm: 140 });
    await call(t.ctx, "POST", `/api/sets/${setId}/tracks`, { track_id: lastTrack });

    const bridgeCandidate = seedTrack(t.ctx.db, { bpm: 140 });
    seedProfile(t.ctx.db, bridgeCandidate, { transition_role: "bridge" });

    const nextTrack = seedTrack(t.ctx.db, { bpm: 140 }); // Track B

    // need_bridge NOT passed explicitly — must be auto-derived true because
    // before_track_id is present (sets.py:215).
    const res = await call(t.ctx, "POST", `/api/sets/${setId}/recommend-next`, {
      before_track_id: nextTrack,
    });
    assertEquals(res.status, 200);
    const row = res.body.find((r: any) => r.track_id === bridgeCandidate);
    assert(row !== undefined);
    assert(row.reasons.includes("+ bridge candidate"));
  } finally {
    await t.cleanup();
  }
});

Deno.test("recommend-next: target_bpm 0 falls through to last track's effective bpm", async () => {
  const t = await makeTestCtx();
  try {
    const setId = (await call(t.ctx, "POST", "/api/sets", { title: "T" })).body.id;
    const lastTrack = seedTrack(t.ctx.db, { bpm: 140 });
    await call(t.ctx, "POST", `/api/sets/${setId}/tracks`, { track_id: lastTrack });

    const exactMatch = seedTrack(t.ctx.db, { bpm: 140 }); // not in set

    const res = await call(t.ctx, "POST", `/api/sets/${setId}/recommend-next`, {
      target_bpm: 0,
    });
    assertEquals(res.status, 200);
    const row = res.body.find((r: any) => r.track_id === exactMatch);
    assert(row !== undefined);
    // diff between 140 (exactMatch) and target_bpm fallback (140, last
    // track's effective bpm) is 0 -> "BPM close"; if target_bpm:0 had been
    // used literally, diff would be 140 -> "BPM far".
    assert(row.reasons.some((r: string) => r.includes("BPM close")));
    assert(!row.reasons.some((r: string) => r.includes("BPM far")));
  } finally {
    await t.cleanup();
  }
});

Deno.test("recommend-next: flat-shape golden", async () => {
  const t = await makeTestCtx();
  try {
    const setId = (await call(t.ctx, "POST", "/api/sets", { title: "T" })).body.id;
    const tid = seedTrack(t.ctx.db, { artist: "A", title: "B", bpm: 128 });
    seedProfile(t.ctx.db, tid, { energy: 5, set_role: "peak", personal_status: "approved" });

    const res = await call(t.ctx, "POST", `/api/sets/${setId}/recommend-next`, {});
    assertEquals(res.status, 200);
    const row = res.body[0];
    assertEquals(
      Object.keys(row).sort(),
      [
        "artist",
        "bpm",
        "bpm_is_analyzed",
        "energy",
        "key",
        "key_is_analyzed",
        "personal_status",
        "reasons",
        "score",
        "set_role",
        "title",
        "track_id",
      ].sort(),
    );
  } finally {
    await t.cleanup();
  }
});

// ---- log-play -----------------------------------------------------------

Deno.test("log-play: bumps play_count/last_played_at, {tracks_logged}, recency visible", async () => {
  const t = await makeTestCtx();
  try {
    const set1 = (await call(t.ctx, "POST", "/api/sets", { title: "S1" })).body.id;
    const tid = seedTrack(t.ctx.db);
    await call(t.ctx, "POST", `/api/sets/${set1}/tracks`, { track_id: tid });

    const res = await call(t.ctx, "POST", `/api/sets/${set1}/log-play`, {});
    assertEquals(res.status, 200);
    assertEquals(res.body, { set_id: set1, tracks_logged: 1 });

    const row = t.ctx.db.prepare("SELECT play_count, last_played_at FROM tracks WHERE id = ?").get(tid) as any;
    assertEquals(row.play_count, 1);
    assert(row.last_played_at !== null);

    // recency visible: candidate now excluded from "fresh" bonus and marked
    // "played recently" from a DIFFERENT set's recommend-next.
    const set2 = (await call(t.ctx, "POST", "/api/sets", { title: "S2" })).body.id;
    const recRes = await call(t.ctx, "POST", `/api/sets/${set2}/recommend-next`, {});
    const candidateRow = recRes.body.find((r: any) => r.track_id === tid);
    assert(candidateRow !== undefined);
    assert(candidateRow.reasons.includes("- played recently"));
  } finally {
    await t.cleanup();
  }
});

Deno.test("log-play 404 when set missing", async () => {
  const t = await makeTestCtx();
  try {
    const res = await call(t.ctx, "POST", "/api/sets/999/log-play", {});
    assertEquals(res.status, 404);
  } finally {
    await t.cleanup();
  }
});

// ---- pair notes -----------------------------------------------------------

Deno.test("pair-notes: create + list + track_id filter both directions", async () => {
  const t = await makeTestCtx();
  try {
    const x = seedTrack(t.ctx.db);
    const y = seedTrack(t.ctx.db);
    const z = seedTrack(t.ctx.db);

    const created = await call(t.ctx, "POST", "/api/pair-notes", {
      from_track_id: x,
      to_track_id: y,
      rating: 4,
      transition_type: "blend",
      notes: "worked great",
    });
    assertEquals(created.status, 200);
    assertEquals(created.body.from_track_id, x);
    assertEquals(created.body.to_track_id, y);
    assertEquals(created.body.rating, 4);
    assert(typeof created.body.id === "number");
    assert(typeof created.body.created_at === "string");

    await call(t.ctx, "POST", "/api/pair-notes", { from_track_id: z, to_track_id: x, rating: 5 });

    const all = await call(t.ctx, "GET", "/api/pair-notes");
    assertEquals(all.body.length, 2);

    // x appears as `from` in note 1 and `to` in note 2 — filter must match both.
    const filteredX = await call(t.ctx, "GET", `/api/pair-notes?track_id=${x}`);
    assertEquals(filteredX.body.length, 2);

    const filteredY = await call(t.ctx, "GET", `/api/pair-notes?track_id=${y}`);
    assertEquals(filteredY.body.length, 1);
    assertEquals(filteredY.body[0].to_track_id, y);
  } finally {
    await t.cleanup();
  }
});
