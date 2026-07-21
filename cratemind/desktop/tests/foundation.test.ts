import { assert, assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { backupOnLaunch, initDb, openDb } from "../src/db/database.ts";
import { bindable } from "../src/utils/http.ts";
import { dispatch } from "../src/api/router.ts";
import type { RouteDef } from "../src/api/router.ts";
import { makeTestCtx, seedTrack } from "./helpers.ts";

const EXPECTED_TABLES = [
  "tracks",
  "artist_profiles",
  "track_dj_profile",
  "tags",
  "track_tags",
  "fingerprints",
  "duplicate_groups",
  "duplicate_group_tracks",
  "sets",
  "set_tracks",
  "track_pair_notes",
  "play_events",
  "audit_log",
  "jobs",
  "saved_searches",
];

Deno.test("initDb is idempotent", async () => {
  const t = await makeTestCtx();
  try {
    initDb(t.ctx.db); // second call must not throw
    const row = t.ctx.db
      .prepare("SELECT version FROM schema_migrations WHERE version = 1")
      .get();
    assert(row !== undefined);
  } finally {
    await t.cleanup();
  }
});

Deno.test("schema creates all 15 tables + track_search + schema_migrations", async () => {
  const t = await makeTestCtx();
  try {
    const rows = t.ctx.db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table')")
      .all() as { name: string }[];
    const names = new Set(rows.map((r) => r.name));

    for (const table of EXPECTED_TABLES) {
      assert(names.has(table), `missing table: ${table}`);
    }
    assert(names.has("schema_migrations"), "missing schema_migrations");

    const ftsRows = t.ctx.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'track_search'")
      .all();
    assertEquals(ftsRows.length, 1);
  } finally {
    await t.cleanup();
  }
});

Deno.test("FTS5 probe passes on a fresh db", async () => {
  const t = await makeTestCtx();
  try {
    t.ctx.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS __probe USING fts5(x)");
    t.ctx.db.exec("INSERT INTO __probe (rowid, x) VALUES (1, 'hello world')");
    const rows = t.ctx.db
      .prepare("SELECT rowid FROM __probe WHERE __probe MATCH 'hello'")
      .all();
    assertEquals(rows.length, 1);
    t.ctx.db.exec("DROP TABLE __probe");
  } finally {
    await t.cleanup();
  }
});

Deno.test("reindexTrack makes a seeded track findable via FTS", async () => {
  const t = await makeTestCtx();
  try {
    const id = seedTrack(t.ctx.db, { artist: "Boards Of Canada", title: "Roygbiv" });
    const rows = t.ctx.db
      .prepare("SELECT rowid FROM track_search WHERE track_search MATCH ?")
      .all("Roygbiv") as { rowid: number }[];
    assertEquals(rows.length, 1);
    assertEquals(rows[0].rowid, id);
  } finally {
    await t.cleanup();
  }
});

Deno.test("bindable() converts booleans and undefined", () => {
  assertEquals(bindable(true), 1);
  assertEquals(bindable(false), 0);
  assertEquals(bindable(undefined), null);
  assertEquals(bindable(null), null);
  assertEquals(bindable("x"), "x");
  assertEquals(bindable(42), 42);
});

Deno.test("backupOnLaunch creates a snapshot and prunes to keep", async () => {
  const t = await makeTestCtx();
  try {
    seedTrack(t.ctx.db);

    const backups: (string | null)[] = [];
    for (let i = 0; i < 3; i++) {
      const dest = backupOnLaunch(t.ctx.config.dbFile, t.ctx.config.backupDir, 2);
      backups.push(dest);
      // ensure distinct filesystem-mtime-based ordering between iterations
      await new Promise((r) => setTimeout(r, 1100));
    }

    assert(backups.every((b) => b !== null));

    const entries: string[] = [];
    for (const entry of Deno.readDirSync(t.ctx.config.backupDir)) {
      if (entry.isFile) entries.push(entry.name);
    }
    assertEquals(entries.length, 2);
  } finally {
    await t.cleanup();
  }
});

Deno.test("backupOnLaunch returns null when db is absent", async () => {
  const dir = await Deno.makeTempDir({ prefix: "cratemind-test-" });
  try {
    const dest = backupOnLaunch(`${dir}/missing.sqlite`, dir, 5);
    assertEquals(dest, null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("dispatch() returns 404 {detail} for an unmatched route", async () => {
  const t = await makeTestCtx();
  try {
    const res = await dispatch([], new Request("http://localhost/api/x"), t.ctx);
    assertEquals(res.status, 404);
    const body = await res.json();
    assertEquals(body, { detail: "Not found" });
  } finally {
    await t.cleanup();
  }
});

Deno.test("dispatch() invokes a matching registered route", async () => {
  const t = await makeTestCtx();
  try {
    const testRoutes: RouteDef[] = [
      {
        method: "GET",
        pattern: new URLPattern({ pathname: "/api/_test/:id" }),
        handler: (_req, params) =>
          new Response(JSON.stringify({ id: params.id }), {
            headers: { "content-type": "application/json" },
          }),
      },
    ];
    const res = await dispatch(
      testRoutes,
      new Request("http://localhost/api/_test/42"),
      t.ctx,
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body, { id: "42" });
  } finally {
    await t.cleanup();
  }
});
