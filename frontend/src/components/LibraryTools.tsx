import type { ComponentProps, ReactNode } from "react";
import { ChevronRight, ListFilter, Plus, Radio, RotateCcw, Save } from "../lib/icons";
import { LIBRARY_COLUMNS, columnLabel } from "../lib/tablePreferences";
import type { DJSet } from "../lib/types";
import { tablePreferenceStore, useTablePreferences } from "../lib/useTablePreferences";
import { BulkTagBar } from "./BulkTagBar";
import { Button } from "./ui/button";
import { NumberCount } from "./ui/NumberCount";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

export function LibraryDisclosure({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <details className="group/library-disclosure">
      <summary className="flex min-h-7 w-fit cursor-pointer list-none items-center gap-1.5 rounded-md px-1.5 text-xs font-medium text-cm-muted hover:text-cm-text focus-visible:outline-2 focus-visible:outline-cm-cyan [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 group-open/library-disclosure:rotate-90" />
        {label}
      </summary>
      {children}
    </details>
  );
}

export function LibraryBulkActions(props: ComponentProps<typeof BulkTagBar>) {
  return (
    <LibraryDisclosure label={
      <>
        Μαζική επεξεργασία
        <span className="whitespace-nowrap rounded bg-cm-contrast/5 px-1.5 py-0.5 text-cm-faint">
          <NumberCount value={props.selectedIds.size} /> επιλεγμένα
        </span>
      </>
    }>
      {/* Keep the bulk draft and its pending confirmation alive while closed. */}
      <BulkTagBar {...props} />
    </LibraryDisclosure>
  );
}

export function LibraryTools({
  sets,
  activeSetId,
  onActiveSetChange,
  onCreateSet,
  canSaveCrate,
  onSaveCrate,
  pendingSoundCloud,
  onReviewSoundCloud,
}: {
  sets: readonly DJSet[];
  activeSetId: number | null;
  onActiveSetChange: (id: number | null) => void;
  onCreateSet: () => void;
  canSaveCrate: boolean;
  onSaveCrate: () => void;
  pendingSoundCloud: number;
  onReviewSoundCloud?: () => void;
}) {
  const preferences = useTablePreferences();
  return (
    <LibraryDisclosure label="Εργαλεία βιβλιοθήκης">
      <div className="flex flex-wrap items-center gap-2 px-1.5 pb-2 pt-1">
        <label htmlFor="library-active-set" className="text-xs text-cm-faint">Ενεργό set</label>
        <Select
          value={activeSetId === null ? "none" : String(activeSetId)}
          onValueChange={(value) => onActiveSetChange(value === "none" ? null : Number(value))}
        >
          <SelectTrigger id="library-active-set" className="h-7 min-w-0 max-w-full cursor-pointer rounded-lg px-2 py-1 text-xs text-cm-text">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">— κανένα —</SelectItem>
            {sets.map((set) => <SelectItem key={set.id} value={String(set.id)}>{set.title}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button type="button" variant="outline" size="sm" onClick={onCreateSet}>
          <Plus aria-hidden="true" /> Νέο set
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onSaveCrate} disabled={!canSaveCrate}>
          <Save aria-hidden="true" /> Αποθήκευση ως crate
        </Button>
        {onReviewSoundCloud && (
          <Button type="button" variant="outline" size="sm" onClick={onReviewSoundCloud}>
            <Radio aria-hidden="true" /> Έλεγχος SoundCloud
            <span className="rounded bg-cm-amber/15 px-1 font-mono text-[10px] tabular-nums">
              <NumberCount value={pendingSoundCloud} />
            </span>
          </Button>
        )}
        <Popover>
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" size="sm">
              <ListFilter aria-hidden="true" /> Στήλες
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64 p-3" aria-label="Εμφάνιση στηλών βιβλιοθήκης">
            <p className="mb-2 text-sm font-medium">Στήλες βιβλιοθήκης</p>
            <div className="max-h-[min(60vh,26rem)] overflow-y-auto">
              {LIBRARY_COLUMNS.map(column => (
                <label key={column.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1.5 text-xs hover:bg-cm-line/5 dark:hover:bg-white/5">
                  <input type="checkbox" className="size-3.5 accent-cm-cyan" checked={preferences.visibility[column.id]}
                    disabled={column.id === "track"}
                    onChange={event => tablePreferenceStore.setVisible(column.id, event.target.checked)} />
                  {columnLabel(column)}
                </label>
              ))}
            </div>
          </PopoverContent>
        </Popover>
        <Button type="button" variant="outline" size="sm"
          title="Επαναφορά πλάτους στηλών · οι επιλογές εμφάνισης διατηρούνται"
          onClick={() => tablePreferenceStore.resetWidths()}>
          <RotateCcw aria-hidden="true" /> Επαναφορά μεγεθών
        </Button>
      </div>
    </LibraryDisclosure>
  );
}
