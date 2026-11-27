import { ListFilter, Plus, Radio, RotateCcw, Save } from "../lib/icons";
import { LIBRARY_COLUMNS, columnLabel } from "../lib/tablePreferences";
import type { DJSet } from "../lib/types";
import { tablePreferenceStore, useTablePreferences } from "../lib/useTablePreferences";
import { Button } from "./ui/button";
import { NumberCount } from "./ui/NumberCount";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

/** The section's buttons at the size of «Μαζική επεξεργασία»'s (28 px, 12 px text), so the toolbar's sections share one row height. */
const TOOL = "h-7 px-2 text-xs";

/** «Εργαλεία βιβλιοθήκης», the body of the Library toolbar's third section: the active set, crates, SoundCloud review, columns. */
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
    <div className="flex flex-wrap items-center gap-2">
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
      <Button type="button" variant="outline" size="sm" className={TOOL} onClick={onCreateSet}>
        <Plus aria-hidden="true" /> Νέο set
      </Button>
      <Button type="button" variant="outline" size="sm" className={TOOL} onClick={onSaveCrate} disabled={!canSaveCrate}>
        <Save aria-hidden="true" /> Αποθήκευση ως crate
      </Button>
      {onReviewSoundCloud && (
        <Button type="button" variant="outline" size="sm" className={TOOL} onClick={onReviewSoundCloud}>
          <Radio aria-hidden="true" /> Έλεγχος SoundCloud
          <span className="rounded bg-cm-amber/15 px-1 font-mono text-[10px] tabular-nums">
            <NumberCount value={pendingSoundCloud} />
          </span>
        </Button>
      )}
      <Popover>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" size="sm" className={TOOL}>
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
      <Button type="button" variant="outline" size="sm" className={TOOL}
        title="Επαναφορά πλάτους στηλών · οι επιλογές εμφάνισης διατηρούνται"
        onClick={() => tablePreferenceStore.resetWidths()}>
        <RotateCcw aria-hidden="true" /> Επαναφορά μεγεθών
      </Button>
    </div>
  );
}
