// Timestamp helper shared across the app. Always use this for persisted
// timestamps — never Date#toString().

/** ISO-8601 UTC timestamp with T/Z separators, e.g. "2026-07-21T18:00:00.000Z". */
export function nowIso(): string {
  return new Date().toISOString();
}
