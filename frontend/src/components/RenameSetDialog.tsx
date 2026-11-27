import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { apiMessage } from "../lib/facets";
import type { DJSet } from "../lib/types";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Button } from "./ui/button";

interface Props {
  /** The set to rename; null keeps the dialog closed. */
  target: { id: number; title: string } | null;
  onCancel: () => void;
  onRenamed: (set: DJSet) => void;
}

/** «Μετονομασία set»: a name field that starts with the current name. */
export default function RenameSetDialog({ target, onCancel, onRenamed }: Props) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (target) setTitle(target.title); }, [target]);
  const trimmed = title.trim();

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!target || !trimmed || busy) return;
    if (trimmed === target.title) { onCancel(); return; }
    setBusy(true);
    try {
      const renamed = await api.renameSet(target.id, trimmed);
      toast.success(`Το set λέγεται τώρα «${renamed.title}»`);
      onRenamed(renamed);
    } catch (error) {
      toast.error("Δεν ήταν δυνατή η μετονομασία του set", { description: apiMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={target !== null} onOpenChange={open => { if (!open && !busy) onCancel(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Μετονομασία set</DialogTitle></DialogHeader>
        <form onSubmit={save} className="space-y-4">
          <label className="block space-y-2">Νέο όνομα
            <Input autoFocus required value={title} onChange={event => setTitle(event.target.value)}
              onFocus={event => event.currentTarget.select()} />
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>Ακύρωση</Button>
            <Button type="submit" disabled={busy || !trimmed}>{busy ? "Αποθήκευση…" : "Μετονομασία"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
