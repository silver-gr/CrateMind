// Health + settings endpoints. Exact key-set port of backend/app/main.py's
// GET /api/health and GET /api/settings handlers.

import type { RouteDef } from "./dispatch.ts";
import { json } from "../utils/http.ts";

export function routes(): RouteDef[] {
  return [
    {
      method: "GET",
      pattern: new URLPattern({ pathname: "/api/health" }),
      handler: (_req, _params, ctx) =>
        json({
          status: "ok",
          library_roots: ctx.config.libraryRoots,
          ffprobe: ctx.config.ffprobePath !== null,
          fpcalc: ctx.config.fpcalcPath !== null,
          ffmpeg: ctx.config.ffmpegPath !== null,
          db: ctx.config.dbFile,
        }),
    },

    {
      method: "GET",
      pattern: new URLPattern({ pathname: "/api/settings" }),
      handler: (_req, _params, ctx) =>
        json({
          library_roots: ctx.config.libraryRoots,
          output_dir: ctx.config.exportsDir,
          db_path: ctx.config.dbFile,
          backup_dir: ctx.config.backupDir,
          ffprobe: ctx.config.ffprobePath,
          fpcalc: ctx.config.fpcalcPath,
          ffmpeg: ctx.config.ffmpegPath,
        }),
    },
  ];
}
