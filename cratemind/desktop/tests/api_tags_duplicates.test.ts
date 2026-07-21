import { assertEquals, assertExists } from "@std/assert";
import type { DatabaseSync } from "node:sqlite";
import { dispatch } from "../src/api/dispatch.ts";
import { routes as tagsRoutes } from "../src/api/tags.ts";
import { routes as duplicatesRoutes } from "../src/api/duplicates.ts";
import { makeTestCtx, seedTrack } from "./helpers.ts";
import { searchTracks } from "../src/services/searchExecutor.ts";
import { nowIso } from "../src/utils/time.ts";
import type { AppContext } from "../src/api/dispatch.ts";

// T9 owns both tags.ts and duplicates.ts — combine both route arrays into a
// single dispatch call, per plan's Wave 2 test-isolation note.
function ownRoutes() {
  return [...tagsRoutes(), ...duplicatesRoutes()];
}

function mutHeaders(ctx: AppContext): HeadersInit {
  return {
    host: `${ctx.config.host}:${ctx.config.port}`,
    "content-type": "application/json",
  };
}

async function req(
  ctx: AppContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const init: RequestInit = { method };
  if (method !== "GET" && method !== "DELETE") {
    init.headers = mutHeaders(ctx);
    init.body = JSON.stringify(body ?? {});
  } else if (method === "DELETE") {
    init.headers = mutHeaders(ctx);
  }
  return await dispatch(ownRoutes(), new Request(`http://localhost${path}`, init), ctx);
}

function insertDuplicateGroup(
  db: DatabaseSync,
  reason: string | null,
  status = "needs_review",
): number {
  const result = db
    .prepare("INSERT INTO duplicate_groups (reason, status, created_at) VALUES (?, ?, ?)")
    .run(reason, status, nowIso());
  return Number(result.lastInsertRowid);
}

function linkDuplicate(db: DatabaseSync, groupId: number, trackId: number, role: string | null = null) {
  db.prepare("INSERT INTO duplicate_group_tracks (group_id, track_id, role) VALUES (?, ?, ?)").run(
    groupId,
    trackId,
    role,
  );
}

// ---- tags --------------------------------------------------------------

Deno.test("POST /api/tags creates a tag once, reuses it on repeat create", async () => {
  const t = await makeTestCtx();
  try {
    const res1 = await req(t.ctx, "POST", "/api/tags", { name: "peak" });
    assertEquals(res1.status, 200);
    const tag1 = await res1.json();
    assertEquals(tag1.name, "peak");
    assertExists(tag1.id);

    const res2 = await req(t.ctx, "POST", "/api/tags", { name: "peak" });
    assertEquals(res2.status, 200);
    const tag2 = await res2.json();
    assertEquals(tag2.id, tag1.id); // same tag, not a duplicate

    const count = t.ctx.db.prepare("SELECT COUNT(*) c FROM tags").get() as { c: number };
    assertEquals(count.c, 1);
  } finally {
    await t.cleanup();
  }
});

Deno.test("GET /api/tags returns tags ordered by name, verbatim shape", async () => {
  const t = await makeTestCtx();
  try {
    await req(t.ctx, "POST", "/api/tags", { name: "warmup" });
    await req(t.ctx, "POST", "/api/tags", { name: "closer", category: "role" });

    const res = await req(t.ctx, "GET", "/api/tags");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.length, 2);
    assertEquals(body[0].name, "closer"); // alphabetical
    assertEquals(Object.keys(body[0]).sort(), ["category", "id", "name"]);
    assertEquals(body[0].category, "role");
    assertEquals(body[1].category, null);
  } finally {
    await t.cleanup();
  }
});

Deno.test("POST /api/tracks/:id/tags assign-by-name creates once, reuses on second assign", async () => {
  const t = await makeTestCtx();
  try {
    const trackId = seedTrack(t.ctx.db);

    const res1 = await req(t.ctx, "POST", `/api/tracks/${trackId}/tags`, { name: "banger" });
    assertEquals(res1.status, 200);
    const body1 = await res1.json();
    assertEquals(body1, { track_id: trackId, tag_id: body1.tag_id, name: "banger" });

    // second track picks up the SAME tag by name — no duplicate tag row
    const trackId2 = seedTrack(t.ctx.db);
    const res2 = await req(t.ctx, "POST", `/api/tracks/${trackId2}/tags`, { name: "banger" });
    const body2 = await res2.json();
    assertEquals(body2.tag_id, body1.tag_id);

    // re-assigning the same tag to the same track is idempotent (no dup link row)
    const res3 = await req(t.ctx, "POST", `/api/tracks/${trackId}/tags`, { name: "banger" });
    assertEquals(res3.status, 200);

    const linkCount = t.ctx.db
      .prepare("SELECT COUNT(*) c FROM track_tags WHERE track_id = ? AND tag_id = ?")
      .get(trackId, body1.tag_id) as { c: number };
    assertEquals(linkCount.c, 1);

    const tagCount = t.ctx.db.prepare("SELECT COUNT(*) c FROM tags").get() as { c: number };
    assertEquals(tagCount.c, 1);
  } finally {
    await t.cleanup();
  }
});

Deno.test("POST /api/tracks/:id/tags 404s for unknown track, 400 without tag_id or name", async () => {
  const t = await makeTestCtx();
  try {
    const res404 = await req(t.ctx, "POST", "/api/tracks/999999/tags", { name: "x" });
    assertEquals(res404.status, 404);
    assertEquals(await res404.json(), { detail: "track not found" });

    const trackId = seedTrack(t.ctx.db);
    const res400 = await req(t.ctx, "POST", `/api/tracks/${trackId}/tags`, {});
    assertEquals(res400.status, 400);
  } finally {
    await t.cleanup();
  }
});

Deno.test("tag assign makes track FTS-searchable by tag name; remove stops it", async () => {
  const t = await makeTestCtx();
  try {
    const trackId = seedTrack(t.ctx.db, { artist: "Nobody Special", title: "Untagged Jam" });

    // not findable by the tag term before assignment
    const before = searchTracks(t.ctx.db, "psytrance");
    assertEquals(before.some((r) => r.id === trackId), false);

    const assignRes = await req(t.ctx, "POST", `/api/tracks/${trackId}/tags`, {
      name: "psytrance",
    });
    const { tag_id } = await assignRes.json();

    const after = searchTracks(t.ctx.db, "psytrance");
    assertEquals(after.some((r) => r.id === trackId), true);

    const removeRes = await req(t.ctx, "DELETE", `/api/tracks/${trackId}/tags/${tag_id}`);
    assertEquals(removeRes.status, 200);
    assertEquals(await removeRes.json(), { removed: true });

    const afterRemove = searchTracks(t.ctx.db, "psytrance");
    assertEquals(afterRemove.some((r) => r.id === trackId), false);
  } finally {
    await t.cleanup();
  }
});

Deno.test("DELETE /api/tracks/:id/tags/:tagId 404s on missing assignment", async () => {
  const t = await makeTestCtx();
  try {
    const trackId = seedTrack(t.ctx.db);
    const res = await req(t.ctx, "DELETE", `/api/tracks/${trackId}/tags/999999`);
    assertEquals(res.status, 404);
    assertEquals(await res.json(), { detail: "assignment not found" });
  } finally {
    await t.cleanup();
  }
});

// ---- duplicates ----------------------------------------------------------

Deno.test("GET /api/duplicates filters by status (default needs_review) and serializes members", async () => {
  const t = await makeTestCtx();
  try {
    const a = seedTrack(t.ctx.db, {
      artist: "A",
      title: "Copy A",
      duration: 300,
      bpm: 128,
      extension: "mp3",
    });
    const b = seedTrack(t.ctx.db, {
      artist: "A",
      title: "Copy B",
      duration: 301,
      bpm: 128,
      extension: "flac",
    });
    const groupPending = insertDuplicateGroup(t.ctx.db, "hash match", "needs_review");
    linkDuplicate(t.ctx.db, groupPending, a, null);
    linkDuplicate(t.ctx.db, groupPending, b, null);

    const groupResolved = insertDuplicateGroup(t.ctx.db, "fingerprint match", "resolved");
    linkDuplicate(t.ctx.db, groupResolved, a, "master");

    const defaultRes = await req(t.ctx, "GET", "/api/duplicates");
    const defaultBody = await defaultRes.json();
    assertEquals(defaultBody.length, 1);
    assertEquals(defaultBody[0].id, groupPending);
    assertEquals(defaultBody[0].reason, "hash match");
    assertEquals(defaultBody[0].status, "needs_review");
    assertEquals(defaultBody[0].tracks.length, 2);
    assertEquals(defaultBody[0].tracks[0], {
      track_id: a,
      role: null,
      artist: "A",
      title: "Copy A",
      duration: 300,
      bpm: 128,
      extension: "mp3",
      absolute_path: (t.ctx.db.prepare("SELECT absolute_path FROM tracks WHERE id = ?").get(a) as {
        absolute_path: string;
      }).absolute_path,
    });

    const resolvedRes = await req(t.ctx, "GET", "/api/duplicates?status=resolved");
    const resolvedBody = await resolvedRes.json();
    assertEquals(resolvedBody.length, 1);
    assertEquals(resolvedBody[0].id, groupResolved);
    assertEquals(resolvedBody[0].tracks[0].role, "master");
  } finally {
    await t.cleanup();
  }
});

Deno.test("GET /api/duplicates skips a group member whose track row vanished", async () => {
  const t = await makeTestCtx();
  try {
    const a = seedTrack(t.ctx.db);
    const b = seedTrack(t.ctx.db);
    const group = insertDuplicateGroup(t.ctx.db, "dup", "needs_review");
    linkDuplicate(t.ctx.db, group, a);
    linkDuplicate(t.ctx.db, group, b);

    // simulate a vanished track row (foreign-key checked, so drop the link too
    // is not what Python does — Python just skips a None session.get(); here
    // we delete the track row directly, which is possible because FK
    // enforcement in this DB doesn't cascade-delete duplicate_group_tracks).
    t.ctx.db.exec("PRAGMA foreign_keys = OFF;");
    t.ctx.db.prepare("DELETE FROM tracks WHERE id = ?").run(b);
    t.ctx.db.exec("PRAGMA foreign_keys = ON;");

    const res = await req(t.ctx, "GET", "/api/duplicates");
    const body = await res.json();
    assertEquals(body[0].tracks.length, 1);
    assertEquals(body[0].tracks[0].track_id, a);
  } finally {
    await t.cleanup();
  }
});

Deno.test("POST /api/duplicates/:groupId/resolve updates roles (string-keyed body) and status, touches no files", async () => {
  const t = await makeTestCtx();
  try {
    const a = seedTrack(t.ctx.db, { absolute_path: "/music/a.mp3" });
    const b = seedTrack(t.ctx.db, { absolute_path: "/music/b.mp3" });
    const group = insertDuplicateGroup(t.ctx.db, "dup", "needs_review");
    linkDuplicate(t.ctx.db, group, a);
    linkDuplicate(t.ctx.db, group, b);

    // roles keys arrive over the wire as JSON object keys, i.e. strings —
    // exercise that exact shape instead of a numeric-keyed object.
    const rolesBody = JSON.parse(`{"${a}": "master", "${b}": "duplicate"}`);
    const res = await req(t.ctx, "POST", `/api/duplicates/${group}/resolve`, {
      status: "resolved",
      roles: rolesBody,
    });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { id: group, status: "resolved" });

    const groupRow = t.ctx.db.prepare("SELECT status FROM duplicate_groups WHERE id = ?").get(
      group,
    ) as { status: string };
    assertEquals(groupRow.status, "resolved");

    const roleA = t.ctx.db
      .prepare("SELECT role FROM duplicate_group_tracks WHERE group_id = ? AND track_id = ?")
      .get(group, a) as { role: string };
    const roleB = t.ctx.db
      .prepare("SELECT role FROM duplicate_group_tracks WHERE group_id = ? AND track_id = ?")
      .get(group, b) as { role: string };
    assertEquals(roleA.role, "master");
    assertEquals(roleB.role, "duplicate");

    // data-safety: source file paths in the DB are unchanged, and resolve
    // never touches the filesystem at all — nothing to assert beyond "the
    // handler made no Deno.* fs calls", which is true by construction (no
    // fs import in duplicates.ts). Confirm DB paths are untouched as a proxy.
    const pathA = t.ctx.db.prepare("SELECT absolute_path FROM tracks WHERE id = ?").get(a) as {
      absolute_path: string;
    };
    assertEquals(pathA.absolute_path, "/music/a.mp3");
  } finally {
    await t.cleanup();
  }
});

Deno.test("resolve() defaults status to resolved and roles to {} when omitted; master_track_id sets master", async () => {
  const t = await makeTestCtx();
  try {
    const a = seedTrack(t.ctx.db);
    const b = seedTrack(t.ctx.db);
    const group = insertDuplicateGroup(t.ctx.db, "dup", "needs_review");
    linkDuplicate(t.ctx.db, group, a);
    linkDuplicate(t.ctx.db, group, b);

    const res = await req(t.ctx, "POST", `/api/duplicates/${group}/resolve`, {
      master_track_id: a,
    });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { id: group, status: "resolved" });

    const roleA = t.ctx.db
      .prepare("SELECT role FROM duplicate_group_tracks WHERE group_id = ? AND track_id = ?")
      .get(group, a) as { role: string };
    assertEquals(roleA.role, "master");

    const roleB = t.ctx.db
      .prepare("SELECT role FROM duplicate_group_tracks WHERE group_id = ? AND track_id = ?")
      .get(group, b) as { role: string | null };
    assertEquals(roleB.role, null); // untouched — not master, not in roles
  } finally {
    await t.cleanup();
  }
});

Deno.test("POST /api/duplicates/:groupId/resolve 404s for unknown group", async () => {
  const t = await makeTestCtx();
  try {
    const res = await req(t.ctx, "POST", "/api/duplicates/999999/resolve", {});
    assertEquals(res.status, 404);
    assertEquals(await res.json(), { detail: "group not found" });
  } finally {
    await t.cleanup();
  }
});
