import { useEffect, useState, useRef } from "react";
import { invalidateCollectionOptions } from "../lib/collectionOptions";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import CollectionPicker from "./CollectionPicker";
import { Choice, identityRequest, availabilityLabels, type Recording } from "./CompletenessControls";
type Preview = {
  total: number;
  items: Recording[];
  saved_collection_id?: string;
  overlap: null | { shared: number; only_left: number; only_right: number; jaccard_percent: number };
};
function CollectionAlgebraContent({
  left,
  onSaved,
  embedded = false,
}: {
  left: string;
  onSaved: (id: string) => void;
  embedded?: boolean;
}) {
  const [right, setRight] = useState(""),
    [operation, setOperation] = useState("union"),
    [exclude, setExclude] = useState(false),
    [name, setName] = useState(""),
    [preview, setPreview] = useState<Preview | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const current = useRef("");
  current.current = JSON.stringify([left, right, operation, exclude]);
  useEffect(() => {
    setPreview(null);
    setError("");
  }, [left, right, operation, exclude]);
  async function run(save = false) {
    const key = current.current;
    setBusy(true);
    setError("");
    try {
      const value = await identityRequest<Preview>("collections/algebra", {
        collection_ids: right ? [left, right] : [left],
        operation,
        exclude_playable: exclude,
        ...(save ? { save_name: name } : {}),
      });
      if (value.saved_collection_id) invalidateCollectionOptions();
      if (key !== current.current) return;
      setPreview(value);
      if (value.saved_collection_id) onSaved(value.saved_collection_id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const Container = embedded ? "div" : "details";
  return (
    <Container className={embedded ? "space-y-3" : "space-y-3 rounded-xl border border-cm-border p-3"}>
      {!embedded && <summary className="cursor-pointer font-medium">Σύγκριση & πράξεις συλλογών</summary>}
      <p className="text-xs text-cm-muted">Αριστερή πηγή: η επιλεγμένη συλλογή. </p>
      <fieldset disabled={busy} className="flex flex-wrap gap-2">
        <CollectionPicker label="Δεξιά συλλογή (προαιρετική)" value={right} onChange={setRight} />
        <Choice
          label="Πράξη συλλογών"
          value={operation}
          onChange={setOperation}
          options={{ union: "Ένωση", intersection: "Τομή", difference: "Αριστερή μείον δεξιά" }}
        />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={exclude} onChange={(e) => setExclude(e.target.checked)} />
          Αφαίρεση όσων παίζουν τοπικά
        </label>
        <Button disabled={!left || busy} onClick={() => run()}>
          Προεπισκόπηση
        </Button>
      </fieldset>
      <p className="text-xs text-cm-muted">
        Μία θέση ανά κανονική ηχογράφηση. Τομή/διαφορά: σειρά αριστερής πηγής. Ένωση: πρώτη εμφάνιση αριστερά και μετά νέες ηχογραφήσεις
        δεξιά. Μία πηγή: κανονική αποδιπλοποίηση.
      </p>
      {error && <p role="alert">{error}</p>}
      {preview && (
        <>
          <p>{preview.total} ηχογραφήσεις</p>
          {preview.overlap && (
            <p className="text-sm">
              {preview.overlap.jaccard_percent}% κοινό περιεχόμενο (κοινές / ένωση) · {preview.overlap.shared} κοινές ·{" "}
              {preview.overlap.only_left} μόνο αριστερά · {preview.overlap.only_right} μόνο δεξιά
            </p>
          )}
          <div className="flex gap-2">
            <Input
              aria-label="Όνομα παράγωγης συλλογής"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Όνομα νέας συλλογής CrateMind"
              maxLength={200}
            />
            <Button disabled={!name.trim() || busy} onClick={() => run(true)}>
              Αποθήκευση νέας
            </Button>
          </div>
          <ol className="max-h-80 overflow-y-auto text-sm">
            {preview.items.map((r, i) => (
              <li className="py-1" key={r.recording_id}>
                {i + 1}. {r.artist} — {r.title} <span className="text-xs text-cm-muted">{availabilityLabels[r.availability.state]}</span>
              </li>
            ))}
          </ol>
        </>
      )}
    </Container>
  );
}

export default function CollectionAlgebra(props: { left: string; onSaved: (id: string) => void; embedded?: boolean }) {
  const [open, setOpen] = useState(false);
  if (props.embedded) return <CollectionAlgebraContent {...props} />;
  return (
    <details className="rounded-lg border border-cm-border p-3" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer font-medium">Σύγκριση & πράξεις συλλογών</summary>
      {open && <CollectionAlgebraContent {...props} embedded />}
    </details>
  );
}
