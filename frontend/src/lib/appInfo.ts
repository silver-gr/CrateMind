/** What the «Σχετικά με το CrateMind» window says about this build and where it runs. */

/** The app version, from frontend/package.json at build time ("" outside a Vite build, e.g. unit tests). */
export const APP_VERSION = typeof __APP_VERSION__ !== "undefined" && __APP_VERSION__ ? __APP_VERSION__ : "";
/** Short git commit of the build, with "+" for uncommitted changes; "" when the build had no git. */
export const APP_COMMIT = typeof __APP_COMMIT__ !== "undefined" && __APP_COMMIT__ ? __APP_COMMIT__ : "";

const ABOUT_EVENT = "cm:about";

/** Open the About window from anywhere (the native menu dispatches the same event). */
export function openAbout(): void {
  window.dispatchEvent(new Event(ABOUT_EVENT));
}

export function onAboutRequest(listener: () => void): () => void {
  window.addEventListener(ABOUT_EVENT, listener);
  return () => window.removeEventListener(ABOUT_EVENT, listener);
}

const PLATFORMS: Record<string, string> = { macos: "macOS", windows: "Windows", linux: "Linux" };

function cpuLabel(platform: string | undefined, arch: string | undefined): string | undefined {
  if (arch === "aarch64" || arch === "arm64" || arch === "arm") return platform === "macos" ? "Apple Silicon" : "ARM64";
  if (arch === "x86_64" || arch === "x86") return platform === "macos" ? "Intel" : "x64";
  return undefined;
}

function platformFromUserAgent(userAgent: string): string | undefined {
  if (/Windows/i.test(userAgent)) return "windows";
  if (/Android|iPhone|iPad/i.test(userAgent)) return undefined;
  if (/Mac OS X|Macintosh/i.test(userAgent)) return "macos";
  if (/Linux/i.test(userAgent)) return "linux";
  return undefined;
}

/**
 * «Desktop · macOS · Apple Silicon» or «Web · Windows». `nativeHost` is "os arch" as the desktop shell reports it
 * (`<html data-native-host>`, set by native/src-tauri); `browserArch` is the browser's own answer where it has one
 * (Chromium's `userAgentData`). The CPU is left out when nobody knows it: Safari and the macOS WebView do not tell.
 */
export function runtimeLabel(input: { desktop: boolean; nativeHost?: string; userAgent?: string; browserArch?: string }): string {
  const [os, arch] = (input.nativeHost ?? "").split(" ");
  const platform = os && PLATFORMS[os] ? os : platformFromUserAgent(input.userAgent ?? "");
  const cpu = cpuLabel(platform, arch || input.browserArch);
  return [input.desktop ? "Desktop" : "Web", platform ? PLATFORMS[platform] : undefined, cpu].filter(Boolean).join(" · ");
}
