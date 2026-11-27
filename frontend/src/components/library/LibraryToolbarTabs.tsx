import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { ChevronDown } from "../../lib/icons";
import { LIBRARY_TOOLBAR_TABS, type LibraryToolbarTab } from "../../lib/libraryToolbar";
import { NumberCount } from "../ui/NumberCount";

/** Each section's heading, whole and (under 51rem of toolbar) short; the short one keeps the whole one for screen readers. */
export const LIBRARY_TOOLBAR_TAB_LABELS: Record<LibraryToolbarTab, { label: string; short: string }> = {
  presets: { label: "Έτοιμα φίλτρα", short: "Έτοιμα" },
  bulk: { label: "Μαζική επεξεργασία", short: "Μαζική" },
  tools: { label: "Εργαλεία βιβλιοθήκης", short: "Εργαλεία" },
};

export const toolbarPanelId = (tab: LibraryToolbarTab) => `library-toolbar-${tab}`;

/**
 * The toolbar's section headings, on its second row: disclosure buttons that share one container under the row, so opening one
 * closes the open one and its own heading closes it. «Μαζική επεξεργασία» carries the checked-row count while any row is checked (a number only, so a selection never widens the
 * row enough to wrap it).
 */
export function LibraryToolbarTabHeadings({ open, onToggle, selectedCount }: {
  open: LibraryToolbarTab | null;
  onToggle(tab: LibraryToolbarTab): void;
  selectedCount: number;
}) {
  return (
    <div role="group" aria-label="Ενότητες βιβλιοθήκης" className="flex shrink-0 items-center gap-0.5">
      {LIBRARY_TOOLBAR_TABS.map(tab => {
        const { label, short } = LIBRARY_TOOLBAR_TAB_LABELS[tab];
        const expanded = open === tab;
        return (
          <button
            key={tab}
            type="button"
            aria-expanded={expanded}
            aria-controls={expanded ? toolbarPanelId(tab) : undefined}
            data-toolbar-tab={tab}
            onClick={event => {
              // A pointer click drops focus, so Space and J/K keep reaching the player and the list.
              if (event.detail > 0) event.currentTarget.blur();
              onToggle(tab);
            }}
            className={cn(
              "inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-2 text-xs font-medium whitespace-nowrap transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-cyan/60",
              expanded ? "surface-selected text-cm-text" : "text-cm-muted hover:bg-cm-contrast/5 hover:text-cm-text",
            )}
          >
            <span className="hidden @min-[51rem]/toolbar:inline">{label}</span>
            <span aria-hidden="true" className="@min-[51rem]/toolbar:hidden">{short}</span>
            <span className="sr-only @min-[51rem]/toolbar:hidden">{label}</span>
            {tab === "bulk" && selectedCount > 0 && (
              <span title={`${selectedCount} επιλεγμένα`} className="rounded bg-cm-cyan/15 px-1.5 py-px font-mono text-[11px] tabular-nums text-cm-cyan">
                <NumberCount value={selectedCount} /><span className="sr-only"> επιλεγμένα</span>
              </span>
            )}
            <ChevronDown aria-hidden="true"
              className={cn("size-3 shrink-0 text-cm-faint motion-safe:transition-transform motion-safe:duration-150", expanded && "rotate-180")} />
          </button>
        );
      })}
    </div>
  );
}

/**
 * The open section's body, under the toolbar's two rows. A section listed in `keepMounted` stays mounted while closed
 * («Μαζική επεξεργασία» keeps its draft and pending confirmation); the others mount when opened. Every body is one wrapping row,
 * centred in a box at least 44 px tall, with 12 px before its first item, so the three sections start at the same inset and no body sits off-centre.
 */
export function LibraryToolbarTabPanels({ open, panels, keepMounted }: {
  open: LibraryToolbarTab | null;
  panels: Record<LibraryToolbarTab, ReactNode>;
  keepMounted: readonly LibraryToolbarTab[];
}) {
  return (
    <>
      {LIBRARY_TOOLBAR_TABS.map(tab => (open === tab || keepMounted.includes(tab)) && (
        <section
          key={tab}
          id={toolbarPanelId(tab)}
          aria-label={LIBRARY_TOOLBAR_TAB_LABELS[tab].label}
          hidden={open !== tab}
          className="mt-2 flex min-h-11 items-center rounded-lg border border-cm-border bg-cm-contrast/[0.03] py-2 pr-2 pl-3 [&>*]:min-w-0 [&>*]:flex-1"
        >
          {panels[tab]}
        </section>
      ))}
    </>
  );
}
