// Duplicate review. Never deletes files — records human decisions only.
// Port of backend/app/api/duplicates.py.

import type { DatabaseSync } from "node:sqlite";
import type { RouteDef } from "./dispatch.ts";
import { HttpError, json, readJson } from "../utils/http.ts";
import { withTx } from "../db/database.ts";
import { effectiveBpm } from "../services/tempo.ts";
import type {
  DuplicateGroupRow,
  DuplicateGroupTrackRow,
  DuplicateResolve,
  Track,
} from "../types/models.ts";

interface DuplicateMember {
  track_id: number;
  role: string | null;
  artist: string | null;
  title: string | null;
  duration: number | null;
  bpm: number | null;
  extension: string;
  absolute_path: string;
}

function listDuplicates(
  req: Request,
  _params: Record<string, string | undefined>,
  ctx: { db: DatabaseSync },
): Response {
  const status = new URL(req.url).searchParams.get("status") ?? "needs_review";

  const groups = ctx.db
    .prepare("SELECT * FROM duplicate_groups WHERE status = ? ORDER BY id DESC")
    .all(status) as unknown as DuplicateGroupRow[];

  const out = groups.map((g) => {
    const links = ctx.db
      .prepare("SELECT * FROM duplicate_group_tracks WHERE group_id = ?")
      .all(g.id) as unknown as DuplicateGroupTrackRow[];

    const members: DuplicateMember[] = [];
    for (const link of links) {
      const tr = ctx.db.prepare("SELECT * FROM tracks WHERE id = ?").get(link.track_id) as
        unknown as
        | Track
        | undefined;
      if (tr === undefined) continue; // vanished track — skip, mirrors Python
      members.push({
        track_id: tr.id,
        role: link.role,
        artist: tr.artist,
        title: tr.title,
        duration: tr.duration,
        bpm: effectiveBpm(tr),
        extension: tr.extension,
        absolute_path: tr.absolute_path,
      });
    }

    return { id: g.id, reason: g.reason, status: g.status, tracks: members };
  });

  return json(out);
}

async function resolve(
  req: Request,
  params: Record<string, string | undefined>,
  ctx: { db: DatabaseSync },
): Promise<Response> {
  const groupId = Number(params.groupId);
  const body = await readJson<DuplicateResolve>(req);
  const status = body.status ?? "resolved";
  const masterTrackId = body.master_track_id ?? null;
  // roles arrives over JSON with string keys regardless of the declared
  // Record<number, string> type (JSON object keys are always strings) —
  // look them up as strings, never with a strict numeric ===.
  const roles = (body.roles ?? {}) as unknown as Record<string, string>;

  const group = ctx.db.prepare("SELECT * FROM duplicate_groups WHERE id = ?").get(groupId) as
    unknown as
    | DuplicateGroupRow
    | undefined;
  if (group === undefined) {
    throw new HttpError(404, "group not found");
  }

  withTx(ctx.db, () => {
    const links = ctx.db
      .prepare("SELECT * FROM duplicate_group_tracks WHERE group_id = ?")
      .all(groupId) as unknown as DuplicateGroupTrackRow[];

    for (const link of links) {
      const key = String(link.track_id);
      let role: string | undefined;
      if (masterTrackId !== null && link.track_id === masterTrackId) {
        role = "master";
      } else if (Object.prototype.hasOwnProperty.call(roles, key)) {
        role = roles[key];
      }
      if (role !== undefined) {
        ctx.db
          .prepare("UPDATE duplicate_group_tracks SET role = ? WHERE group_id = ? AND track_id = ?")
          .run(role, groupId, link.track_id);
      }
    }

    ctx.db.prepare("UPDATE duplicate_groups SET status = ? WHERE id = ?").run(status, groupId);
  });

  return json({ id: groupId, status });
}

export function routes(): RouteDef[] {
  return [
    {
      method: "GET",
      pattern: new URLPattern({ pathname: "/api/duplicates" }),
      handler: listDuplicates,
    },
    {
      method: "POST",
      pattern: new URLPattern({ pathname: "/api/duplicates/:groupId/resolve" }),
      handler: resolve,
    },
  ];
}
