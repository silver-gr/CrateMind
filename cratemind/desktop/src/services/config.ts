// Application configuration — port of backend/app/config.py semantics onto
// Deno env vars + an OS app-data directory (see appPaths.ts) instead of a
// relative ./data folder.

import { getAppDataDir } from "./appPaths.ts";

export interface AppConfig {
  dataDir: string;
  dbFile: string;
  backupDir: string;
  exportsDir: string;
  backupKeep: number;
  libraryRoots: string[];
  ffprobePath: string | null;
  fpcalcPath: string | null;
  ffmpegPath: string | null;
}

function expandHome(p: string): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
  if (p === "~") return home;
  if (p.startsWith("~/")) return `${home}/${p.slice(2)}`;
  return p;
}

/** Splits CRATEMIND_LIBRARY_ROOTS on commas, trims, drops empties, expands `~`. */
function parseLibraryRoots(raw: string): string[] {
  const out: string[] = [];
  for (const chunk of raw.split(",")) {
    const trimmed = chunk.trim();
    if (trimmed) out.push(expandHome(trimmed));
  }
  return out;
}

/** Checks candidate directories on PATH for an existing executable file
 * named `name`, without spawning anything. Returns the resolved path or
 * null if not found. */
function which(name: string): string | null {
  const pathEnv = Deno.env.get("PATH") ?? "";
  const delimiter = Deno.build.os === "windows" ? ";" : ":";
  const candidates = Deno.build.os === "windows" ? [name, `${name}.exe`] : [name];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const candidate of candidates) {
      const full = `${dir}/${candidate}`;
      try {
        const stat = Deno.statSync(full);
        if (stat.isFile) return full;
      } catch {
        // not found here, keep looking
      }
    }
  }
  return null;
}

function resolveToolPath(envVar: string, binaryName: string): string | null {
  const override = Deno.env.get(envVar);
  if (override) return override;
  return which(binaryName);
}

/** Loads config from env, resolving the app-data directory and ensuring
 * dataDir/backups/exports exist (mirrors Settings.ensure_dirs()). */
export function loadConfig(): AppConfig {
  const dataDir = getAppDataDir();
  const backupDir = `${dataDir}/backups`;
  const exportsDir = `${dataDir}/exports`;
  const dbFile = `${dataDir}/cratemind.sqlite`;

  Deno.mkdirSync(dataDir, { recursive: true });
  Deno.mkdirSync(backupDir, { recursive: true });
  Deno.mkdirSync(exportsDir, { recursive: true });

  const backupKeepRaw = Deno.env.get("CRATEMIND_BACKUP_KEEP");
  const backupKeep = backupKeepRaw ? parseInt(backupKeepRaw, 10) : 10;

  return {
    dataDir,
    dbFile,
    backupDir,
    exportsDir,
    backupKeep: Number.isFinite(backupKeep) ? backupKeep : 10,
    libraryRoots: parseLibraryRoots(Deno.env.get("CRATEMIND_LIBRARY_ROOTS") ?? ""),
    ffprobePath: resolveToolPath("CRATEMIND_FFPROBE_PATH", "ffprobe"),
    fpcalcPath: resolveToolPath("CRATEMIND_FPCALC_PATH", "fpcalc"),
    ffmpegPath: resolveToolPath("CRATEMIND_FFMPEG_PATH", "ffmpeg"),
  };
}
