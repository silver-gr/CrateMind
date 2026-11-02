import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { apiMessage, notifyFacetsChanged, useFacets } from "../lib/facets";
import { axisLabel, type Axis } from "../lib/labels";
import { getPref } from "../lib/prefs";
import { buildBatchRequest, bulkFacets, changeSummary, confirmText, keepOnePerSingleFacet, withDryRun, type BatchScope } from "../lib/selection";
import type { BatchEditRequest, Facet, FacetValue, Profile } from "../lib/types";
import { FacetEditor } from "./FacetEditor";
import { SmartChip } from "./ui/SmartChip";
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

/**
 * Library bulk bar: add or remove vocabulary values (and optionally set the
 * shared axes) on the selected rows or on every result of the applied query.
 * The server's dry-run count is confirmed before anything is written.
 */
export function BulkTagBar({
  selectedIds,
  query,
  onApplied,
}: {
  selectedIds: ReadonlySet<number>;
  /** The submitted query that drives the shown rows (never the draft input). */
  query: string;
  onApplied: () => void | Promise<void>;
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
    if (next === "add") setPending(current => keepOnePerSingleFacet(current, facets));
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
      <span className="text-cm-faint">Μαζική αλλαγή:</span>
      <SmartChip
        tone={effectiveScope === "selected" ? "cyan" : "muted"}
        active={effectiveScope === "selected"}
        pressed={effectiveScope === "selected"}
        onClick={selectedIds.size > 0 && !busy ? () => setScope("selected") : undefined}
        className={selectedIds.size === 0 ? "opacity-50" : undefined}
      >
        Επιλεγμένα ({selectedIds.size.toLocaleString("el-GR")})
      </SmartChip>
      <SmartChip
        tone={effectiveScope === "all" ? "cyan" : "muted"}
        active={effectiveScope === "all"}
        pressed={effectiveScope === "all"}
        onClick={busy ? undefined : () => setScope("all")}
      >
        Όλα τα αποτελέσματα ({allCount === null ? "…" : allCount.toLocaleString("el-GR")})
      </SmartChip>
      <span aria-hidden="true" className="mx-1 h-4 w-px bg-white/10" />
      <SmartChip tone={mode === "add" ? "violet" : "muted"} active={mode === "add"} pressed={mode === "add"} onClick={busy ? undefined : () => chooseMode("add")}>
        Προσθήκη τιμών
      </SmartChip>
      <SmartChip tone={mode === "remove" ? "rose" : "muted"} active={mode === "remove"} pressed={mode === "remove"} onClick={busy ? undefined : () => chooseMode("remove")}>
        Αφαίρεση τιμών
      </SmartChip>
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
      <Button type="button" size="sm" className="h-7 px-3 text-xs" disabled={busy || changes === 0} onClick={() => void preparePreview()}>
        Εφαρμογή
      </Button>

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
