// Saved-search seed defaults — desktop addition, not present in the Python
// backend (guide §14). Inserts the default Memory Crates on first launch;
// idempotent by name so repeated launches never duplicate rows.

import type { AppContext } from "../api/dispatch.ts";
import { nowIso } from "../utils/time.ts";

const DEFAULT_SEARCHES: { name: string; query: string }[] = [
  { name: "Forgotten Approved", query: "status:approved not_recent:90" },
  { name: "Approved Never Played", query: "status:approved never_played" },
  { name: "Long Break Candidates", query: "break:long" },
  {
    name: "Peak Bridge Weapons",
    query:
      "status:approved darkness:7+ energy:8+ bpm:150-160 role:bridge break:long tolerance:huge not_recent:30 dramatic",
  },
  { name: "New Untagged", query: "untagged" },
];

/** Inserts any default saved search whose name doesn't already exist. Safe
 * to call on every launch — never touches or duplicates existing rows. */
export function runSeeds(ctx: AppContext): void {
  const exists = ctx.db.prepare("SELECT 1 FROM saved_searches WHERE name = ?");
  const insert = ctx.db.prepare(
    `INSERT INTO saved_searches (name, query, description, pinned, sort_order, created_at, updated_at)
     VALUES (?, ?, NULL, 0, 0, ?, ?)`,
  );

  for (const seed of DEFAULT_SEARCHES) {
    if (exists.get(seed.name)) continue;
    const now = nowIso();
    insert.run(seed.name, seed.query, now, now);
  }
}
