// Ordered schema migrations. version 1 loads the full schema.sql (idempotent
// DDL). Future migrations are appended here with version = previous + 1.

import type { DatabaseSync } from "node:sqlite";
import { withTx } from "./database.ts";
import { nowIso } from "../utils/time.ts";
// Text import: embeds schema.sql into compiled desktop builds — a runtime
// Deno.readTextFileSync would fail inside the bundled .app where the file
// doesn't exist on disk.
import schemaSql from "./schema.sql" with { type: "text" };

export interface Migration {
  version: number;
  apply: (db: DatabaseSync) => void;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    apply: (db) => {
      db.exec(schemaSql);
    },
  },
];

function currentVersion(db: DatabaseSync): number {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const row = db
    .prepare("SELECT MAX(version) AS v FROM schema_migrations")
    .get() as { v: number | null };
  return row.v ?? 0;
}

/** Applies every migration with version > current DB version, in ascending
 * order, each inside its own transaction. Idempotent — re-running with no
 * pending migrations is a no-op. */
export function runMigrations(db: DatabaseSync, migrations: Migration[] = MIGRATIONS): void {
  const current = currentVersion(db);
  const pending = migrations
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    withTx(db, () => {
      migration.apply(db);
      db.prepare(
        "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      ).run(migration.version, nowIso());
    });
  }
}
