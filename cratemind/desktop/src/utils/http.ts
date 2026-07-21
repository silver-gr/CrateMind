// HTTP response / request helpers shared across api/* route handlers.

/** An error carrying an HTTP status and a `{detail}` message, thrown from
 * route handlers and caught by the router's buildHandler(). */
export class HttpError extends Error {
  status: number;
  detail: string;

  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
    this.detail = detail;
  }
}

/** JSON response with the given status (default 200). */
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** `{"detail": ...}` error response — the shape frontend `req<T>()` reads. */
export function err(status: number, detail: string): Response {
  return json({ detail }, status);
}

/** 204 No Content. */
export function noContent(): Response {
  return new Response(null, { status: 204 });
}

/** Parses the request body as JSON; throws HttpError(400) on invalid JSON. */
export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

/** Converts a JS value into something node:sqlite's DatabaseSync can bind:
 * booleans become 0/1, undefined becomes null, Dates become ISO strings,
 * everything else passes through unchanged. */
export function bindable(v: unknown): string | number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  return v as string | number;
}
