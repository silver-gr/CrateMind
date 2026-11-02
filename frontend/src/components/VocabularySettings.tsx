import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { apiMessage, notifyFacetsChanged, useFacets } from "../lib/facets";
import type { Facet, FacetValue } from "../lib/types";
import { GlassPanel } from "./ui/GlassPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function tracksText(n: number): string {
  return n === 1 ? "1 κομμάτι" : `${n} κομμάτια`;
}

export function presetLoadedText(facets: number, values: number): string {
  const parts: string[] = [];
  if (facets) parts.push(facets === 1 ? "1 λεξιλόγιο" : `${facets} λεξιλόγια`);
  if (values) parts.push(values === 1 ? "1 τιμή" : `${values} τιμές`);
  if (!parts.length) return "Το προτεινόμενο λεξιλόγιο υπάρχει ήδη.";
  return `${facets + values === 1 ? "Προστέθηκε" : "Προστέθηκαν"} ${parts.join(" και ")}.`;
}

export function rewrittenSearchesText(n: number): string {
  return n === 1 ? "Ενημερώθηκε 1 αποθηκευμένη αναζήτηση." : `Ενημερώθηκαν ${n} αποθηκευμένες αναζητήσεις.`;
}

/** Settings > «Λεξιλόγια»: user vocabularies (facets) and their values. */
export function VocabularySettings() {
  const { facets, loaded } = useFacets();
  const [busy, setBusy] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newMulti, setNewMulti] = useState(true);
  const [confirm, setConfirm] = useState<{ message: string; run: () => Promise<unknown> } | null>(null);

  /** Run one vocabulary write; a 409 that needs confirmation opens the dialog with the server's message. */
  async function write(action: () => Promise<unknown>, forced?: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      notifyFacetsChanged();
      return true;
    } catch (error) {
      const message = apiMessage(error);
      if (forced && error instanceof Error && error.message.startsWith("409:")) setConfirm({ message, run: forced });
      else toast.error(message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function confirmForced() {
    if (!confirm) return;
    const run = confirm.run;
    setConfirm(null);
    await write(run);
  }

  async function createFacet() {
    const label = newLabel.trim();
    if (!label) return;
    if (await write(() => api.createFacet({ label, multi: newMulti }))) setNewLabel("");
  }

  async function loadPreset() {
    setBusy(true);
    try {
      const result = await api.loadFacetPreset("therapy");
      notifyFacetsChanged();
      toast.success(presetLoadedText(result.created_facets, result.created_values));
    } catch (error) {
      toast.error(apiMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <GlassPanel className="mb-4 space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold text-cm-text">Λεξιλόγια</h2>
          <p className="max-w-3xl text-xs text-cm-muted">
            Δικές σου κατηγορίες με τιμές (π.χ. «Θεραπευτικός στόχος: χαλάρωση»). Αποθηκεύονται μόνο στο CrateMind· τα αρχεία ήχου δεν αλλάζουν.
          </p>
        </div>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void loadPreset()}>
          Φόρτωση προτεινόμενου λεξιλογίου (μουσικοθεραπεία)
        </Button>
      </div>

      {loaded && facets.length === 0 && (
        <p className="text-xs text-cm-faint">Δεν υπάρχει λεξιλόγιο ακόμη. Φτιάξε ένα ή φόρτωσε το προτεινόμενο.</p>
      )}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {facets.map(facet => (
          <FacetCard key={facet.id} facet={facet} busy={busy} write={write} />
        ))}
      </div>

      <form
        className="flex flex-wrap items-center gap-3"
        onSubmit={event => { event.preventDefault(); void createFacet(); }}
      >
        <Input
          aria-label="Όνομα νέου λεξιλογίου"
          placeholder="Όνομα νέου λεξιλογίου…"
          value={newLabel}
          maxLength={80}
          disabled={busy}
          onChange={event => setNewLabel(event.target.value)}
          className="w-64"
        />
        <label className="flex items-center gap-2 text-xs text-cm-muted">
          <Switch size="sm" checked={newMulti} onCheckedChange={setNewMulti} aria-label="Πολλαπλή επιλογή" />
          Πολλαπλή επιλογή
        </label>
        <Button type="submit" size="sm" disabled={busy || !newLabel.trim()}>Νέο λεξιλόγιο</Button>
      </form>

      <Dialog open={confirm !== null} onOpenChange={open => { if (!open) setConfirm(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Επιβεβαίωση διαγραφής</DialogTitle>
            <DialogDescription>{confirm?.message}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>Ακύρωση</Button>
            <Button variant="destructive" disabled={busy} onClick={() => void confirmForced()}>Επιβεβαίωση</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </GlassPanel>
  );
}

function FacetCard({
  facet,
  busy,
  write,
}: {
  facet: Facet;
  busy: boolean;
  write: (action: () => Promise<unknown>, forced?: () => Promise<unknown>) => Promise<boolean>;
}) {
  const [label, setLabel] = useState(facet.label);
  const [newValue, setNewValue] = useState("");
  const [renaming, setRenaming] = useState<{ id: number; text: string } | null>(null);

  useEffect(() => setLabel(facet.label), [facet.label]);

  async function saveLabel() {
    const next = label.trim();
    if (!next || next === facet.label) { setLabel(facet.label); return; }
    if (!(await write(() => api.updateFacet(facet.id, { label: next })))) setLabel(facet.label);
  }

  async function addValue() {
    const value = newValue.trim();
    if (!value) return;
    if (await write(() => api.addFacetValue(facet.id, value))) setNewValue("");
  }

  async function rename(value: FacetValue) {
    const text = renaming?.text.trim() ?? "";
    setRenaming(null);
    if (!text || text === value.value) return;
    await write(async () => {
      const result = await api.renameFacetValue(value.id, text);
      if (result.rewritten_searches > 0) toast.success(rewrittenSearchesText(result.rewritten_searches));
    });
  }

  return (
    <div className="space-y-3 rounded-lg border border-cm-line/20 p-3">
      <div className="flex items-center gap-2">
        <Input
          aria-label="Όνομα λεξιλογίου"
          value={label}
          maxLength={80}
          disabled={busy}
          onChange={event => setLabel(event.target.value)}
          onBlur={() => void saveLabel()}
          onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }}
          className="h-8 text-sm"
        />
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          className="text-cm-rose"
          onClick={() => void write(() => api.deleteFacet(facet.id), () => api.deleteFacet(facet.id, true))}
        >Διαγραφή</Button>
      </div>
      <label className="flex items-center justify-between gap-2 text-xs text-cm-muted">
        Πολλαπλή επιλογή
        <Switch
          size="sm"
          checked={facet.multi}
          disabled={busy}
          aria-label="Πολλαπλή επιλογή"
          onCheckedChange={multi => void write(() => api.updateFacet(facet.id, { multi }))}
        />
      </label>
      <ul className="space-y-1">
        {facet.values.map(value => (
          <li key={value.id} className="flex items-center gap-2 text-xs">
            {renaming?.id === value.id ? (
              <Input
                autoFocus
                aria-label="Νέο όνομα τιμής"
                value={renaming.text}
                onChange={event => setRenaming({ id: value.id, text: event.target.value })}
                onBlur={() => void rename(value)}
                onKeyDown={event => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") setRenaming(null);
                }}
                className="h-7 flex-1 text-xs"
              />
            ) : (
              <span className="min-w-0 flex-1 truncate text-cm-text">{value.value}</span>
            )}
            <span className="shrink-0 font-mono text-[10px] tabular-nums text-cm-faint">{tracksText(value.count)}</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[11px]"
              disabled={busy}
              onClick={() => setRenaming({ id: value.id, text: value.value })}
            >Μετονομασία</Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[11px] text-cm-rose"
              disabled={busy}
              onClick={() => void write(() => api.deleteFacetValue(value.id), () => api.deleteFacetValue(value.id, true))}
            >Διαγραφή</Button>
          </li>
        ))}
      </ul>
      <form
        className="flex items-center gap-2"
        onSubmit={event => { event.preventDefault(); void addValue(); }}
      >
        <Input
          aria-label={`Νέα τιμή για ${facet.label}`}
          placeholder="Νέα τιμή…"
          value={newValue}
          maxLength={80}
          disabled={busy}
          onChange={event => setNewValue(event.target.value)}
          className="h-8 text-xs"
        />
        <Button type="submit" size="sm" variant="outline" disabled={busy || !newValue.trim()}>Προσθήκη τιμής</Button>
      </form>
    </div>
  );
}
