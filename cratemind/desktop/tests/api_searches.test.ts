// Tests for the saved-searches ("Memory Crates") API — desktop/src/api/searches.ts
// — and the seed defaults in desktop/src/db/seed.ts. Uses dispatch() with only
// this task's own route array, per Wave 2 test isolation rules.

import { assert, assertEquals } from "@std/assert";
import { dispatch } from "../src/api/dispatch.ts";
import type { AppContext } from "../src/api/dispatch.ts";
import { routes } from "../src/api/searches.ts";
import { runSeeds } from "../src/db/seed.ts";
import { makeTestCtx, seedProfile, seedTrack } from "./helpers.ts";

const searchRoutes = routes();

/** Dispatches a request against this task's own routes. Mutating methods get
 * the Host + Content-Type headers dispatch() requires before route matching. */
async function call(
  ctx: AppContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const init: RequestInit = { method };
  if (method !== "GET") {
    init.headers = {
      host: `${ctx.config.host}:${ctx.config.port}`,
      "content-type": "application/json",
    };
    if (body !== undefined) init.body = JSON.stringify(body);
  }
  return await dispatch(searchRoutes, new Request(`http://localhost${path}`, init), ctx);
}

Deno.test("saved-searches CRUD lifecycle", async () => {
  const t = await makeTestCtx();
  try {
    const createRes = await call(t.ctx, "POST", "/api/searches", {
      name: "Test Crate",
      query: "status:approved",
    });
    assertEquals(createRes.status, 200);
    const created = await createRes.json();
    assertEquals(created.name, "Test Crate");
    assertEquals(created.query, "status:approved");
    assertEquals(created.pinned, false); // default applied server-side
    assertEquals(created.sort_order, 0);
    assertEquals(created.count, 0); // no tracks yet
    assert(typeof created.id === "number");
    assert(typeof created.created_at === "string");
    assert(typeof created.updated_at === "string");

    const listRes = await call(t.ctx, "GET", "/api/searches");
    assertEquals(listRes.status, 200);
    const list = await listRes.json();
    assertEquals(list.length, 1);
    assertEquals(list[0].id, created.id);

    const patchRes = await call(t.ctx, "PATCH", `/api/searches/${created.id}`, {
      pinned: true,
      sort_order: 5,
    });
    assertEquals(patchRes.status, 200);
    const patched = await patchRes.json();
    assertEquals(patched.pinned, true);
    assertEquals(patched.sort_order, 5);
    assertEquals(patched.name, "Test Crate"); // untouched field survives partial update
    assertEquals(patched.query, "status:approved");
    assert(patched.updated_at >= created.updated_at);

    const deleteRes = await call(t.ctx, "DELETE", `/api/searches/${created.id}`);
    assertEquals(deleteRes.status, 200);
    assertEquals(await deleteRes.json(), { deleted: true }); // Python quirk, preserved

    const listAfter = await call(t.ctx, "GET", "/api/searches");
    assertEquals((await listAfter.json()).length, 0);
  } finally {
    await t.cleanup();
  }
});

Deno.test("saved-searches 404s for an unknown id (PATCH, DELETE, tracks)", async () => {
  const t = await makeTestCtx();
  try {
    const patchRes = await call(t.ctx, "PATCH", "/api/searches/999", { pinned: true });
    assertEquals(patchRes.status, 404);
    assertEquals(await patchRes.json(), { detail: "saved search not found" });

    const deleteRes = await call(t.ctx, "DELETE", "/api/searches/999");
    assertEquals(deleteRes.status, 404);
    assertEquals(await deleteRes.json(), { detail: "saved search not found" });

    const tracksRes = await call(t.ctx, "GET", "/api/searches/999/tracks");
    assertEquals(tracksRes.status, 404);
    assertEquals(await tracksRes.json(), { detail: "saved search not found" });
  } finally {
    await t.cleanup();
  }
});

Deno.test("live count reflects seeded tracks matching the saved query", async () => {
  const t = await makeTestCtx();
  try {
    const matchId = seedTrack(t.ctx.db, { artist: "Match Artist" });
    seedProfile(t.ctx.db, matchId, { personal_status: "approved" });
    const otherId = seedTrack(t.ctx.db, { artist: "Other Artist" });
    seedProfile(t.ctx.db, otherId, { personal_status: "unknown" });

    const createRes = await call(t.ctx, "POST", "/api/searches", {
      name: "Approved Crate",
      query: "status:approved",
    });
    const created = await createRes.json();
    assertEquals(created.count, 1);

    // Count is live — re-running the query after data changes (not the
    // saved-search row) reflects the new match without any write to it.
    seedProfile(t.ctx.db, otherId, { personal_status: "approved" });
    const listRes = await call(t.ctx, "GET", "/api/searches");
    const list = await listRes.json();
    assertEquals(list[0].count, 2);
  } finally {
    await t.cleanup();
  }
});

Deno.test("GET /:id/tracks returns plain Track rows with real booleans, no list enrichment", async () => {
  const t = await makeTestCtx();
  try {
    const id = seedTrack(t.ctx.db, { artist: "Plain Artist", missing: 1 });
    seedProfile(t.ctx.db, id, { personal_status: "approved", energy: 8 });

    const createRes = await call(t.ctx, "POST", "/api/searches", {
      name: "Plain Crate",
      query: "status:approved",
    });
    const created = await createRes.json();

    const tracksRes = await call(t.ctx, "GET", `/api/searches/${created.id}/tracks`);
    assertEquals(tracksRes.status, 200);
    const tracks = await tracksRes.json();
    assertEquals(tracks.length, 1);
    const row = tracks[0];
    assertEquals(row.id, id);
    assertEquals(row.artist, "Plain Artist");
    assertEquals(row.missing, true); // toBools: SQLite 1 -> real JSON boolean
    // Plain Track model_dump only — no _list_payload enrichment fields.
    assertEquals("energy" in row, false);
    assertEquals("darkness" in row, false);
    assertEquals("set_role" in row, false);
    assertEquals("artist_prefill" in row, false);
  } finally {
    await t.cleanup();
  }
});

Deno.test("runSeeds is idempotent — defaults inserted once, no duplicates on rerun", async () => {
  const t = await makeTestCtx();
  try {
    const countsByName = () => {
      const rows = t.ctx.db.prepare("SELECT name FROM saved_searches").all() as {
        name: string;
      }[];
      const counts = new Map<string, number>();
      for (const r of rows) counts.set(r.name, (counts.get(r.name) ?? 0) + 1);
      return counts;
    };

    runSeeds(t.ctx);
    const first = countsByName();
    for (
      const name of [
        "Forgotten Approved",
        "Approved Never Played",
        "Long Break Candidates",
        "Peak Bridge Weapons",
        "New Untagged",
      ]
    ) {
      assertEquals(first.get(name), 1, `missing seed: ${name}`);
    }
    const totalFirst = [...first.values()].reduce((a, b) => a + b, 0);
    assertEquals(totalFirst, 5);

    runSeeds(t.ctx);
    const second = countsByName();
    for (const [name, count] of second) {
      assertEquals(count, 1, `duplicate seed row for ${name}`);
    }
    assertEquals([...second.values()].reduce((a, b) => a + b, 0), totalFirst);

    // Seeds are visible and live-counted through the API too.
    const listRes = await call(t.ctx, "GET", "/api/searches");
    const list = await listRes.json();
    assertEquals(list.length, totalFirst);
  } finally {
    await t.cleanup();
  }
});
