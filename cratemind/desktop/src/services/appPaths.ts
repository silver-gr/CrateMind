// Resolves the per-OS application-data directory CrateMind stores its SQLite
// DB, backups, and exports under. Mirrors backend/app/config.py's notion of a
// local-first data root, but rooted in the OS app-data convention instead of
// a relative ./data folder (desktop build has no fixed "backend/" cwd).

/** Application data directory. `CRATEMIND_DATA_DIR` always wins; otherwise
 * platform convention: darwin -> ~/Library/Application Support/CrateMind,
 * windows -> %APPDATA%\CrateMind, linux -> $XDG_DATA_HOME/CrateMind or
 * ~/.local/share/CrateMind. */
export function getAppDataDir(): string {
  const override = Deno.env.get("CRATEMIND_DATA_DIR");
  if (override) return override;

  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";

  switch (Deno.build.os) {
    case "darwin":
      return `${home}/Library/Application Support/CrateMind`;
    case "windows": {
      const appData = Deno.env.get("APPDATA") ?? `${home}\\AppData\\Roaming`;
      return `${appData}\\CrateMind`;
    }
    default: {
      const xdgDataHome = Deno.env.get("XDG_DATA_HOME") ?? `${home}/.local/share`;
      return `${xdgDataHome}/CrateMind`;
    }
  }
}
