// CrateMind desktop entrypoint: boots config, SQLite, and the same-origin
// HTTP server (API + SPA) in a single Deno.serve() process.

import { loadConfig } from "./src/services/config.ts";
import { backupOnLaunch, initDb, openDb, verifySqliteFeatures } from "./src/db/database.ts";
import { runSeeds } from "./src/db/seed.ts";
import { buildHandler } from "./src/api/router.ts";
import type { AppContext } from "./src/api/router.ts";

const config = loadConfig();
backupOnLaunch(config.dbFile, config.backupDir, config.backupKeep);

const db = openDb(config.dbFile);
verifySqliteFeatures(db);
initDb(db);

const ctx: AppContext = { db, config };
runSeeds(ctx);

const port = parseInt(Deno.env.get("CRATEMIND_PORT") ?? "8734", 10);
const hostname = "127.0.0.1";

console.log(`CrateMind data dir: ${config.dataDir}`);
console.log(`CrateMind listening on http://${hostname}:${port}`);

Deno.serve({ port, hostname }, buildHandler(ctx));
