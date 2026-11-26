import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Button } from "../components/ui/button";
import { api } from "./api";

type RepeatsChoice = "cancel" | "skip" | "all";

/** Shared by every interactive entry point; copying an entire set keeps its repeats. */
export function useSetTrackAddition() {
  const busy = useRef(false);
  const mounted = useRef(true);
  const answer = useRef<((confirmed: boolean) => void) | null>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const repeatsCancelButton = useRef<HTMLButtonElement>(null);
  const [duplicate, setDuplicate] = useState<{ track: string; set: string } | null>(null);
  const repeatsAnswer = useRef<((choice: RepeatsChoice) => void) | null>(null);
  const [repeats, setRepeats] = useState<{ count: number; total: number; set: string } | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      answer.current?.(false);
      answer.current = null;
      repeatsAnswer.current?.("cancel");
      repeatsAnswer.current = null;
    };
  }, []);

  function respond(confirmed: boolean) {
    const resolve = answer.current;
    answer.current = null;
    setDuplicate(null);
    resolve?.(confirmed);
  }

  function respondRepeats(choice: RepeatsChoice) {
    const resolve = repeatsAnswer.current;
    repeatsAnswer.current = null;
    setRepeats(null);
    resolve?.(choice);
  }

  /** Several tracks in order (a selection): one question for all repeats. Resolves to how many were added, or null. */
  async function addManyToSet(setId: number, trackIds: number[]): Promise<number | null> {
    if (busy.current) return null;
    busy.current = true;
    let added = 0;
    try {
      const current = await api.getSet(setId);
      if (!mounted.current) return null;
      const present = new Set(current.tracks.map(row => row.track.id));
      const count = trackIds.filter(id => present.has(id)).length;
      let ids = trackIds;
      if (count > 0) {
        const choice = await new Promise<RepeatsChoice>(resolve => {
          repeatsAnswer.current = resolve;
          setRepeats({ count, total: trackIds.length, set: current.set.title });
        });
        if (choice === "cancel" || !mounted.current) return null;
        if (choice === "skip") ids = trackIds.filter(id => !present.has(id));
      }
      for (const id of ids) {
        await api.addSetTrack(setId, id);
        added++;
      }
      return added;
    } catch {
      if (mounted.current) toast.error(added ? `Προστέθηκαν ${added} από τα ${trackIds.length}· τα υπόλοιπα όχι` : "Δεν ήταν δυνατή η προσθήκη στο set");
      return null;
    } finally {
      busy.current = false;
    }
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

  const duplicateDialog = (<>
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
    <Dialog open={repeats !== null} onOpenChange={open => { if (!open) respondRepeats("cancel"); }}>
      <DialogContent showCloseButton={false} onOpenAutoFocus={event => {
        event.preventDefault();
        repeatsCancelButton.current?.focus();
      }}>
        <DialogHeader>
          <DialogTitle>Κάποια tracks υπάρχουν ήδη στο set</DialogTitle>
          <DialogDescription>
            {repeats?.count} από τα {repeats?.total} υπάρχουν ήδη στο «{repeats?.set}».
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button ref={repeatsCancelButton} variant="outline" onClick={() => respondRepeats("cancel")}>Ακύρωση</Button>
          <Button variant="outline" onClick={() => respondRepeats("skip")}>Χωρίς τα διπλά</Button>
          <Button onClick={() => respondRepeats("all")}>Προσθήκη όλων</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
  return { addToSet, addManyToSet, duplicateDialog };
}
