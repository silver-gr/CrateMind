// Page-drawn caption buttons for the borderless Windows desktop window (Tauri window plugin commands).
export type CaptionId = "minimize" | "maximize" | "close";
export interface CaptionButton { id: CaptionId; label: string; glyph: string; command: string }

export const IS_MAXIMIZED_COMMAND = "plugin:window|is_maximized";

export function hasCustomTitlebar(root?: { dataset: { nativeTitlebar?: string } }): boolean {
  const el = root ?? (typeof document === "undefined" ? undefined : document.documentElement);
  return el?.dataset.nativeTitlebar === "custom";
}

export function captionButtons(maximized: boolean): CaptionButton[] {
  return [
    { id: "minimize", label: "Ελαχιστοποίηση", glyph: "\uE921", command: "plugin:window|minimize" },
    maximized
      ? { id: "maximize", label: "Επαναφορά", glyph: "\uE923", command: "plugin:window|toggle_maximize" }
      : { id: "maximize", label: "Μεγιστοποίηση", glyph: "\uE922", command: "plugin:window|toggle_maximize" },
    { id: "close", label: "Κλείσιμο", glyph: "\uE8BB", command: "plugin:window|close" },
  ];
}

type TauriInternals = { invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown> };

export async function invokeWindow(command: string): Promise<unknown> {
  const internals = (globalThis as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  if (!internals?.invoke) return undefined;
  return internals.invoke(command, {});
}
