import { assert, assertEquals, assertRejects } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { backupOnLaunch, initDb, openDb, withTx } from "../src/db/database.ts";
import { bindable, HttpError, readJson, toBools } from "../src/utils/http.ts";
import { dispatch } from "../src/api/dispatch.ts";
import type { RouteDef } from "../src/api/dispatch.ts";
import { MIGRATIONS, runMigrations } from "../src/db/migrations.ts";
import type { Migration } from "../src/db/migrations.ts";
import { shouldFallbackToIndex } from "../src/spa.ts";
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

Deno.test("toBools converts 0/1 columns to real booleans, leaves null untouched", () => {
  const row = { id: 1, missing: 1 as const, human_confirmed: 0 as const, notes: null as string | null };
  const converted = toBools(row, ["missing", "human_confirmed", "notes"]);
  // toBools's declared return type is T (row shape unchanged) even though the
  // converted values are real booleans at runtime — cast through unknown to
  // assert on the actual runtime value.
  assertEquals(converted.missing as unknown, true);
  assertEquals(converted.human_confirmed as unknown, false);
  assertEquals(converted.notes, null);
  assertEquals(row.missing, 1); // does not mutate the original row
});

Deno.test("withTx commits on success and rolls back on throw", async () => {
  const t = await makeTestCtx();
  try {
    t.ctx.db.exec("CREATE TABLE tx_test (id INTEGER PRIMARY KEY, val TEXT)");

    withTx(t.ctx.db, () => {
      t.ctx.db.prepare("INSERT INTO tx_test (val) VALUES (?)").run("committed");
    });
    assertEquals(t.ctx.db.prepare("SELECT val FROM tx_test").all().length, 1);

    let threw = false;
    try {
      withTx(t.ctx.db, () => {
        t.ctx.db.prepare("INSERT INTO tx_test (val) VALUES (?)").run("rolled-back");
        throw new Error("boom");
      });
    } catch {
      threw = true;
    }
    assert(threw);
    // still just the one committed row — the second insert was rolled back
    assertEquals(t.ctx.db.prepare("SELECT val FROM tx_test").all().length, 1);
  } finally {
    await t.cleanup();
  }
});

Deno.test("dispatch() returns 405 when path matches but method doesn't", async () => {
  const t = await makeTestCtx();
  try {
    const testRoutes: RouteDef[] = [
      {
        method: "GET",
        pattern: new URLPattern({ pathname: "/api/_test/:id" }),
        handler: () => new Response("ok"),
      },
    ];
    const res = await dispatch(
      testRoutes,
      new Request("http://localhost/api/_test/42", {
        method: "DELETE",
        headers: {
          host: `${t.ctx.config.host}:${t.ctx.config.port}`,
          "content-type": "application/json",
        },
      }),
      t.ctx,
    );
    assertEquals(res.status, 405);
    const body = await res.json();
    assertEquals(body, { detail: "Method not allowed" });
  } finally {
    await t.cleanup();
  }
});

Deno.test("dispatch() rejects body-less mutating requests without JSON content-type (415)", async () => {
  const t = await makeTestCtx();
  try {
    let handlerRan = false;
    const testRoutes: RouteDef[] = [
      {
        method: "POST",
        pattern: new URLPattern({ pathname: "/api/_test/fingerprint" }),
        handler: () => {
          handlerRan = true;
          return new Response("ok");
        },
      },
    ];
    const res = await dispatch(
      testRoutes,
      new Request("http://localhost/api/_test/fingerprint", {
        method: "POST",
        headers: { host: `${t.ctx.config.host}:${t.ctx.config.port}` },
      }),
      t.ctx,
    );
    assertEquals(res.status, 415);
    assertEquals(handlerRan, false); // no side effect ran
    await res.body?.cancel();
  } finally {
    await t.cleanup();
  }
});

Deno.test("dispatch() returns 403 for a mutating request with a wrong Host header", async () => {
  const t = await makeTestCtx();
  try {
    const res = await dispatch(
      [],
      new Request("http://localhost/api/anything", {
        method: "POST",
        headers: { host: "evil.example:1234" },
      }),
      t.ctx,
    );
    assertEquals(res.status, 403);
    const body = await res.json();
    assertEquals(body, { detail: "Forbidden" });
  } finally {
    await t.cleanup();
  }
});

Deno.test("dispatch() returns 403 for a mutating request with no Host header", async () => {
  const t = await makeTestCtx();
  try {
    const res = await dispatch(
      [],
      new Request("http://localhost/api/anything", { method: "POST" }),
      t.ctx,
    );
    assertEquals(res.status, 403);
  } finally {
    await t.cleanup();
  }
});

Deno.test("runMigrations applies pending migrations in order and records each version", async () => {
  const t = await makeTestCtx(); // already at version 1 via initDb()
  try {
    const dummyV2: Migration = {
      version: 2,
      apply: (db) => {
        db.exec("CREATE TABLE __migration_test_marker (id INTEGER PRIMARY KEY)");
      },
    };
    runMigrations(t.ctx.db, [...MIGRATIONS, dummyV2]);

    const rows = t.ctx.db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as { version: number }[];
    assertEquals(rows.map((r) => r.version), [1, 2]);

    const markerExists = t.ctx.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__migration_test_marker'")
      .all();
    assertEquals(markerExists.length, 1);

    // re-running is a no-op: no duplicate rows, no error
    runMigrations(t.ctx.db, [...MIGRATIONS, dummyV2]);
    const rowsAfter = t.ctx.db.prepare("SELECT version FROM schema_migrations").all();
    assertEquals(rowsAfter.length, 2);
  } finally {
    await t.cleanup();
  }
});

Deno.test("backupOnLaunch snapshot (VACUUM INTO) is a valid, restorable db copy", async () => {
  const t = await makeTestCtx();
  try {
    const id = seedTrack(t.ctx.db, { artist: "Snapshot Artist", title: "Snapshot Track" });
    const dest = backupOnLaunch(t.ctx.config.dbFile, t.ctx.config.backupDir, 5);
    assert(dest !== null);

    const snapshot = new DatabaseSync(dest, { readOnly: true });
    try {
      const row = snapshot.prepare("SELECT artist, title FROM tracks WHERE id = ?").get(id) as
        | { artist: string; title: string }
        | undefined;
      assert(row !== undefined);
      assertEquals(row.artist, "Snapshot Artist");
      assertEquals(row.title, "Snapshot Track");
    } finally {
      snapshot.close();
    }
  } finally {
    await t.cleanup();
  }
});

Deno.test("readJson throws 415 when Content-Type is not application/json", async () => {
  const req = new Request("http://localhost/api/x", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "hello",
  });
  await assertRejects(() => readJson(req), HttpError, "Content-Type must be application/json");
});

Deno.test("shouldFallbackToIndex only falls back for GET/HEAD extensionless paths", () => {
  assertEquals(shouldFallbackToIndex("GET", "/library"), true);
  assertEquals(shouldFallbackToIndex("HEAD", "/sets/42"), true);
  assertEquals(shouldFallbackToIndex("GET", "/assets/app.abc123.js"), false);
  assertEquals(shouldFallbackToIndex("POST", "/library"), false);
  assertEquals(shouldFallbackToIndex("DELETE", "/library"), false);
});

Deno.test("loadConfig falls back to dataDir/config.json for library roots when env is unset", async () => {
  const { loadConfig } = await import("../src/services/config.ts");
  const dir = await Deno.makeTempDir();
  const savedRoots = Deno.env.get("CRATEMIND_LIBRARY_ROOTS");
  const savedData = Deno.env.get("CRATEMIND_DATA_DIR");
  try {
    Deno.env.delete("CRATEMIND_LIBRARY_ROOTS");
    Deno.env.set("CRATEMIND_DATA_DIR", dir);

    // First run: no config.json -> template created, roots empty.
    let cfg = loadConfig();
    assertEquals(cfg.libraryRoots, []);
    assert(Deno.statSync(`${dir}/config.json`).isFile);

    // Roots from file are used.
    Deno.writeTextFileSync(
      `${dir}/config.json`,
      JSON.stringify({ library_roots: ["/music/root-a", "/music/root-b"] }),
    );
    cfg = loadConfig();
    assertEquals(cfg.libraryRoots, ["/music/root-a", "/music/root-b"]);

    // Env still wins over the file.
    Deno.env.set("CRATEMIND_LIBRARY_ROOTS", "/env/root");
    cfg = loadConfig();
    assertEquals(cfg.libraryRoots, ["/env/root"]);
  } finally {
    if (savedRoots === undefined) Deno.env.delete("CRATEMIND_LIBRARY_ROOTS");
    else Deno.env.set("CRATEMIND_LIBRARY_ROOTS", savedRoots);
    if (savedData === undefined) Deno.env.delete("CRATEMIND_DATA_DIR");
    else Deno.env.set("CRATEMIND_DATA_DIR", savedData);
    await Deno.remove(dir, { recursive: true });
  }
});
