import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { ANALYSIS_FINISHED } from "../lib/bpmUpdates";
import { apiMessage } from "../lib/facets";
import { pollJob, type JobConnection } from "../lib/jobPolling";
import { translateJobMessage } from "../lib/labels";
import { getPref } from "../lib/prefs";
import { activeTempoRange, DJ_RANGE_KEYS, TEMPO_RANGE_LABELS, type TempoRangeKey } from "../lib/tempoRanges";
import type { Job } from "../lib/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type AnalyzeScope = { trackIds: number[] } | { query: string };

/** «{done} / {n}»; `n` is the job's total, or the dry-run count until the job reports one. */
export function jobProgressText(job: Job, matched?: number | null): string {
  const done = job.processed.toLocaleString("el-GR");
  const total = job.total ?? matched;
  return total == null ? done : `${done} / ${total.toLocaleString("el-GR")}`;
}

/**
 * «Ανάλυση BPM» on a selection, a search or a crate: confirms the server's
 * dry-run count, starts a scoped (primary-only) analysis with the chosen
 * window, follows it to the end, then reloads the caller's rows. Closing the
 * dialog while the job runs only hides it: the job is followed to the end anyway.
 */
export function AnalyzeBpmDialog({
  scope,
  open,
  onOpenChange,
  onDone,
}: {
  scope: AnalyzeScope;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void | Promise<void>;
}) {
  const therapy = getPref("libraryProfile") === "therapy";
  const [range, setRange] = useState<TempoRangeKey>(activeTempoRange);
  const [matched, setMatched] = useState<number | null>(null);
  const [countError, setCountError] = useState("");
  const [starting, setStarting] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [connection, setConnection] = useState<JobConnection>("connected");
  const openRef = useRef(open);
  openRef.current = open;
  const running = starting || job !== null;
  const scopeKey = JSON.stringify(scope);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setRange(activeTempoRange());
    setMatched(null);
    setCountError("");
    api.analyzeDryRun({ tempoRange: activeTempoRange(), ...scope })
      .then(result => { if (alive) setMatched(result.matched); })
      .catch(error => { if (alive) setCountError(apiMessage(error)); });
    return () => { alive = false; };
    // The scope is compared by value: callers pass a fresh object on every render.
  }, [open, scopeKey]);

  async function start() {
    setStarting(true);
    let started: Job;
    try {
      started = await api.startAnalyze({ tempoRange: range, ...scope });
    } catch (error) {
      toast.error(apiMessage(error));
      setStarting(false);
      return;
    }
    setJob(started);
    setStarting(false);
    // No abort on close or unmount: the toast, ANALYSIS_FINISHED and onDone still follow.
    const terminal = await pollJob({
      jobId: started.id,
      read: api.scanStatus,
      onJob: setJob,
      onConnection: setConnection,
    });
    if (terminal?.status === "error") toast.error(terminal.error || "Η ανάλυση BPM απέτυχε");
    else toast.success(terminal?.message ? translateJobMessage(terminal.message) : "Η ανάλυση BPM ολοκληρώθηκε");
    window.dispatchEvent(new Event(ANALYSIS_FINISHED));
    setJob(null);
    await onDone();
    if (openRef.current) onOpenChange(false);
  }

  function close(next: boolean) {
    if (starting) return;
    if (!next && job) toast("Η ανάλυση BPM συνεχίζεται στο παρασκήνιο");
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ανάλυση BPM</DialogTitle>
          <DialogDescription>
            {countError
              || (matched === null
                ? "Μέτρηση tracks…"
                : `Θα αναλυθούν ξανά ${matched.toLocaleString("el-GR")} tracks με εύρος ${TEMPO_RANGE_LABELS[range]}. Οι χειροκίνητες τιμές BPM δεν αλλάζουν.`)}
          </DialogDescription>
        </DialogHeader>
        {therapy ? (
          <p className="text-xs text-cm-muted">Εύρος BPM: 40–240 (μουσικοθεραπεία). Μουσική χωρίς σταθερό ρυθμό μένει χωρίς BPM.</p>
        ) : (
          <label className="flex items-center justify-between gap-2 text-xs text-cm-muted">
            Εύρος BPM ανάλυσης
            <Select value={range} onValueChange={v => setRange(v as TempoRangeKey)} disabled={running}>
              <SelectTrigger size="sm" className="w-[200px] text-xs" aria-label="Εύρος BPM ανάλυσης">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DJ_RANGE_KEYS.map(key => <SelectItem key={key} value={key}>{TEMPO_RANGE_LABELS[key]}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
        )}
        {job && (
          <p role="status" className="font-mono text-xs tabular-nums text-cm-text">
            {jobProgressText(job, matched)}
            {connection === "retrying" && " · Επανασύνδεση…"}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={starting} onClick={() => close(false)}>{job ? "Απόκρυψη" : "Άκυρο"}</Button>
          <Button disabled={running || !matched} onClick={() => void start()}>
            {running ? "Ανάλυση…" : "Ανάλυση"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
