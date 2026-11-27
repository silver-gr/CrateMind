import { useRef } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";

/** The confirmation of a bulk action on /names, after its dry run counted the tracks; focus starts on Cancel. */
export function BulkConfirmDialog({ confirm, busy, onCancel, onConfirm }: {
  /** null keeps the dialog closed. */
  confirm: { title: string; text: string; button: string } | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open={confirm !== null} onOpenChange={open => { if (!open && !busy) onCancel(); }}>
      <DialogContent showCloseButton={false} onOpenAutoFocus={event => {
        event.preventDefault();
        cancel.current?.focus();
      }}>
        <DialogHeader>
          <DialogTitle>{confirm?.title}</DialogTitle>
          <DialogDescription>{confirm?.text}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button ref={cancel} variant="outline" disabled={busy} onClick={onCancel}>Ακύρωση</Button>
          <Button variant="soft" disabled={busy} onClick={onConfirm}>{busy ? "Γίνεται…" : confirm?.button}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
