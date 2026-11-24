/** Dev server only (vite.config.ts): what the /api proxy does with a browser's Origin header. */

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const LOCAL = ["localhost", "127.0.0.1", "[::1]"];

function hostname(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/**
 * The Origin header to forward to the backend, or `null` to refuse the request.
 *
 * The backend accepts a write only from its own hostnames (backend/app/web_guard.py), and behind
 * Tailscale or ngrok the browser's Origin is the public name. So the proxy vouches for a write from a
 * page this dev server serves (a local page, one of `fronts`, or the host the request was sent to,
 * which Vite has already checked against `server.allowedHosts`) by replacing its Origin with
 * `backendOrigin`, and refuses a write from any other page. `fronts` are exact hostnames.
 * Reads are forwarded untouched.
 */
export function proxiedOrigin(
  method: string | undefined,
  origin: string | undefined,
  host: string | undefined,
  fronts: readonly string[],
  backendOrigin: string,
): string | null | undefined {
  if (origin === undefined || !UNSAFE.has(method ?? "")) return origin;
  const from = hostname(origin);
  if (from === null) return null;
  const own = host ? hostname(`http://${host}`) : null;
  return LOCAL.includes(from) || fronts.includes(from) || from === own ? backendOrigin : null;
}
