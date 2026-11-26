import { useRef } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";

interface Props {
  /** The set to delete; null keeps the dialog closed. */
  target: { title: string; trackCount: number } | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function deleteSetMessage(title: string, trackCount: number) {
  const tracks = trackCount === 1 ? "1 track" : `${trackCount} tracks`;
  return `Το set «${title}» (${tracks}) θα διαγραφεί μαζί με τις μεταβάσεις του. Τα tracks μένουν στη βιβλιοθήκη.`;
}

/** «Διαγραφή set…» confirmation; focus starts on Cancel. */
export default function DeleteSetDialog({ target, busy, onCancel, onConfirm }: Props) {
  const cancelButton = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open={target !== null} onOpenChange={open => { if (!open && !busy) onCancel(); }}>
      <DialogContent showCloseButton={false} onOpenAutoFocus={event => {
        event.preventDefault();
        cancelButton.current?.focus();
      }}>
        <DialogHeader>
          <DialogTitle>Διαγραφή set</DialogTitle>
          <DialogDescription>{target && deleteSetMessage(target.title, target.trackCount)}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button ref={cancelButton} variant="outline" disabled={busy} onClick={onCancel}>Ακύρωση</Button>
          <Button variant="destructive" disabled={busy} onClick={onConfirm}>{busy ? "Διαγραφή…" : "Διαγραφή"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
