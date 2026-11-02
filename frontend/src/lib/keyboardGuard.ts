/**
 * Shared guard for global single-key keyboard shortcuts (TaggingQueue rating keys,
 * Library J/K, MiniPlayer playback/seek and listening cues).
 *
 * Returns true when a shortcut must be SUPPRESSED because the user is:
 *  - typing in a native field (input / textarea / select / contenteditable), or
 *  - focused inside a Radix/shadcn surface — a *closed* SelectTrigger is
 *    role="combobox", an open menu/listbox, a Slider thumb (role="slider"),
 *    a Switch (role="switch"), a Tab (role="tab"), or a Dialog — or
 *  - a player cue control owns native keyboard activation, or
 *  - any Radix dialog, alert dialog, menu or listbox is currently open.
 *
 * Without this, focusing a Radix control and pressing a rating key (1-0 / W A X …)
 * would silently write profile metadata, and Space would toggle audio. Data-safety.
 */
const INTERACTIVE_SELECTOR = [
  'summary',
  'details[data-set-actions-menu][open]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[data-player-cues]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="menu"]',
  '[role="slider"]',
  '[role="switch"]',
  '[role="tab"]',
  '[aria-haspopup="listbox"]',
  '[aria-haspopup="menu"]',
  '[aria-haspopup="dialog"]',
  '[contenteditable="true"]',
].join(",");

const OPEN_SURFACE_SELECTOR =
  'details[data-set-actions-menu][open], [data-state="open"][role="dialog"], [data-state="open"][role="alertdialog"], '
  + '[data-state="open"][role="menu"], [data-state="open"][role="listbox"]';
export function hasOpenSurface(): boolean {
  return typeof document !== "undefined" && !!document.querySelector(OPEN_SURFACE_SELECTOR);
}

export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (el && el.tagName) {
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable) return true;
    if (typeof el.closest === "function" && el.closest(INTERACTIVE_SELECTOR)) return true;
  }
  if (hasOpenSurface()) return true;
  return false;
}

/** Space and pad digits remain available after seeking, changing volume, or
 * clicking a closed cue control. Capture-phase preventDefault makes Space a
 * transport toggle here, including empty pads; Enter keeps native activation.
 * Arrows still belong to focused range/slider controls. */
export function suppressPlaybackShortcut(target: EventTarget | null, code: string): boolean {
  const el = target as HTMLElement | null;
  // A radio group (vocabulary editor) owns roving focus: its arrows, Home and End must never seek the deck.
  if (/^Arrow|^(Home|End)$/.test(code) && typeof el?.closest === "function" && el.closest('[role="radiogroup"]')) return true;
  // Space on the radio itself chooses the value; other buttons keep Space as the transport toggle.
  if (code === "Space" && typeof el?.closest === "function" && el.closest('[role="radiogroup"] [role="radio"]')) return true;
  // Press-and-hold controls (pitch bend) own Space and Enter: holding must never toggle the transport.
  if ((code === "Space" || code === "Enter") && typeof el?.closest === "function" && el.closest("[data-hold-key]")) return true;
  if ((code === "Space" || cuePadIndex(code) !== null) && el?.tagName && typeof el.closest === "function") {
    if (hasOpenSurface()) return true;
    const tag = el.tagName;
    const explicitTransport = el.closest('[data-playback-shortcuts]');
    const isTransportRange = tag === "INPUT" && (el as HTMLInputElement).type === "range" && explicitTransport;
    if ((tag === "INPUT" && !isTransportRange) || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable) return true;
    if (el.closest('form, summary, [contenteditable="true"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="combobox"], [role="switch"], [role="tab"]')) return true;
    const cueButton = el.closest('[data-player-cues]') && el.closest('button');
    if (explicitTransport || cueButton) return false;
  }
  return isTypingTarget(target);
}
export function cuePadIndex(code: string): number | null {
  const match = /^(?:Digit|Numpad)([1-8])$/.exec(code);
  return match ? Number(match[1]) - 1 : null;
}
