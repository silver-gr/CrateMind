// CrateMind desktop entrypoint: boots config, SQLite, and the same-origin
// HTTP server (API + SPA) in a single Deno.serve() process.

import { loadConfig } from "./src/services/config.ts";
import { backupOnLaunch, initDb, openDb, verifySqliteFeatures } from "./src/db/database.ts";
import { runSeeds } from "./src/db/seed.ts";
import { buildHandler } from "./src/api/router.ts";
import type { AppContext } from "./src/api/router.ts";
import { setupDesktop } from "./src/desktop/window.ts";

const config = loadConfig();
backupOnLaunch(config.dbFile, config.backupDir, config.backupKeep);

const db = openDb(config.dbFile);
verifySqliteFeatures(db);
initDb(db);

const ctx: AppContext = { db, config };
runSeeds(ctx);

console.log(`CrateMind data dir: ${config.dataDir}`);
console.log(`CrateMind listening on http://${config.host}:${config.port}`);

const server = Deno.serve({ port: config.port, hostname: config.host }, buildHandler(ctx));

// Size the native window and install the macOS menu bar (desktop runtime only).
setupDesktop(config.dataDir);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await server.shutdown();
  db.close();
  Deno.exit(0);
}

Deno.addSignalListener("SIGINT", shutdown);
if (Deno.build.os !== "windows") {
  Deno.addSignalListener("SIGTERM", shutdown);
}
