// Saved-searches API — "Memory Crates": named search queries that re-run
// live over the library. Port of backend/app/api/searches.py.

import type { AppContext, RouteDef } from "./dispatch.ts";
import { bindable, HttpError, json, readJson, toBools } from "../utils/http.ts";
import { nowIso } from "../utils/time.ts";
import { countTracks, searchTracks } from "../services/searchExecutor.ts";
import type {
  SavedSearchCreate,
  SavedSearchRow,
  SavedSearchUpdate,
} from "../types/models.ts";

const UPDATABLE_FIELDS: (keyof SavedSearchUpdate)[] = [
  "name",
  "query",
  "description",
  "pinned",
  "sort_order",
];

function getRow(ctx: AppContext, id: number): SavedSearchRow | undefined {
  return ctx.db
    .prepare("SELECT * FROM saved_searches WHERE id = ?")
    .get(id) as unknown as SavedSearchRow | undefined;
}

/** Mirrors searches.py's `_payload`: the row plus a live `count` computed by
 * re-running the saved query against the current library. */
function payload(ctx: AppContext, row: SavedSearchRow): Record<string, unknown> {
  return { ...toBools(row, ["pinned"]), count: countTracks(ctx.db, row.query) };
}

export function routes(): RouteDef[] {
  return [
    {
      method: "GET",
      pattern: new URLPattern({ pathname: "/api/searches" }),
      handler: (_req, _params, ctx) => {
        const rows = ctx.db
          .prepare("SELECT * FROM saved_searches ORDER BY sort_order, name")
          .all() as unknown as SavedSearchRow[];
        return json(rows.map((row) => payload(ctx, row)));
      },
    },
    {
      method: "POST",
      pattern: new URLPattern({ pathname: "/api/searches" }),
      handler: async (req, _params, ctx) => {
        const body = await readJson<SavedSearchCreate>(req);
        const now = nowIso();
        const result = ctx.db
          .prepare(
            `INSERT INTO saved_searches (name, query, description, pinned, sort_order, created_at, updated_at)
             VALUES (?, ?, ?, ?, 0, ?, ?)`,
          )
          .run(
            body.name,
            body.query,
            bindable(body.description ?? null),
            bindable(body.pinned ?? false),
            now,
            now,
          );
        const row = getRow(ctx, Number(result.lastInsertRowid))!;
        return json(payload(ctx, row));
      },
    },
    {
      method: "PATCH",
      pattern: new URLPattern({ pathname: "/api/searches/:id" }),
      handler: async (req, params, ctx) => {
        const id = Number(params.id);
        if (!getRow(ctx, id)) throw new HttpError(404, "saved search not found");

        const body = await readJson<SavedSearchUpdate>(req);
        const sets: string[] = [];
        const values: unknown[] = [];
        for (const key of UPDATABLE_FIELDS) {
          if (Object.prototype.hasOwnProperty.call(body, key)) {
            sets.push(`${key} = ?`);
            values.push(bindable((body as Record<string, unknown>)[key]));
          }
        }
        sets.push("updated_at = ?");
        values.push(nowIso());
        values.push(id);

        ctx.db
          .prepare(`UPDATE saved_searches SET ${sets.join(", ")} WHERE id = ?`)
          .run(...(values as (string | number | null)[]));

        return json(payload(ctx, getRow(ctx, id)!));
      },
    },
    {
      method: "DELETE",
      pattern: new URLPattern({ pathname: "/api/searches/:id" }),
      handler: (_req, params, ctx) => {
        const id = Number(params.id);
        if (!getRow(ctx, id)) throw new HttpError(404, "saved search not found");
        ctx.db.prepare("DELETE FROM saved_searches WHERE id = ?").run(id);
        return json({ deleted: true });
      },
    },
    {
      method: "GET",
      pattern: new URLPattern({ pathname: "/api/searches/:id/tracks" }),
      handler: (req, params, ctx) => {
        const id = Number(params.id);
        const row = getRow(ctx, id);
        if (!row) throw new HttpError(404, "saved search not found");

        const limitParam = new URL(req.url).searchParams.get("limit");
        const limit = limitParam !== null ? Number(limitParam) : 300;
        const tracks = searchTracks(ctx.db, row.query, limit);
        return json(tracks.map((t) => toBools(t, ["missing"])));
      },
    },
  ];
}
