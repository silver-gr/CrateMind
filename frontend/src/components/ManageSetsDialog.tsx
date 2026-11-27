import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { apiMessage } from "../lib/facets";
import {
  SET_SORT_LABELS, deleteSetsMessage, deleteSetsOneByOne, deleteSetsSummary, emptySetIds, setShownDate, visibleSets,
  type SetSort, type SetSortKey,
} from "../lib/manageSets";
import { formatSetDuration } from "../lib/setDuration";
import { Pencil, Search, Trash2 } from "../lib/icons";
import type { SetSummary } from "../lib/types";
import RenameSetDialog from "./RenameSetDialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Button } from "./ui/button";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The set open in the Set Builder, marked in the list. */
  openSetId: number | null;
  /** After a rename or a delete; `deleted` names the sets that are gone. */
  onChanged: (deleted: number[]) => void;
}

const tracks = (n: number) => (n === 1 ? "1 track" : `${n} tracks`);

function shownDate(set: SetSummary): string {
  const date = new Date(setShownDate(set));
  return Number.isNaN(date.getTime()) ? setShownDate(set)
    : date.toLocaleDateString("el-GR", { day: "numeric", month: "short", year: "numeric" });
}

/** «Διαχείριση sets…»: every set with its size and date; rename one, or delete several after one confirmation. */
export default function ManageSetsDialog({ open, onOpenChange, openSetId, onChanged }: Props) {
  const [sets, setSets] = useState<SetSummary[] | null>(null);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SetSort>({ key: "date", desc: true });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [renaming, setRenaming] = useState<SetSummary | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const cancelButton = useRef<HTMLButtonElement>(null);

  async function load() {
    try {
      setSets(await api.setSummaries());
    } catch (error) {
      toast.error("Δεν ήταν δυνατή η φόρτωση των sets", { description: apiMessage(error) });
      setSets([]);
    }
  }

  useEffect(() => {
    if (!open) return;
    setSets(null);
    setFilter("");
    setSelected(new Set());
    void load();
  }, [open]);

  const shown = visibleSets(sets ?? [], filter, sort);
  const empties = emptySetIds(shown);
  const chosen = (sets ?? []).filter(set => selected.has(set.id));

  function toggle(id: number) {
    setSelected(current => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  function sortBy(key: SetSortKey) {
    setSort(current => (current.key === key ? { key, desc: !current.desc } : { key, desc: key !== "name" }));
  }

  async function deleteChosen() {
    setDeleting(true);
    const result = await deleteSetsOneByOne(chosen.map(({ id, title }) => ({ id, title })));
    setDeleting(false);
    setConfirming(false);
    const summary = deleteSetsSummary(result);
    if (summary.ok) toast.success(summary.title);
    else toast.error(summary.title, { description: summary.description });
    // The ones that failed stay ticked, so another try is one click.
    setSelected(new Set(result.failed.map(set => set.id)));
    if (result.deleted.length) onChanged(result.deleted.map(set => set.id));
    await load();
  }

  return (
    <>
      <Dialog open={open} onOpenChange={next => { if (!deleting) onOpenChange(next); }}>
        <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Διαχείριση sets</DialogTitle>
            <DialogDescription>Όλα τα sets σου. Τσέκαρε όσα θέλεις να σβήσεις ή άλλαξε όνομα σε ένα. Τα tracks δεν αγγίζονται.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-40 flex-1">
              <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 z-10 size-4 -translate-y-1/2 text-cm-faint" />
              <Input value={filter} onChange={event => setFilter(event.target.value)} placeholder="φίλτρο ονόματος…"
                aria-label="Φίλτρο sets" className="h-8 pl-8 text-sm" />
            </div>
            <div role="group" aria-label="Ταξινόμηση" className="flex items-center gap-1">
              {(Object.keys(SET_SORT_LABELS) as SetSortKey[]).map(key => (
                <Button key={key} type="button" size="xs" variant={sort.key === key ? "soft" : "ghost"} aria-pressed={sort.key === key}
                  title={sort.key === key ? "Πάτα ξανά για αντίστροφη σειρά" : undefined} onClick={() => sortBy(key)}>
                  {SET_SORT_LABELS[key]}{sort.key === key && <span aria-hidden="true">{sort.desc ? "↓" : "↑"}</span>}
                </Button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Button type="button" size="xs" variant="outline" disabled={!empties.length}
              onClick={() => setSelected(current => new Set([...current, ...empties]))}>
              Επιλογή όλων των κενών{empties.length ? ` (${empties.length})` : ""}
            </Button>
            {selected.size > 0 && (
              <Button type="button" size="xs" variant="ghost" onClick={() => setSelected(new Set())}>Καθαρισμός επιλογής</Button>
            )}
            <span className="ml-auto text-cm-faint" aria-live="polite">{chosen.length ? `Επιλεγμένα: ${chosen.length}` : ""}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-cm-contrast/10">
            {sets === null ? <p className="p-4 text-sm text-cm-faint">Φόρτωση…</p>
              : !shown.length ? <p className="p-4 text-sm text-cm-faint">{sets.length ? "Κανένα set δεν ταιριάζει στο φίλτρο." : "Δεν υπάρχουν sets."}</p>
                : (
                  <ul className="divide-y divide-cm-contrast/8">
                    {shown.map(set => (
                      <li key={set.id} className="flex items-center gap-3 px-3 py-2 hover:bg-cm-contrast/[0.03]">
                        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                          <input type="checkbox" className="size-4 shrink-0 accent-cm-cyan" checked={selected.has(set.id)} onChange={() => toggle(set.id)} />
                          <span className="min-w-0 flex-1">
                            <span className="flex min-w-0 items-center gap-2">
                              <span className="truncate text-sm text-cm-text">{set.title}</span>
                              {set.id === openSetId && <span className="shrink-0 rounded border border-cm-cyan/30 px-1 text-[10px] text-cm-cyan">ανοιχτό</span>}
                            </span>
                            <span className="block text-xs text-cm-faint">
                              {set.track_count ? `${tracks(set.track_count)} · ${formatSetDuration(set.duration_seconds)}` : "κενό"} · {shownDate(set)}
                            </span>
                          </span>
                        </label>
                        <Button type="button" size="icon-sm" variant="ghost" aria-label={`Μετονομασία «${set.title}»`} title="Μετονομασία…"
                          onClick={() => setRenaming(set)}>
                          <Pencil />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Κλείσιμο</Button>
            <Button type="button" variant="destructive" disabled={!chosen.length} onClick={() => setConfirming(true)}>
              <Trash2 /> Διαγραφή επιλεγμένων…
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={confirming} onOpenChange={next => { if (!next && !deleting) setConfirming(false); }}>
        <DialogContent showCloseButton={false} onOpenAutoFocus={event => { event.preventDefault(); cancelButton.current?.focus(); }}>
          <DialogHeader>
            <DialogTitle>{chosen.length === 1 ? "Διαγραφή set" : `Διαγραφή ${chosen.length} sets`}</DialogTitle>
            <DialogDescription>{deleteSetsMessage(chosen.length)}</DialogDescription>
          </DialogHeader>
          <ul className="max-h-48 list-disc space-y-0.5 overflow-y-auto pl-5 text-sm text-cm-text">
            {chosen.map(set => <li key={set.id}>{set.title} <span className="text-cm-faint">({tracks(set.track_count)})</span></li>)}
          </ul>
          <DialogFooter>
            <Button ref={cancelButton} variant="outline" disabled={deleting} onClick={() => setConfirming(false)}>Ακύρωση</Button>
            <Button variant="destructive" disabled={deleting} onClick={() => { void deleteChosen(); }}>{deleting ? "Διαγραφή…" : "Διαγραφή"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <RenameSetDialog target={renaming} onCancel={() => setRenaming(null)} onRenamed={() => {
        setRenaming(null);
        onChanged([]);
        void load();
      }} />
    </>
  );
}
