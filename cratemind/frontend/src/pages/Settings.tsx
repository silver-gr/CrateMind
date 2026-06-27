import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import type { Job } from "../lib/types";
import { cn } from "../lib/cn";
import { jobKindLabel, jobStatusLabel, translateJobMessage } from "../lib/labels";
import { GlassPanel } from "../components/ui/GlassPanel";
import { SectionHeader } from "../components/ui/SectionHeader";
import { SmartChip } from "../components/ui/SmartChip";
import {
  Search,
  Activity,
  Download,
  Loader2,
  CheckCircle2,
  TriangleAlert,
  CircleDot,
  SettingsIcon,
} from "../lib/icons";

export default function Settings() {
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setSettings(await api.settings());
    setJob(await api.scanStatus());
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function poll(jobId: number) {
    let st: Job | null = null;
    for (let i = 0; i < 600; i++) {
      st = await api.scanStatus(jobId);
      setJob(st);
      if (st && (st.status === "done" || st.status === "error")) {
        if (st.status === "error") toast.error(st.error || `${jobKindLabel(st.kind)} απέτυχε`);
        else toast.success(st.message ? translateJobMessage(st.message) : `${jobKindLabel(st.kind)} ολοκληρώθηκε`);
        break;
      }
      await new Promise((r) => setTimeout(r, 700));
    }
    setBusy(false);
  }

  async function runScan() {
    setBusy(true);
    try {
      const j = await api.startScan();
      poll(j.id);
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  }

  async function runFingerprint() {
    setBusy(true);
    try {
      const j = await api.startFingerprint();
      poll(j.id);
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  }

  async function backup() {
    const r = await api.exportArtifact("json-backup", { overwrite: true });
    toast.success(`Το backup γράφτηκε → ${r.path}`);
  }

  const roots = (settings?.library_roots as string[]) ?? [];

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6 text-sm">
      <div className="flex items-center gap-2">
        <SettingsIcon className="h-4 w-4 text-cm-faint" />
        <h2 className="text-lg font-semibold text-cm-text">Ρυθμίσεις</h2>
      </div>

      <GlassPanel className="p-4">
        <SectionHeader>Βιβλιοθήκη</SectionHeader>
        {roots.length ? (
          <ul className="space-y-1">
            {roots.map((r) => (
              <li key={r} className="font-mono text-xs text-cm-muted">
                {r}
              </li>
            ))}
          </ul>
        ) : (
          <div className="rounded-xl border border-cm-amber/25 bg-cm-amber/10 px-3 py-2 text-xs leading-relaxed text-cm-amber">
            Δεν έχουν οριστεί library roots. Βάλε <code className="font-mono">CRATEMIND_LIBRARY_ROOTS</code> στο{" "}
            <code className="font-mono">backend/.env</code> και κάνε restart το backend.
          </div>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          <SmartChip
            tone={settings?.ffprobe ? "cyan" : "rose"}
            icon={settings?.ffprobe ? CheckCircle2 : TriangleAlert}
          >
            ffprobe {settings?.ffprobe ? "βρέθηκε" : "λείπει"}
          </SmartChip>
          <SmartChip
            tone={settings?.fpcalc ? "cyan" : "muted"}
            icon={settings?.fpcalc ? CheckCircle2 : CircleDot}
          >
            fpcalc {settings?.fpcalc ? "βρέθηκε" : "προαιρετικό"}
          </SmartChip>
        </div>

        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
          <dt className="text-cm-faint">DB</dt>
          <dd className="truncate font-mono text-cm-muted">{String(settings?.db_path ?? "")}</dd>
          <dt className="text-cm-faint">Output</dt>
          <dd className="truncate font-mono text-cm-muted">{String(settings?.output_dir ?? "")}</dd>
        </dl>
      </GlassPanel>

      <GlassPanel className="p-4">
        <SectionHeader>Ενέργειες</SectionHeader>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={runScan}
            disabled={busy || roots.length === 0}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-cm-cyan/25 bg-cm-cyan/12 px-3 py-1.5 font-medium text-cm-cyan transition hover:bg-cm-cyan/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
            {busy ? "Εργασία…" : "Scan βιβλιοθήκης"}
          </button>
          <button
            onClick={runFingerprint}
            disabled={busy || !settings?.fpcalc}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-cm-violet/25 bg-cm-violet/14 px-3 py-1.5 font-medium text-cm-violet transition hover:bg-cm-violet/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Activity className="h-3.5 w-3.5" />
            Fingerprint (fpcalc)
          </button>
          <button
            onClick={backup}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-cm-blue/25 bg-cm-blue/12 px-3 py-1.5 font-medium text-cm-blue transition hover:bg-cm-blue/20"
          >
            <Download className="h-3.5 w-3.5" />
            JSON backup
          </button>
        </div>
        {job && (
          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span className="text-cm-faint">τελευταίο job</span>
            <span className="font-mono text-cm-muted">{jobKindLabel(job.kind)}</span>
            <span
              className={cn(
                "font-medium",
                job.status === "done"
                  ? "text-cm-chartreuse"
                  : job.status === "error"
                    ? "text-cm-rose"
                    : "text-cm-amber",
              )}
            >
              {jobStatusLabel(job.status)}
            </span>
            {job.message && <span className="text-cm-muted">({translateJobMessage(job.message)})</span>}
            {job.error && <span className="text-cm-rose">({job.error})</span>}
            {job.status === "running" && job.processed > 0 && (
              <span className="font-mono tabular-nums text-cm-faint">· {job.processed} αρχεία</span>
            )}
          </div>
        )}
      </GlassPanel>
    </div>
  );
}
