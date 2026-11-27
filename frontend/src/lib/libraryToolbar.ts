/**
 * The Library toolbar's three folding sections, «Έτοιμα φίλτρα», «Μαζική επεξεργασία» and «Εργαλεία βιβλιοθήκης»: tab headings
 * on the toolbar's second row that share one container under it. At most one is open, and all may be closed (`null`).
 */
export type LibraryToolbarTab = "presets" | "bulk" | "tools";
export const LIBRARY_TOOLBAR_TABS: readonly LibraryToolbarTab[] = ["presets", "bulk", "tools"];

export function isLibraryToolbarTab(value: unknown): value is LibraryToolbarTab {
  return LIBRARY_TOOLBAR_TABS.includes(value as LibraryToolbarTab);
}

/** A heading's click: the open section's heading closes it; any other opens its own section and so closes the open one. */
export function toggleToolbarTab(current: LibraryToolbarTab | null, clicked: LibraryToolbarTab): LibraryToolbarTab | null {
  return current === clicked ? null : clicked;
}

/** A stored value read back: anything but a known section is «all closed». */
export function normalizeToolbarTab(stored: unknown): LibraryToolbarTab | null {
  return isLibraryToolbarTab(stored) ? stored : null;
}
