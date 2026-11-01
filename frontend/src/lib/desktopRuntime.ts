import { stopEngines } from "./audio/stretchDeck";

export function isDesktopRuntime(): boolean {
  return import.meta.env?.MODE === "desktop" ||
    (typeof document !== "undefined" && document.documentElement.dataset.desktop === "true");
}

export type LibraryRoot = {
  root_key: string;
  logical_prefix: string;
  logical_flavor: "posix" | "windows";
  local_prefix: string | null;
  enabled: boolean;
};
export type DesktopConfig = { version: 1; revision: string; library_roots: LibraryRoot[] };
export type NativeResult<T> = { canceled: boolean; value?: T };
export type NativeAction = "pick_library_roots" | "pick_export_dir" | "reveal_path" | "open_external";

export function stopMediaPlayback(): void {
  stopEngines();
  document.querySelectorAll("audio").forEach(audio => {
    audio.pause(); audio.removeAttribute("src"); audio.load();
  });
}

export function mayChangeIdentity(providerWorkflows: boolean, sources: { service: string }[]): boolean {
  return providerWorkflows || (sources.length === 2 && sources.every(source => source.service === "local"));
}

export function nativeAction<T>(action: NativeAction, arguments_: Record<string, unknown> = {}): Promise<NativeResult<T>> {
  return fetch("/api/desktop/native-actions", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, arguments: arguments_ }),
  }).then(async response => {
    const value = await response.json();
    if (!response.ok) throw new Error(typeof value.detail === "string" ? value.detail : "Η ενέργεια δεν ολοκληρώθηκε.");
    return value;
  });
}

export function interceptExternalLinks(onError: (message: string) => void): () => void {
  const handler = (event: MouseEvent) => {
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
    if (!anchor || event.defaultPrevented) return;
    const url = new URL(anchor.href, location.href);
    if (url.origin === location.origin || !["http:", "https:"].includes(url.protocol)) return;
    event.preventDefault();
    void nativeAction("open_external", { url: url.href }).catch(error => onError((error as Error).message));
  };
  document.addEventListener("click", handler);
  return () => document.removeEventListener("click", handler);
}
