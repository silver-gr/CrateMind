// Tag CRUD and track<->tag assignment. Port of backend/app/api/tags.py.

import type { DatabaseSync } from "node:sqlite";
import type { RouteDef } from "./dispatch.ts";
import { HttpError, json, readJson } from "../utils/http.ts";
import { reindexTrack } from "../db/database.ts";
import type { Tag, TagAssign, TagCreate } from "../types/models.ts";

/** Port of tags.py:_get_or_create_tag. */
function getOrCreateTag(db: DatabaseSync, name: string, category: string | null = null): Tag {
  const existing = db.prepare("SELECT * FROM tags WHERE name = ?").get(name) as unknown as Tag | undefined;
  if (existing) return existing;
  const result = db
    .prepare("INSERT INTO tags (name, category) VALUES (?, ?)")
    .run(name, category);
  return { id: Number(result.lastInsertRowid), name, category };
}

function listTags(
  _req: Request,
  _params: Record<string, string | undefined>,
  ctx: { db: DatabaseSync },
): Response {
  const rows = ctx.db.prepare("SELECT * FROM tags ORDER BY name").all() as unknown as Tag[];
  return json(rows);
}

async function createTag(
  req: Request,
  _params: Record<string, string | undefined>,
  ctx: { db: DatabaseSync },
): Promise<Response> {
  const body = await readJson<TagCreate>(req);
  const tag = getOrCreateTag(ctx.db, body.name, body.category ?? null);
  return json(tag);
}

async function assignTag(
  req: Request,
  params: Record<string, string | undefined>,
  ctx: { db: DatabaseSync },
): Promise<Response> {
  const trackId = Number(params.id);
  const track = ctx.db.prepare("SELECT id FROM tracks WHERE id = ?").get(trackId);
  if (track === undefined) {
    throw new HttpError(404, "track not found");
  }

  const body = await readJson<TagAssign>(req);
  let tag: Tag;
  if (body.tag_id != null) {
    const found = ctx.db.prepare("SELECT * FROM tags WHERE id = ?").get(body.tag_id) as unknown as
      | Tag
      | undefined;
    if (found === undefined) {
      throw new HttpError(404, "tag not found");
    }
    tag = found;
  } else if (body.name) {
    tag = getOrCreateTag(ctx.db, body.name);
  } else {
    throw new HttpError(400, "provide tag_id or name");
  }

  const existingLink = ctx.db
    .prepare("SELECT 1 FROM track_tags WHERE track_id = ? AND tag_id = ?")
    .get(trackId, tag.id);
  if (existingLink === undefined) {
    ctx.db
      .prepare("INSERT INTO track_tags (track_id, tag_id) VALUES (?, ?)")
      .run(trackId, tag.id);
  }
  reindexTrack(ctx.db, trackId);

  return json({ track_id: trackId, tag_id: tag.id, name: tag.name });
}

function removeTag(
  _req: Request,
  params: Record<string, string | undefined>,
  ctx: { db: DatabaseSync },
): Response {
  const trackId = Number(params.id);
  const tagId = Number(params.tagId);

  const link = ctx.db
    .prepare("SELECT 1 FROM track_tags WHERE track_id = ? AND tag_id = ?")
    .get(trackId, tagId);
  if (link === undefined) {
    throw new HttpError(404, "assignment not found");
  }

  ctx.db
    .prepare("DELETE FROM track_tags WHERE track_id = ? AND tag_id = ?")
    .run(trackId, tagId);
  reindexTrack(ctx.db, trackId);

  return json({ removed: true });
}

export function routes(): RouteDef[] {
  return [
    { method: "GET", pattern: new URLPattern({ pathname: "/api/tags" }), handler: listTags },
    { method: "POST", pattern: new URLPattern({ pathname: "/api/tags" }), handler: createTag },
    {
      method: "POST",
      pattern: new URLPattern({ pathname: "/api/tracks/:id/tags" }),
      handler: assignTag,
    },
    {
      method: "DELETE",
      pattern: new URLPattern({ pathname: "/api/tracks/:id/tags/:tagId" }),
      handler: removeTag,
    },
  ];
}
