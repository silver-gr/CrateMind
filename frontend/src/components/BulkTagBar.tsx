import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { apiMessage, notifyFacetsChanged, useFacets } from "../lib/facets";
import { axisLabel, type Axis } from "../lib/labels";
import { getPref } from "../lib/prefs";
import { buildBatchRequest, bulkFacets, changeSummary, confirmText, switchMode, withDryRun, type BatchScope } from "../lib/selection";
import type { BatchEditRequest, Facet, FacetValue, Profile } from "../lib/types";
import { AnalyzeBpmDialog } from "./AnalyzeBpmDialog";
import { FacetEditor } from "./FacetEditor";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const SCALE = Array.from({ length: 10 }, (_, i) => String(i + 1));

/* Segmented scope/mode controls: one field-coloured track, the pressed segment lit in its accent. */
const SEG_GROUP = "inline-flex items-center rounded-lg border surface-field p-0.5";
const SEG = "h-6 cursor-pointer rounded-md px-2.5 text-xs font-medium text-cm-muted transition-[background-color,color,box-shadow] duration-150 hover:text-cm-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-cyan/60 disabled:pointer-events-none disabled:opacity-40";
const SEG_ON = {
  cyan: "aria-pressed:bg-cm-cyan/14 aria-pressed:text-cm-cyan aria-pressed:shadow-[inset_0_0_0_1px_oklch(from_var(--cm-cyan)_l_c_h/0.3)]",
  violet: "aria-pressed:bg-cm-violet/14 aria-pressed:text-cm-violet aria-pressed:shadow-[inset_0_0_0_1px_oklch(from_var(--cm-violet)_l_c_h/0.3)]",
  rose: "aria-pressed:bg-cm-rose/14 aria-pressed:text-cm-rose aria-pressed:shadow-[inset_0_0_0_1px_oklch(from_var(--cm-rose)_l_c_h/0.3)]",
} as const;

/**
 * Library bulk bar: add or remove vocabulary values (and optionally set the
 * shared axes) on the selected rows or on every result of the applied query.
 * The server's dry-run count is confirmed before anything is written.
 */
export function BulkTagBar({
  selectedIds,
  query,
  onApplied,
  canAnalyze = false,
}: {
  selectedIds: ReadonlySet<number>;
  /** The submitted query that drives the shown rows (never the draft input). */
  query: string;
  onApplied: () => void | Promise<void>;
  /** `capabilities.analysis`: shows «Ανάλυση BPM» on the same scope. */
  canAnalyze?: boolean;
}) {
  const { facets } = useFacets();
  // The page remounts on a profile switch, so reading the pref here is enough.
  const axes: Axis[] = getPref("libraryProfile") === "therapy" ? ["energy", "valence"] : ["energy", "darkness"];
  const [scope, setScope] = useState<BatchScope>("selected");
  const [mode, setMode] = useState<"add" | "remove">("add");
  const [pending, setPending] = useState<Set<number>>(new Set());
  const [profile, setProfile] = useState<Partial<Profile>>({});
  const [allCount, setAllCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ request: BatchEditRequest; text: string } | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  const effectiveScope: BatchScope = selectedIds.size === 0 ? "all" : scope;

  useEffect(() => {
    let alive = true;
    setAllCount(null);
    api.trackCount(query).then(r => { if (alive) setAllCount(r.count); }).catch(() => {});
    return () => { alive = false; };
  }, [query]);

  function toggle(facet: Facet, value: FacetValue, next: boolean) {
    setPending(current => {
      const out = new Set(current);
      if (next && mode === "add" && !facet.multi) for (const v of facet.values) out.delete(v.id);
      if (next) out.add(value.id);
      else out.delete(value.id);
      return out;
    });
  }

  function chooseMode(next: "add" | "remove") {
    setMode(next);
    setPending(current => switchMode(current, facets, next));
  }

  function setAxis(axis: Axis, raw: string) {
    setProfile(current => {
      const out = { ...current };
      if (raw === "none") delete out[axis];
      else out[axis] = Number(raw);
      return out;
    });
  }

  const changes = pending.size + Object.keys(profile).length;

  async function preparePreview() {
    const request = buildBatchRequest({
      scope: effectiveScope, selectedIds, query, mode, tagIds: [...pending], profile, dryRun: true,
    });
    setBusy(true);
    try {
      const result = await api.batchEdit(request);
      const values = facets.flatMap(f => f.values.filter(v => pending.has(v.id)).map(v => v.value));
      const axisChanges = axes.filter(axis => profile[axis] != null).map(axis => [axisLabel(axis), profile[axis] as number] as const);
      setPreview({ request, text: `${changeSummary(mode, values, axisChanges)} ${confirmText(result)}` });
    } catch (error) {
      toast.error(apiMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!preview) return;
    setBusy(true);
    try {
      const result = await api.batchEdit(withDryRun(preview.request, false));
      toast.success(result.updated === 1 ? "Ενημερώθηκε 1 κομμάτι" : `Ενημερώθηκαν ${result.updated.toLocaleString("el-GR")} κομμάτια`);
      setPreview(null);
      setPending(new Set());
      setProfile({});
      notifyFacetsChanged();
      await onApplied();
      api.trackCount(query).then(r => setAllCount(r.count)).catch(() => {});
    } catch (error) {
      toast.error(apiMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="group" className="mt-3 flex flex-wrap items-center gap-2 text-xs" aria-label="Μαζική αλλαγή">
      <span className="micro-label text-cm-faint">Μαζική αλλαγή</span>
      <div role="group" aria-label="Εύρος αλλαγής" className={SEG_GROUP}>
        <button
          type="button"
          aria-pressed={effectiveScope === "selected"}
          disabled={selectedIds.size === 0 || busy}
          onClick={() => setScope("selected")}
          className={`${SEG} ${SEG_ON.cyan}`}
        >
          Επιλεγμένα ({selectedIds.size.toLocaleString("el-GR")})
        </button>
        <button
          type="button"
          aria-pressed={effectiveScope === "all"}
          disabled={busy}
          onClick={() => setScope("all")}
          className={`${SEG} ${SEG_ON.cyan}`}
        >
          Όλα τα αποτελέσματα ({allCount === null ? "…" : allCount.toLocaleString("el-GR")})
        </button>
      </div>
      <div role="group" aria-label="Τύπος αλλαγής" className={SEG_GROUP}>
        <button type="button" aria-pressed={mode === "add"} disabled={busy} onClick={() => chooseMode("add")} className={`${SEG} ${SEG_ON.violet}`}>
          Προσθήκη τιμών
        </button>
        <button type="button" aria-pressed={mode === "remove"} disabled={busy} onClick={() => chooseMode("remove")} className={`${SEG} ${SEG_ON.rose}`}>
          Αφαίρεση τιμών
        </button>
      </div>
      <Popover>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={busy}>
            Τιμές{changes > 0 ? ` (${changes})` : ""}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="max-h-[70vh] w-96 space-y-4 overflow-y-auto p-3">
          {facets.length > 0
            ? <FacetEditor facets={bulkFacets(facets, mode)} selected={pending} onToggle={toggle} disabled={busy} />
            : <p className="text-xs text-cm-faint">Δεν υπάρχουν λεξιλόγια ακόμη. Φτιάξε ένα από τις Ρυθμίσεις.</p>}
          <div className="grid grid-cols-2 gap-3">
            {axes.map(axis => (
              <label key={axis} className="block space-y-1 text-[11px] font-medium uppercase tracking-wider text-cm-faint">
                {axisLabel(axis)}
                <Select value={profile[axis] != null ? String(profile[axis]) : "none"} onValueChange={v => setAxis(axis, v)} disabled={busy}>
                  <SelectTrigger size="sm" className="w-full text-xs" aria-label={axisLabel(axis)}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Χωρίς αλλαγή</SelectItem>
                    {SCALE.map(v => <SelectItem key={v} value={v}>{v}</SelectItem>)}
                  </SelectContent>
                </Select>
              </label>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      <div className="ml-auto flex items-center gap-2">
        {canAnalyze && <>
          <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={busy} onClick={() => setAnalyzing(true)}>
            Ανάλυση BPM
          </Button>
          <AnalyzeBpmDialog
            scope={effectiveScope === "selected" ? { trackIds: [...selectedIds] } : { query }}
            open={analyzing}
            onOpenChange={setAnalyzing}
            onDone={onApplied}
          />
        </>}
        <Button type="button" size="sm" className="h-7 px-3 text-xs" disabled={busy || changes === 0} onClick={() => void preparePreview()}>
          Εφαρμογή
        </Button>
      </div>

      <Dialog open={preview !== null} onOpenChange={open => { if (!open && !busy) setPreview(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Επιβεβαίωση μαζικής αλλαγής</DialogTitle>
            <DialogDescription>{preview?.text}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setPreview(null)}>Ακύρωση</Button>
            <Button disabled={busy} onClick={() => void confirm()}>{busy ? "Εφαρμογή…" : "Επιβεβαίωση"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
