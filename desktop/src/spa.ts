// Serves the built React SPA (frontend/dist) for any non-/api request.
// Resolved relative to this module's URL, not Deno.cwd() — the server may
// be launched from any working directory.

import { serveDir, serveFile } from "@std/http/file-server";

const distUrl = new URL("../../frontend/dist", import.meta.url);
const DIST_DIR = Deno.build.os === "windows" ? distUrl.pathname.slice(1) : distUrl.pathname;

const MISSING_DIST_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>CrateMind — build missing</title></head>
<body style="font-family: sans-serif; padding: 2rem;">
  <h1>Frontend build not found</h1>
  <p>Run <code>npm run build</code> in <code>frontend/</code> to generate <code>frontend/dist</code>.</p>
</body>
</html>`;

function distExists(): boolean {
  try {
    return Deno.statSync(DIST_DIR).isDirectory;
  } catch {
    return false;
  }
}

/** True if a 404 for this request should fall back to index.html: only for
 * GET/HEAD requests to a path whose last segment has no file extension
 * (React Router client-side routes). Static asset requests (e.g.
 * /assets/app.abc123.js) or non-GET/HEAD methods surface their real 404
 * instead. Exported as a pure function so this rule can be unit-tested
 * directly without depending on frontend/dist existing on disk. */
export function shouldFallbackToIndex(method: string, pathname: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
  return !lastSegment.includes(".");
}

/** Serves the SPA: static assets from frontend/dist, falling back to
 * index.html for unmatched paths (React Router client-side routes). Returns
 * a 503 explainer page if frontend/dist hasn't been built yet. */
export async function serveSpa(req: Request): Promise<Response> {
  if (!distExists()) {
    return new Response(MISSING_DIST_HTML, {
      status: 503,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  const res = await serveDir(req, { fsRoot: DIST_DIR, quiet: true });
  if (res.status === 404 && shouldFallbackToIndex(req.method, new URL(req.url).pathname)) {
    return await serveFile(req, `${DIST_DIR}/index.html`);
  }
  return res;
}
