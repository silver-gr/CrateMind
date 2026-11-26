import { isDesktopRuntime } from "./desktopRuntime";

type MenuTarget = { tagName?: string; type?: string; isContentEditable?: boolean } | null;
type TextSelection = { isCollapsed: boolean; toString(): string; containsNode(node: never, partly: boolean): boolean } | null;

const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "range", "button", "submit", "reset", "color", "file", "image"]);

/**
 * The webview's own menu stays for text: an editable field (Copy/Paste) and a right-click on selected text
 * (Copy/Look Up). Everywhere else CrateMind's menu, or none.
 */
export function allowsNativeMenu(target: EventTarget | null, selection: TextSelection): boolean {
  const el = target as MenuTarget;
  if (!el?.tagName) return false;
  if (el.tagName === "TEXTAREA" || el.isContentEditable) return true;
  if (el.tagName === "INPUT" && !NON_TEXT_INPUTS.has((el.type ?? "text").toLowerCase())) return true;
  return !!selection && !selection.isCollapsed && selection.toString().trim() !== "" && selection.containsNode(el as never, true);
}

/**
 * Desktop app only: no webview menu («Reload», «Inspect») outside our menus and text. Bubble phase, so a menu that
 * already opened (and prevented the default) is left alone; a capture-phase preventDefault would stop Radix opening.
 */
export function installNativeMenuGuard(): () => void {
  if (import.meta.env.DEV || !isDesktopRuntime()) return () => {};
  const onContextMenu = (event: MouseEvent) => {
    if (!event.defaultPrevented && !allowsNativeMenu(event.target, window.getSelection())) event.preventDefault();
  };
  window.addEventListener("contextmenu", onContextMenu);
  return () => window.removeEventListener("contextmenu", onContextMenu);
}
