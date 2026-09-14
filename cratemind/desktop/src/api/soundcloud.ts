// SoundCloud metadata import and conservative match-review API.

import type { AppContext, RouteDef } from "./dispatch.ts";
import { HttpError, json, readJson } from "../utils/http.ts";
import {
  acceptSoundCloudCandidate,
  importSoundCloudBatch,
  rejectSoundCloudCandidate,
  soundCloudReview,
  soundCloudSummary,
} from "../services/soundcloud.ts";
import type { SoundCloudImportBatch } from "../types/models.ts";

const MAX_IMPORT_ITEMS = 250;
const DEFAULT_REVIEW_LIMIT = 100;
const MAX_REVIEW_LIMIT = 250;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function importBatch(req: Request, _params: Record<string, string | undefined>, ctx: AppContext): Promise<Response> {
  const body = await readJson<unknown>(req);
  if (!isRecord(body) || typeof body.run_id !== "string" || !body.run_id.trim() ||
    !Array.isArray(body.items) || typeof body.complete !== "boolean") {
    throw new HttpError(400, "run_id, items, and complete are required");
  }
  if (body.items.length > MAX_IMPORT_ITEMS) {
    throw new HttpError(400, `items must contain at most ${MAX_IMPORT_ITEMS} entries`);
  }
  const payload: SoundCloudImportBatch = {
    run_id: body.run_id.trim(),
    items: body.items,
    complete: body.complete,
  };
  return json(importSoundCloudBatch(ctx.db, payload.run_id, payload.items, payload.complete));
}

function reviewLimit(url: URL): number {
  const value = Number(url.searchParams.get("limit") ?? DEFAULT_REVIEW_LIMIT);
  if (!Number.isFinite(value)) return DEFAULT_REVIEW_LIMIT;
  return Math.max(1, Math.min(MAX_REVIEW_LIMIT, Math.trunc(value)));
}

function reviewOffset(url: URL): number {
  const value = Number(url.searchParams.get("offset") ?? 0);
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function reviewIds(params: Record<string, string | undefined>): [number, number] {
  const trackId = Number(params.trackId);
  const soundcloudTrackId = Number(params.soundcloudTrackId);
  if (!Number.isSafeInteger(trackId) || trackId <= 0 ||
    !Number.isSafeInteger(soundcloudTrackId) || soundcloudTrackId <= 0) {
    throw new HttpError(404, "SoundCloud candidate not found");
  }
  return [trackId, soundcloudTrackId];
}

function reviewError(error: unknown): never {
  const message = error instanceof Error ? error.message : "SoundCloud review failed";
  if (message.endsWith("not found")) throw new HttpError(404, message);
  if (message.includes("rejected") || message.includes("not pending")) {
    throw new HttpError(409, message);
  }
  throw error;
}

function accept(_req: Request, params: Record<string, string | undefined>, ctx: AppContext): Response {
  const [trackId, soundcloudTrackId] = reviewIds(params);
  try {
    return json(acceptSoundCloudCandidate(ctx.db, trackId, soundcloudTrackId));
  } catch (error) {
    return reviewError(error);
  }
}

function reject(_req: Request, params: Record<string, string | undefined>, ctx: AppContext): Response {
  const [trackId, soundcloudTrackId] = reviewIds(params);
  try {
    return json(rejectSoundCloudCandidate(ctx.db, trackId, soundcloudTrackId));
  } catch (error) {
    return reviewError(error);
  }
}

export function routes(): RouteDef[] {
  return [
    {
      method: "POST",
      pattern: new URLPattern({ pathname: "/api/soundcloud/import-batch" }),
      handler: importBatch,
    },
    {
      method: "GET",
      pattern: new URLPattern({ pathname: "/api/soundcloud/summary" }),
      handler: (_req, _params, ctx) => json(soundCloudSummary(ctx.db)),
    },
    {
      method: "GET",
      pattern: new URLPattern({ pathname: "/api/soundcloud/review" }),
      handler: (req, _params, ctx) => {
        const url = new URL(req.url);
        return json(soundCloudReview(ctx.db, reviewLimit(url), reviewOffset(url)));
      },
    },
    {
      method: "POST",
      pattern: new URLPattern({ pathname: "/api/soundcloud/review/:trackId/:soundcloudTrackId/accept" }),
      handler: accept,
    },
    {
      method: "POST",
      pattern: new URLPattern({ pathname: "/api/soundcloud/review/:trackId/:soundcloudTrackId/reject" }),
      handler: reject,
    },
  ];
}
