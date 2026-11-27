import { useEffect, useEffectEvent, useRef, type CSSProperties } from "react";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { FacetFilterPanel } from "../FacetFilterPanel";
import { ResizeHandle } from "../ui/ResizeHandle";
import { cn } from "../../lib/cn";
import { hasOpenSurface } from "../../lib/keyboardGuard";
import { getPref, isLibraryPanelTab, setPref, type LibraryPanelTab } from "../../lib/prefs";
import { useResizable } from "../../lib/useResizable";
import { HistoryIcon, MicVocal, SlidersHorizontal } from "../../lib/icons";
import { SIDE_PANEL_WIDTH } from "../../lib/pageRail";
import type { MenuSource } from "../../lib/menus/entries";
import type { Track } from "../../lib/types";
import { PanelTabs } from "./PanelTabs";
import LibraryArtists from "./LibraryArtists";
import LibraryHistory from "./LibraryHistory";

/** The side panel's tabs, with the icons the toolbar's view toggle shows for them too. */
export const LIBRARY_PANEL_TAB_LABELS: { value: LibraryPanelTab; label: string; icon: typeof SlidersHorizontal }[] = [
  { value: "filters", label: "Φίλτρα", icon: SlidersHorizontal },
  { value: "artists", label: "Καλλιτέχνες", icon: MicVocal },
  { value: "history", label: "Ιστορικό", icon: HistoryIcon },
];

/** Static beside the track list from `lg` (the handle shows); below it the panel overlays the list. */
export const LIBRARY_PANEL_STATIC_QUERY = "(min-width: 64rem)";
const STATIC_QUERY = LIBRARY_PANEL_STATIC_QUERY;

/**
 * The Library side panel between the main sidebar and the track list: «Φίλτρα» / «Καλλιτέχνες» / «Ιστορικό».
 * It owns the aside, its width and resize handle, and the tab row; each tab owns its header, padding and
 * scrolling list. Tabs stay mounted (closed too); a tab is `active` only while it shows.
 */
export function LibrarySidePanel({ railed = false, open, tab, draft, applied, onApply, onOpenArtist, selectedId, onSelect, onSetSaved, trackMenu, returnFocus }: {
  /** In the shell's left column (no sidebar column shown): static at its own width, from under the top bar down. */
  railed?: boolean;
  open: boolean;
  tab: LibraryPanelTab;
  draft: string;
  applied: string;
  onApply(next: string): void;
  onOpenArtist(name: string): void;
  selectedId?: number;
  onSelect(trackId: number): void;
  onSetSaved(): void;
  /** The track menu for the «Ιστορικό» plays. */
  trackMenu?: MenuSource<Track>;
  /** The toolbar button of the shown tab, focused when Escape closes the overlay. */
  returnFocus(): HTMLElement | null;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const { size, isDragging, handleProps } = useResizable({
    direction: "horizontal",
    // «Καλλιτέχνες» needs (W − 31) / 3 − 12 ≥ 75 px in the tab row, so 296 is the narrowest unclipped width.
    initial: SIDE_PANEL_WIDTH,
    min: 296,
    max: 440,
    storageKey: "cm:library-panel-width",
  });

  // Overlay only: Escape closes the panel unless something else (a menu, a select, a dialog or drawer) owns it.
  const onEscape = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented || railed || window.matchMedia(STATIC_QUERY).matches) return;
    if (hasOpenSurface() || document.querySelector('[role="dialog"]:not([data-state="closed"])')) return;
    const active = document.activeElement;
    const hadFocus = active === null || active === document.body || (panelRef.current?.contains(active) ?? false);
    setPref("libraryFacetPanel", { ...getPref("libraryFacetPanel"), open: false });
    if (hadFocus) returnFocus()?.focus();
  });
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => onEscape(event);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <aside
      ref={panelRef}
      id="library-facet-panel"
      aria-label="Φίλτρα, καλλιτέχνες και ιστορικό"
      style={{ "--library-panel-width": `${size}px` } as CSSProperties}
      className={cn(
        open ? "flex" : "hidden",
        "shrink-0 flex-col border-r border-cm-border",
        railed
          ? "relative w-[var(--library-panel-width)] bg-cm-bg-2/40"
          : ["absolute inset-y-0 left-0 z-30 w-[min(var(--library-panel-width),calc(100%-48px))] bg-cm-bg shadow-xl",
            "lg:relative lg:z-auto lg:w-[max(296px,min(var(--library-panel-width),calc(100%-16rem)))] lg:bg-cm-bg-2/40 lg:shadow-none"],
      )}
    >
      <Tabs
        value={tab}
        onValueChange={value => {
          if (isLibraryPanelTab(value)) setPref("libraryFacetPanel", { ...getPref("libraryFacetPanel"), tab: value });
        }}
        className="min-h-0 flex-1 gap-0"
      >
        <div className="shrink-0 border-b border-cm-border px-3 py-2.5">
          <PanelTabs tabs={LIBRARY_PANEL_TAB_LABELS} value={tab} ariaLabel="Καρτέλες πλαϊνής στήλης" />
        </div>
        {/* Each tab starts with a focusable control, so its tabpanel is not a (ringless) tab stop of its own. */}
        <TabsContent value="filters" forceMount tabIndex={-1} className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
          <FacetFilterPanel active={open && tab === "filters"} draft={draft} applied={applied} onApply={onApply} />
        </TabsContent>
        <TabsContent value="artists" forceMount tabIndex={-1} className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
          <LibraryArtists active={open && tab === "artists"} appliedQuery={applied} onOpenArtist={onOpenArtist} />
        </TabsContent>
        <TabsContent value="history" forceMount tabIndex={-1} className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
          <LibraryHistory active={open && tab === "history"} selectedId={selectedId} onSelect={onSelect} onSetSaved={onSetSaved} trackMenu={trackMenu} />
        </TabsContent>
      </Tabs>
      <ResizeHandle
        orientation="vertical"
        isDragging={isDragging}
        ariaLabel="Αλλαγή πλάτους πλαϊνής στήλης"
        className={cn("absolute inset-y-0 -right-1.5 z-30", railed ? "flex" : "hidden lg:flex")}
        {...handleProps}
      />
    </aside>
  );
}
