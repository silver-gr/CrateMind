// Export API route tests — dispatch()'d against this task's own route array
// only (never router.ts, per plan's Wave-2 test isolation rule).

import { assert, assertEquals } from "@std/assert";
import { dispatch } from "../src/api/dispatch.ts";
import { routes as exportRoutes } from "../src/api/export.ts";
import { makeTestCtx, seedTrack } from "./helpers.ts";
import { nowIso } from "../src/utils/time.ts";
import type { AppContext } from "../src/api/dispatch.ts";

const ROUTES = exportRoutes();

function post(ctx: AppContext, path: string, body: unknown): Promise<Response> {
  return dispatch(
    ROUTES,
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        host: `${ctx.config.host}:${ctx.config.port}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    ctx,
  );
}

function insertSet(ctx: AppContext, overrides: Record<string, unknown> = {}): number {
  const row = {
    title: "Sunrise Set",
    date: null,
    target_duration: null,
    target_bpm_arc: null,
    target_energy_arc: null,
    notes: null,
    created_at: nowIso(),
    ...overrides,
  };
  const columns = Object.keys(row);
  const result = ctx.db
    .prepare(`INSERT INTO sets (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .run(...Object.values(row) as (string | number | null)[]);
  return Number(result.lastInsertRowid);
}

function addSetTrack(ctx: AppContext, setId: number, trackId: number, position: number): void {
  ctx.db
    .prepare("INSERT INTO set_tracks (set_id, position, track_id, note) VALUES (?, ?, ?, ?)")
    .run(setId, position, trackId, null);
}

// ---- set_id resolution + golden content --------------------------------

Deno.test("POST /m3u writes golden content for set_id tracks into exportsDir", async () => {
  const t = await makeTestCtx();
  try {
    const id1 = seedTrack(t.ctx.db, { artist: "Astrix", title: "Deep Jungle Walk", duration: 420 });
    const id2 = seedTrack(t.ctx.db, { artist: "Mandragora", title: "X", duration: 380 });
    const setId = insertSet(t.ctx);
    addSetTrack(t.ctx, setId, id2, 1);
    addSetTrack(t.ctx, setId, id1, 2);

    const res = await post(t.ctx, "/api/export/m3u", { set_id: setId });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.count, 2);
    assertEquals(body.path, `${t.ctx.config.exportsDir}/cratemind.m3u8`);

    const text = await Deno.readTextFile(body.path);
    assert(text.startsWith("#EXTM3U"));
    // order follows set position: id2 (Mandragora) before id1 (Astrix)
    const iMandragora = text.indexOf("Mandragora");
    const iAstrix = text.indexOf("Astrix");
    assert(iMandragora < iAstrix && iMandragora !== -1);
  } finally {
    await t.cleanup();
  }
});

Deno.test("POST /csv respects track_ids order (not insertion order)", async () => {
  const t = await makeTestCtx();
  try {
    const id1 = seedTrack(t.ctx.db, { artist: "First", title: "A" });
    const id2 = seedTrack(t.ctx.db, { artist: "Second", title: "B" });

    const res = await post(t.ctx, "/api/export/csv", { track_ids: [id2, id1], filename: "order.csv" });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.count, 2);

    const text = await Deno.readTextFile(body.path);
    const lines = text.trim().split("\r\n");
    // row 1 (after header) is id2 ("Second"), row 2 is id1 ("First")
    assert(lines[1].includes("Second"));
    assert(lines[2].includes("First"));
  } finally {
    await t.cleanup();
  }
});

// ---- empty tracks / markdown-without-set --------------------------------

Deno.test("POST /m3u with no resolvable tracks returns 400", async () => {
  const t = await makeTestCtx();
  try {
    const res = await post(t.ctx, "/api/export/m3u", {});
    assertEquals(res.status, 400);
    assertEquals((await res.json()).detail, "no tracks to export");
  } finally {
    await t.cleanup();
  }
});

Deno.test("POST /csv with empty track_ids array returns 400", async () => {
  const t = await makeTestCtx();
  try {
    const res = await post(t.ctx, "/api/export/csv", { track_ids: [] });
    assertEquals(res.status, 400);
    assertEquals((await res.json()).detail, "no tracks to export");
  } finally {
    await t.cleanup();
  }
});

Deno.test("POST /markdown without set_id returns 400", async () => {
  const t = await makeTestCtx();
  try {
    const res = await post(t.ctx, "/api/export/markdown", { track_ids: [1] });
    assertEquals(res.status, 400);
    assertEquals((await res.json()).detail, "markdown export requires set_id");
  } finally {
    await t.cleanup();
  }
});

Deno.test("POST /markdown with unknown set_id returns 404", async () => {
  const t = await makeTestCtx();
  try {
    const res = await post(t.ctx, "/api/export/markdown", { set_id: 999999 });
    assertEquals(res.status, 404);
  } finally {
    await t.cleanup();
  }
});

Deno.test("POST /markdown allows zero tracks (no empty-tracks guard for markdown)", async () => {
  const t = await makeTestCtx();
  try {
    const setId = insertSet(t.ctx, { title: "Empty Set" });
    const res = await post(t.ctx, "/api/export/markdown", { set_id: setId });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.count, 0);
  } finally {
    await t.cleanup();
  }
});

// ---- filename sanitization ----------------------------------------------

const ESCAPE_ATTEMPTS = ["../x", "/tmp/x", "a/b", "..\\x"];

for (const filename of ESCAPE_ATTEMPTS) {
  Deno.test(`POST /m3u rejects escaping filename "${filename}" (400, nothing written outside exportsDir)`, async () => {
    const t = await makeTestCtx();
    try {
      const id = seedTrack(t.ctx.db);
      const res = await post(t.ctx, "/api/export/m3u", { track_ids: [id], filename });
      assertEquals(res.status, 400);
      assert(typeof (await res.json()).detail === "string");

      // Nothing escaped exportsDir: the dangerous path must not exist.
      const escapedCandidates = ["/tmp/x", `${t.dir}/x`, `${t.dir}/a/b`];
      for (const candidate of escapedCandidates) {
        let exists = true;
        try {
          await Deno.stat(candidate);
        } catch {
          exists = false;
        }
        assert(!exists, `must not have written ${candidate}`);
      }
    } finally {
      await t.cleanup();
    }
  });
}

Deno.test("POST /json-backup rejects escaping filename too (mandatory for all formats)", async () => {
  const t = await makeTestCtx();
  try {
    const res = await post(t.ctx, "/api/export/json-backup", { filename: "../escape.json" });
    assertEquals(res.status, 400);
  } finally {
    await t.cleanup();
  }
});

// ---- conflict handling ----------------------------------------------------

Deno.test("POST /m3u returns 409 on existing file without overwrite", async () => {
  const t = await makeTestCtx();
  try {
    const id = seedTrack(t.ctx.db);
    const first = await post(t.ctx, "/api/export/m3u", { track_ids: [id], filename: "dup.m3u8" });
    assertEquals(first.status, 200);

    const second = await post(t.ctx, "/api/export/m3u", { track_ids: [id], filename: "dup.m3u8" });
    assertEquals(second.status, 409);
    assert(typeof (await second.json()).detail === "string");

    const third = await post(t.ctx, "/api/export/m3u", {
      track_ids: [id],
      filename: "dup.m3u8",
      overwrite: true,
    });
    assertEquals(third.status, 200);
  } finally {
    await t.cleanup();
  }
});

// ---- json-backup: always overwrites, {path}-only response ----------------

Deno.test("POST /json-backup always overwrites and responds {path} only (no count)", async () => {
  const t = await makeTestCtx();
  try {
    seedTrack(t.ctx.db);

    const first = await post(t.ctx, "/api/export/json-backup", {});
    assertEquals(first.status, 200);
    const firstBody = await first.json();
    assertEquals(Object.keys(firstBody).sort(), ["path"]);
    assertEquals(firstBody.path, `${t.ctx.config.exportsDir}/cratemind-backup.json`);

    // No overwrite flag sent at all — json-backup ignores it and always
    // overwrites without a 409, unlike the other three formats.
    const second = await post(t.ctx, "/api/export/json-backup", {});
    assertEquals(second.status, 200);
    const secondBody = await second.json();
    assertEquals(Object.keys(secondBody).sort(), ["path"]);

    const payload = JSON.parse(await Deno.readTextFile(secondBody.path));
    assertEquals(payload.tracks.length, 1);
  } finally {
    await t.cleanup();
  }
});

Deno.test("csv export with empty request exports the whole non-missing library (dashboard Export)", async () => {
  const t = await makeTestCtx();
  try {
    seedTrack(t.ctx.db, { absolute_path: "/lib/a.mp3", artist: "A", title: "One" });
    seedTrack(t.ctx.db, { absolute_path: "/lib/b.mp3", artist: "B", title: "Two" });
    const missingId = seedTrack(t.ctx.db, { absolute_path: "/lib/gone.mp3", artist: "C", title: "Gone" });
    t.ctx.db.prepare("UPDATE tracks SET missing = 1 WHERE id = ?").run(missingId);

    const res = await post(t.ctx, "/api/export/csv", {});
    assertEquals(res.status, 200);
    const body = await res.json() as { path: string; count: number };
    assertEquals(body.count, 2);
    const content = Deno.readTextFileSync(body.path);
    assert(content.includes("One") && content.includes("Two"));
    assert(!content.includes("Gone"));
  } finally {
    await t.cleanup();
  }
});
