import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { ANALYSIS_FINISHED } from "../lib/bpmUpdates";
import { apiMessage } from "../lib/facets";
import { pollJob } from "../lib/jobPolling";
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
 * window, follows it to the end, then reloads the caller's rows.
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
  const abort = useRef<AbortController | null>(null);
  const running = starting || job !== null;
  const scopeKey = JSON.stringify(scope);

  useEffect(() => () => abort.current?.abort(), []);

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
    const controller = new AbortController();
    abort.current = controller;
    const terminal = await pollJob({
      jobId: started.id,
      signal: controller.signal,
      read: api.scanStatus,
      onJob: setJob,
      onConnection: () => {},
    });
    if (controller.signal.aborted) return;
    if (terminal?.status === "error") toast.error(terminal.error || "Η ανάλυση BPM απέτυχε");
    else toast.success(terminal?.message ? translateJobMessage(terminal.message) : "Η ανάλυση BPM ολοκληρώθηκε");
    window.dispatchEvent(new Event(ANALYSIS_FINISHED));
    setJob(null);
    await onDone();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={next => { if (!running) onOpenChange(next); }}>
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
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={running} onClick={() => onOpenChange(false)}>Άκυρο</Button>
          <Button disabled={running || !matched} onClick={() => void start()}>
            {running ? "Ανάλυση…" : "Ανάλυση"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
