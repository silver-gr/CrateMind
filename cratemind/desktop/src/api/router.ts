// Same-origin router: matches /api/* routes in registration order, falls
// back to the SPA for everything else.

import type { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "../services/config.ts";
import { err, HttpError } from "../utils/http.ts";
import { serveSpa } from "../spa.ts";

import { routes as systemRoutes } from "./system.ts";
import { routes as tracksRoutes } from "./tracks.ts";
import { routes as searchesRoutes } from "./searches.ts";
import { routes as setsRoutes } from "./sets.ts";
import { routes as tagsRoutes } from "./tags.ts";
import { routes as duplicatesRoutes } from "./duplicates.ts";
import { routes as exportRoutes } from "./export.ts";
import { routes as scanRoutes } from "./scan.ts";
import { routes as artistsRoutes } from "./artists.ts";

export interface AppContext {
  db: DatabaseSync;
  config: AppConfig;
}

export interface RouteDef {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  pattern: URLPattern;
  handler: (
    req: Request,
    params: Record<string, string | undefined>,
    ctx: AppContext,
  ) => Promise<Response> | Response;
}

/** All API routes, in registration order — this order matters: literal
 * paths (e.g. /api/tracks/search) must be listed before /:param routes
 * within each module so they aren't shadowed. */
function allRoutes(): RouteDef[] {
  return [
    ...systemRoutes(),
    ...tracksRoutes(),
    ...searchesRoutes(),
    ...setsRoutes(),
    ...tagsRoutes(),
    ...duplicatesRoutes(),
    ...exportRoutes(),
    ...scanRoutes(),
    ...artistsRoutes(),
  ];
}

/** Matches `req` against `routes` in order and invokes the first hit's
 * handler; HttpError -> err(status, detail), unknown error -> 500 {detail},
 * no match -> 404 {detail:"Not found"}. Factored out of buildHandler so
 * route-dispatch semantics can be exercised directly against a small test
 * RouteDef[] without depending on the real (per-wave-owned) api/* modules. */
export async function dispatch(
  routes: RouteDef[],
  req: Request,
  ctx: AppContext,
): Promise<Response> {
  const url = new URL(req.url);
  for (const route of routes) {
    if (route.method !== req.method) continue;
    const match = route.pattern.exec(url);
    if (!match) continue;
    const params: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(match.pathname.groups)) {
      params[key] = value;
    }
    try {
      return await route.handler(req, params, ctx);
    } catch (e) {
      if (e instanceof HttpError) {
        return err(e.status, e.detail);
      }
      console.error(e);
      return err(500, e instanceof Error ? e.message : "Internal server error");
    }
  }
  return err(404, "Not found");
}

export function buildHandler(
  ctx: AppContext,
): (req: Request) => Promise<Response> {
  const routes = allRoutes();

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname.startsWith("/api/")) {
      return await dispatch(routes, req, ctx);
    }

    return await serveSpa(req);
  };
}
