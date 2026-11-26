import { useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { analysisProgress, canStopAnalysis, reanalysisDuration } from "../lib/analysisRun";
import type { Job } from "../lib/types";
import { Loader2, RefreshCw } from "../lib/icons";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { SettingRow } from "./settings/SettingRow";

/** «Επανανάλυση» with a confirmation that says what a full run does; focus starts on «Ακύρωση». */
export function ReanalyzeButton({ disabled, onConfirm }: { disabled: boolean; onConfirm: () => void }) {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);

  function openDialog() {
    setCount(null);
    setOpen(true);
    api.trackCount("-missing").then(result => setCount(result.count), () => setCount(null));
  }

  function confirm() {
    setOpen(false);
    onConfirm();
  }

  const tracks = count === null ? "σε όλα τα tracks" : count === 1 ? "στο 1 track" : `σε όλα τα ${count.toLocaleString("el-GR")} tracks`;
  return (
    <>
      <Button onClick={openDialog} disabled={disabled} variant="outline" size="sm">
        <RefreshCw className="h-3.5 w-3.5" />
        Επανανάλυση
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton={false} onOpenAutoFocus={event => {
          event.preventDefault();
          cancelButton.current?.focus();
        }}>
          <DialogHeader>
            <DialogTitle>Επανανάλυση όλης της βιβλιοθήκης;</DialogTitle>
            <DialogDescription>
              Μετράει ξανά BPM, key, beatgrid και ένταση (LUFS) {tracks} της βιβλιοθήκης.
            </DialogDescription>
          </DialogHeader>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-cm-muted">
            <li>
              Διαρκεί {count === null ? "αρκετή ώρα" : reanalysisDuration(count)}. Μπορείς να τη σταματήσεις με «Διακοπή»· όσα
              tracks έχουν τελειώσει κρατιούνται.
            </li>
            <li>Όσα έχεις ορίσει εσύ μένουν όπως είναι: το BPM που διόρθωσες με το χέρι, τα cues, τα sets και τα tags.</li>
            <li>Μερικά tracks μπορεί να βγουν με άλλο BPM, συνήθως διπλάσιο. Το διορθώνεις με «×½».</li>
            <li>Αν απλώς πρόσθεσες μουσική, αρκεί το «BPM + Key · μόνο νέα».</li>
            <li>Ο δίσκος με τη μουσική πρέπει να μείνει συνδεδεμένος μέχρι να τελειώσει.</li>
          </ul>
          <DialogFooter>
            <Button ref={cancelButton} variant="outline" onClick={() => setOpen(false)}>Ακύρωση</Button>
            <Button onClick={confirm}>Επανανάλυση</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Progress and «Διακοπή» while a BPM/key analysis runs; nothing otherwise. */
export function AnalysisStopRow({ job }: { job: Job | null }) {
  const [stopping, setStopping] = useState<number | null>(null);
  if (!job || !canStopAnalysis(job)) return null;
  const current = job;

  async function stop() {
    setStopping(current.id);
    try {
      await api.stopAnalyze(current.id);
    } catch (error) {
      setStopping(null);
      toast.error((error as Error).message);
    }
  }

  return (
    <SettingRow
      label="Ανάλυση σε εξέλιξη"
      help={`Πρόοδος: ${analysisProgress(job)}. Η «Διακοπή» τη σταματά μόλις τελειώσουν τα tracks που αναλύονται τώρα· όσα έχουν τελειώσει κρατιούνται.`}
    >
      <Button variant="outline" size="sm" disabled={stopping === job.id} onClick={stop}>
        {stopping === job.id ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Σταματά…</> : "Διακοπή"}
      </Button>
    </SettingRow>
  );
}
