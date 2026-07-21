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

  switch (Deno.build.os) {
    case "darwin": {
      const home = Deno.env.get("HOME");
      if (!home) {
        throw new Error("HOME environment variable is not set; cannot resolve app data directory");
      }
      return `${home}/Library/Application Support/CrateMind`;
    }
    case "windows": {
      const appData = Deno.env.get("APPDATA");
      if (appData) return `${appData}\\CrateMind`;
      const home = Deno.env.get("USERPROFILE");
      if (!home) {
        throw new Error(
          "Neither APPDATA nor USERPROFILE environment variable is set; cannot resolve app data directory",
        );
      }
      return `${home}\\AppData\\Roaming\\CrateMind`;
    }
    default: {
      const xdgDataHome = Deno.env.get("XDG_DATA_HOME");
      if (xdgDataHome) return `${xdgDataHome}/CrateMind`;
      const home = Deno.env.get("HOME");
      if (!home) {
        throw new Error(
          "Neither XDG_DATA_HOME nor HOME environment variable is set; cannot resolve app data directory",
        );
      }
      return `${home}/.local/share/CrateMind`;
    }
  }
}
