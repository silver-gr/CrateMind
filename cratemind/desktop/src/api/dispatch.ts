// Dependency-free dispatch core: route types + matcher, deliberately free of
// imports from the per-wave-owned api/* modules so tests and route modules can
// depend on it without transitively type-checking concurrently-edited files.

import type { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "../services/config.ts";
import { err, HttpError } from "../utils/http.ts";

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

const MUTATING_METHODS = new Set(["POST", "PATCH", "DELETE"]);

/** True when a Host header names a loopback address (optionally with port). */
export function isLoopbackHost(host: string | null): boolean {
  if (!host) return false;
  const hostname = host.startsWith("[")
    ? host.slice(1, host.indexOf("]"))
    : host.split(":")[0];
  return hostname === "127.0.0.1" || hostname === "localhost" ||
    hostname === "::1";
}

/** Matches `req` against `routes` in order and invokes the first hit's
 * handler; HttpError -> err(status, detail), unknown error -> 500 {detail},
 * path matched but no method matched -> 405 {detail:"Method not allowed"},
 * no path match -> 404 {detail:"Not found"}.
 *
 * Mutating requests (POST/PATCH/DELETE) are hardened before any route
 * matching, since this is a localhost-only server reachable by any local
 * browser page: a Host header that doesn't match the bound host:port is
 * rejected with 403 (DNS-rebinding), and a content-type that isn't
 * application/json is rejected with 415 — centrally, so body-less mutation
 * routes (e.g. /api/scan/fingerprint) are covered too, not just handlers
 * that call readJson(). The frontend's fetch wrapper always sends
 * "Content-Type: application/json". */
export async function dispatch(
  routes: RouteDef[],
  req: Request,
  ctx: AppContext,
): Promise<Response> {
  if (MUTATING_METHODS.has(req.method)) {
    // DNS-rebinding guard: an attacker-controlled domain resolving to
    // 127.0.0.1 arrives with the attacker's hostname in Host. Loopback
    // hostnames are the legitimate set — the PORT is deliberately not
    // pinned: in the packaged desktop app the runtime auto-binds
    // Deno.serve to its own internal loopback port, so config.port is
    // wrong there (pinning it 403'd every mutation in the .app).
    if (!isLoopbackHost(req.headers.get("host"))) {
      return err(403, "Forbidden");
    }
    const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
    if (!contentType.includes("application/json")) {
      return err(415, "Content-Type must be application/json");
    }
  }

  const url = new URL(req.url);
  let pathMatched = false;
  for (const route of routes) {
    const match = route.pattern.exec(url);
    if (!match) continue;
    pathMatched = true;
    if (route.method !== req.method) continue;
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
  if (pathMatched) {
    return err(405, "Method not allowed");
  }
  return err(404, "Not found");
}
