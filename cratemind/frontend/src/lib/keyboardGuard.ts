/**
 * Shared guard for global single-key keyboard shortcuts (TaggingQueue rating keys,
 * Library J/K, MiniPlayer Space/seek).
 *
 * Returns true when a shortcut must be SUPPRESSED because the user is:
 *  - typing in a native field (input / textarea / select / contenteditable), or
 *  - focused inside a Radix/shadcn surface — a *closed* SelectTrigger is
 *    role="combobox", an open menu/listbox, a Slider thumb (role="slider"),
 *    a Switch (role="switch"), a Tab (role="tab"), or a Dialog — or
 *  - any Radix dialog overlay is currently open.
 *
 * Without this, focusing a Radix control and pressing a rating key (1-0 / W A X …)
 * would silently write profile metadata, and Space would toggle audio. Data-safety.
 */
const INTERACTIVE_SELECTOR = [
  '[role="dialog"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="menu"]',
  '[role="slider"]',
  '[role="switch"]',
  '[role="tab"]',
  '[aria-haspopup="listbox"]',
  '[aria-haspopup="menu"]',
  '[contenteditable="true"]',
].join(",");

export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (el && el.tagName) {
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable) return true;
    if (typeof el.closest === "function" && el.closest(INTERACTIVE_SELECTOR)) return true;
  }
  if (typeof document !== "undefined" && document.querySelector('[data-state="open"][role="dialog"]')) {
    return true;
  }
  return false;
}
