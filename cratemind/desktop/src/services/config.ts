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
  host: string;
  port: number;
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

// Well-known Unix install dirs that a Finder/`open`-launched macOS app does
// NOT inherit on PATH (GUI apps get a minimal /usr/bin:/bin:/usr/sbin:/sbin).
// Homebrew (Apple Silicon + Intel) and MacPorts land here, so ffprobe/fpcalc
// are found without the user setting an env var. Searched AFTER the real PATH,
// so an explicit PATH entry or CRATEMIND_*_PATH override always wins.
const WELL_KNOWN_BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"];

/** Checks candidate directories for an existing executable file named `name`,
 * without spawning anything. Searches PATH first, then the well-known install
 * dirs GUI launches miss. Returns the resolved path or null if not found. */
function which(name: string): string | null {
  const pathEnv = Deno.env.get("PATH") ?? "";
  const delimiter = Deno.build.os === "windows" ? ";" : ":";
  const candidates = Deno.build.os === "windows" ? [name, `${name}.exe`] : [name];
  const dirs = pathEnv.split(delimiter);
  if (Deno.build.os !== "windows") dirs.push(...WELL_KNOWN_BIN_DIRS);
  for (const dir of dirs) {
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

/** Reads library roots from `${dataDir}/config.json` — the fallback used
 * when CRATEMIND_LIBRARY_ROOTS isn't set, so the packaged .app works when
 * launched from Finder (no shell env). Creates a template file on first run
 * so the user has something to edit. Accepts `library_roots` as an array of
 * paths or a single comma-separated string. */
function rootsFromConfigFile(dataDir: string): string[] {
  const configPath = `${dataDir}/config.json`;
  let raw: string;
  try {
    raw = Deno.readTextFileSync(configPath);
  } catch {
    try {
      Deno.writeTextFileSync(
        configPath,
        JSON.stringify({ library_roots: [] }, null, 2) + "\n",
      );
    } catch {
      // dataDir not writable — nothing to fall back to
    }
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { library_roots?: string[] | string };
    const roots = parsed.library_roots;
    if (Array.isArray(roots)) {
      return roots.filter((r) => typeof r === "string" && r.trim())
        .map((r) => expandHome(r.trim()));
    }
    if (typeof roots === "string") return parseLibraryRoots(roots);
  } catch (e) {
    console.error(`CrateMind: could not parse ${configPath}: ${e}`);
  }
  return [];
}

/** Loads config from env, resolving the app-data directory and ensuring
 * dataDir/backups/exports exist (mirrors Settings.ensure_dirs()).
 * Library roots: CRATEMIND_LIBRARY_ROOTS env wins; otherwise
 * `${dataDir}/config.json` (see rootsFromConfigFile). */
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

  const portRaw = Deno.env.get("CRATEMIND_PORT");
  const port = portRaw ? parseInt(portRaw, 10) : 8734;

  return {
    dataDir,
    dbFile,
    backupDir,
    exportsDir,
    backupKeep: Number.isFinite(backupKeep) ? backupKeep : 10,
    libraryRoots: (() => {
      const fromEnv = parseLibraryRoots(
        Deno.env.get("CRATEMIND_LIBRARY_ROOTS") ?? "",
      );
      return fromEnv.length > 0 ? fromEnv : rootsFromConfigFile(dataDir);
    })(),
    ffprobePath: resolveToolPath("CRATEMIND_FFPROBE_PATH", "ffprobe"),
    fpcalcPath: resolveToolPath("CRATEMIND_FPCALC_PATH", "fpcalc"),
    ffmpegPath: resolveToolPath("CRATEMIND_FFMPEG_PATH", "ffmpeg"),
    host: "127.0.0.1",
    port: Number.isFinite(port) ? port : 8734,
  };
}
