import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import type { DjayImportStatus, Job } from "../lib/types";
import { clearBeatGridCache } from "../lib/beatGrid";
import { GlassPanel } from "./ui/GlassPanel";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw } from "../lib/icons";
import SpecularButton from "./ui/SpecularButton";

const COUNTS: [string, string][] = [
  ["matched", "Ταίριαξαν"],
  ["ambiguous", "Αμφίσημα"],
  ["unmatched", "Χωρίς αντιστοίχιση"],
  ["edited", "Επεξεργασμένα"],
  ["non_straight", "Μη σταθερό tempo"],
  ["unknown_version", "Άγνωστη έκδοση"],
  ["denied", "Άρνηση πρόσβασης"],
];

/** Greek headings for the report's sample lists (the report keys are internal). */
const SAMPLE_TITLES: Record<string, string> = Object.fromEntries([...COUNTS, ["transient", "Προσωρινά μη διαθέσιμα"]]);

/** Greek text for the importer's skip reasons; unknown reasons are shown as they come. */
const REASONS: Record<string, string> = {
  residual: "τα beats αποκλίνουν από σταθερό grid",
  dynamic: "μεταβλητό tempo στο djay",
  missing: "λείπει το αρχείο ανάλυσης",
  unreadable: "το αρχείο ανάλυσης δεν διαβάζεται",
  denied: "άρνηση πρόσβασης",
  no_beat_info: "χωρίς δεδομένα beat",
  version: "άγνωστη έκδοση ανάλυσης",
  time_signature: "μη υποστηριζόμενο μέτρο",
  beats: "μη έγκυρα beats",
};

/** «Beatgrid από djay»: read-only import of djay's beatgrids; job state comes from the Settings poller. */
export function DjayBeatgridCard({ job, busy, onStarted }: { job: Job | null; busy: boolean; onStarted: (job: Job) => void }) {
  const [status, setStatus] = useState<DjayImportStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [showSamples, setShowSamples] = useState(false);

  const refresh = useCallback(() => api.getDjayImport().then(setStatus).catch(e => setError((e as Error).message)), []);
  useEffect(() => { void refresh(); }, [refresh]);

  const djayJob = job?.kind === "djay_import" ? job : null;
  const running = djayJob?.status === "pending" || djayJob?.status === "running";
  const finished = djayJob?.status === "done" || djayJob?.status === "error" ? djayJob.id : null;
  useEffect(() => {
    if (finished == null) return;
    clearBeatGridCache();
    void refresh();
  }, [finished, refresh]);

  async function run() {
    setPending(true); setError(null);
    try { onStarted(await api.startDjayImport()); }
    catch (e) { setError((e as Error).message); }
    finally { setPending(false); }
  }

  async function remove() {
    setPending(true); setError(null); setConfirming(false);
    try {
      const { removed } = await api.removeDjayBeatgrids();
      clearBeatGridCache();
      toast.success(`Αφαιρέθηκαν ${removed} beatgrid djay`);
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setPending(false); }
  }

  const report = status?.report ?? null;
  const samples = report ? Object.entries(report.samples).filter(([, rows]) => rows.length > 0) : [];
  const disabled = busy || pending;
  const jobError = djayJob?.status === "error" ? djayJob.error : null;

  return (
    <GlassPanel className="p-4">
      <div className="mb-3 flex items-center gap-1.5">
        <RefreshCw className="h-4 w-4 text-cm-cyan" />
        <span className="font-semibold text-cm-text">Beatgrid από djay</span>
      </div>
      <p className="mb-3 text-xs text-cm-muted">
        Κλείσε το djay για πλήρως συνεπές import. Το CrateMind μόνο διαβάζει τα αρχεία του djay και δεν γράφει ποτέ σε αυτά.
      </p>
      {status && (
        <div className="mb-3 space-y-0.5 font-mono text-[10px] text-cm-faint">
          <div className="break-all">{status.sources.library}</div>
          <div className="break-all">{status.sources.metadata}</div>
        </div>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SpecularButton size="sm" disabled={disabled} onClick={run}>
          {running && <Loader2 className="h-3 w-3 animate-spin" />}Εισαγωγή beatgrid
        </SpecularButton>
        {confirming ? (
          <>
            <span className="text-xs text-cm-muted">Να αφαιρεθούν όλα τα beatgrid djay;</span>
            <Button size="sm" variant="destructive" disabled={disabled} onClick={remove}>Επιβεβαίωση</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Άκυρο</Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" disabled={disabled || !status?.grids} onClick={() => setConfirming(true)}>
            Αφαίρεση beatgrid djay
          </Button>
        )}
      </div>
      {running && djayJob && (
        <p className="mb-3 text-xs text-cm-muted">
          {djayJob.processed}{djayJob.total ? ` / ${djayJob.total}` : ""}{djayJob.message ? ` · ${djayJob.message}` : ""}
        </p>
      )}
      {(error || jobError) && <p className="mb-3 text-xs text-cm-red">{(error || jobError)!.replace(/^\d{3}: /, "")}</p>}
      {report ? (
        <>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
            {COUNTS.map(([key, label]) => (
              <div key={key} className="flex items-baseline justify-between gap-2">
                <span className="whitespace-nowrap text-cm-muted">{label}</span>
                <span className="font-mono text-cm-text">{report[key as keyof typeof report] as number}</span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[10px] text-cm-faint">
            {status?.report_at ? new Date(status.report_at).toLocaleString("el-GR") : ""} · αποθηκευμένα beatgrid: {status?.grids ?? 0}
          </p>
          {samples.length > 0 && (
            <div className="mt-2">
              <button type="button" className="text-xs text-cm-cyan" aria-expanded={showSamples} onClick={() => setShowSamples(v => !v)}>
                {showSamples ? "Απόκρυψη δειγμάτων" : "Δείγματα"}
              </button>
              {showSamples && samples.map(([kind, rows]) => (
                <div key={kind} className="mt-2">
                  <div className="text-[10px] text-cm-faint">{SAMPLE_TITLES[kind] ?? kind}</div>
                  {rows.map(row => (
                    <div key={row.uuid} className="truncate text-xs text-cm-muted" title={row.reason ? REASONS[row.reason] ?? row.reason : undefined}>
                      {row.file_name}{row.reason ? ` · ${REASONS[row.reason] ?? row.reason}` : ""}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <p className="text-xs text-cm-faint">Δεν υπάρχει ακόμη αναφορά import.</p>
      )}
    </GlassPanel>
  );
}
