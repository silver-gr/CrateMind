import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Button } from "../components/ui/button";
import { api } from "./api";

/** Shared by every interactive entry point; copying an entire set keeps its repeats. */
export function useSetTrackAddition() {
  const busy = useRef(false);
  const mounted = useRef(true);
  const answer = useRef<((confirmed: boolean) => void) | null>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const [duplicate, setDuplicate] = useState<{ track: string; set: string } | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      answer.current?.(false);
      answer.current = null;
    };
  }, []);

  function respond(confirmed: boolean) {
    const resolve = answer.current;
    answer.current = null;
    setDuplicate(null);
    resolve?.(confirmed);
  }

  async function addToSet(setId: number, trackId: number): Promise<boolean> {
    if (busy.current) return false;
    busy.current = true;
    try {
      // Read current membership, including edits made outside this screen.
      const current = await api.getSet(setId);
      if (!mounted.current) return false;
      const existing = current.tracks.find(row => row.track.id === trackId);
      if (existing) {
        const confirmed = await new Promise<boolean>(resolve => {
          answer.current = resolve;
          setDuplicate({ track: existing.track.title || existing.track.file_name, set: current.set.title });
        });
        if (!confirmed || !mounted.current) return false;
      }
      await api.addSetTrack(setId, trackId);
      return true;
    } catch {
      if (mounted.current) toast.error("Δεν ήταν δυνατή η προσθήκη στο set");
      return false;
    } finally {
      busy.current = false;
    }
  }

  const duplicateDialog = (
    <Dialog open={duplicate !== null} onOpenChange={open => { if (!open) respond(false); }}>
      <DialogContent showCloseButton={false} onOpenAutoFocus={event => {
        event.preventDefault();
        cancelButton.current?.focus();
      }}>
        <DialogHeader>
          <DialogTitle>Το track υπάρχει ήδη στο set</DialogTitle>
          <DialogDescription>
            Το «{duplicate?.track}» υπάρχει ήδη στο «{duplicate?.set}». Θέλεις να το προσθέσεις ξανά;
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button ref={cancelButton} variant="outline" onClick={() => respond(false)}>Ακύρωση</Button>
          <Button onClick={() => respond(true)}>Προσθήκη ξανά</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
  return { addToSet, duplicateDialog };
}
