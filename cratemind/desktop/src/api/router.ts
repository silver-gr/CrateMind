// Same-origin router: matches /api/* routes in registration order, falls
// back to the SPA for everything else. Route types + dispatch live in
// dispatch.ts (dependency-free); this module is the only place that imports
// every api/* route module, so nothing else transitively type-checks them.

import { dispatch } from "./dispatch.ts";
import type { AppContext, RouteDef } from "./dispatch.ts";
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

export { dispatch } from "./dispatch.ts";
export type { AppContext, RouteDef } from "./dispatch.ts";

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
