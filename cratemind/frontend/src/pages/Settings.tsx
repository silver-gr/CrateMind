import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import type { Job } from "../lib/types";
import { cn } from "../lib/cn";
import { jobKindLabel, jobStatusLabel, translateJobMessage } from "../lib/labels";
import { GlassPanel } from "../components/ui/GlassPanel";
import { SmartChip } from "../components/ui/SmartChip";
import { Gauge } from "../components/ui/Gauge";
import { IntelRow } from "../components/ui/IntelRow";
import { KeyboardHint } from "../components/ui/KeyboardHint";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePref } from "../lib/prefs";
import {
  Activity,
  Download,
  Loader2,
  CheckCircle2,
  TriangleAlert,
  CircleDot,
  SettingsIcon,
  FolderTree,
  ShieldCheck,
  Shield,
  Palette,
  RefreshCw,
  Scan,
  AudioWaveform,
  KeyRound,
  Wrench,
  Archive,
} from "../lib/icons";

export default function Settings() {
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);

  // ── local prefs (localStorage, apply live) ───────────────────────────────
  const [density, setDensity] = usePref("density");
  const [reduceMotion, setReduceMotion] = usePref("reduceMotion");
  const [defaultQueue, setDefaultQueue] = usePref("defaultQueue");
  const [autoplayOnSelect, setAutoplayOnSelect] = usePref("autoplayOnSelect");
  const [exportConfirm, setExportConfirm] = usePref("exportConfirm");
  const [showWaveform, setShowWaveform] = usePref("showWaveform");

  const load = useCallback(async () => {
    const [s, h, j] = await Promise.allSettled([
      api.settings(),
      api.health(),
      api.scanStatus(),
    ]);
    if (s.status === "fulfilled") setSettings(s.value);
    if (h.status === "fulfilled") setHealth(h.value);
    if (j.status === "fulfilled") setJob(j.value);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // ── preserved poll loop (≤600 iterations, 700 ms sleep) ─────────────────
  async function poll(jobId: number) {
    let st: Job | null = null;
    for (let i = 0; i < 600; i++) {
      st = await api.scanStatus(jobId);
      setJob(st);
      if (st && (st.status === "done" || st.status === "error")) {
        if (st.status === "error") toast.error(st.error || `${jobKindLabel(st.kind)} απέτυχε`);
        else
          toast.success(
            st.message ? translateJobMessage(st.message) : `${jobKindLabel(st.kind)} ολοκληρώθηκε`,
          );
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

  async function runAnalyze() {
    setBusy(true);
    try {
      const j = await api.startAnalyze();
      poll(j.id);
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  }

  async function backup() {
    try {
      const r = await api.exportArtifact("json-backup", { overwrite: true });
      toast.success(`Το backup γράφτηκε → ${r.path}`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  // ── derived facts (null-guarded) ─────────────────────────────────────────
  const roots = (settings?.library_roots as string[] | undefined) ?? [];
  const dbPath = settings?.db_path != null ? String(settings.db_path) : "";
  const outputDir = settings?.output_dir != null ? String(settings.output_dir) : "";
  const backupDir = settings?.backup_dir != null ? String(settings.backup_dir) : "";
  const hasFfprobe = Boolean(settings?.ffprobe);
  const hasFpcalc = Boolean(settings?.fpcalc);
  const hasFfmpeg = Boolean(health?.ffmpeg ?? settings?.ffmpeg);

  // health indicators (null-guarded; fall back to settings if health not loaded yet)
  const hStatus = health?.status === "ok";
  const hFfprobe = Boolean(health?.ffprobe ?? settings?.ffprobe);
  const hFpcalc = Boolean(health?.fpcalc ?? settings?.fpcalc);
  const hDb = Boolean(health?.db ?? (dbPath ? true : undefined));
  const hRoots = roots.length > 0;

  const healthScore = [hStatus, hFfprobe, hDb, hRoots].filter(Boolean).length;
  const gaugeValue = healthScore / 4;
  const gaugeLabel =
    healthScore === 4 ? "Τέλεια" : healthScore >= 3 ? "Καλό" : healthScore >= 2 ? "Μερικό" : "Σφάλμα";
  const gaugeTone =
    healthScore === 4
      ? "chartreuse"
      : healthScore >= 3
        ? "cyan"
        : healthScore >= 2
          ? "amber"
          : "rose";

  const gap = density === "compact" ? "gap-3" : "gap-4";
  const pad = density === "compact" ? "p-3" : "p-4";

  return (
    <div
      className={cn(
        "h-full overflow-auto text-sm",
        reduceMotion && "[&_*]:!transition-none [&_*]:!animate-none",
      )}
    >
      <div className="mx-auto max-w-[1440px] p-6">
        {/* ── page header ─────────────────────────────────────────────────── */}
        <div className="mb-6 flex items-center gap-2">
          <SettingsIcon className="h-5 w-5 text-cm-faint" />
          <div>
            <h1 className="text-xl font-semibold text-cm-text">Ρυθμίσεις</h1>
            <p className="text-xs text-cm-faint">
              Διαμόρφωσε το CrateMind ανάλογα με τη ροή σου. Όλα παραμένουν τοπικά.
            </p>
          </div>
        </div>

        {/* ── main layout: card grid + sidebar ────────────────────────────── */}
        <div className={cn("flex items-start", gap)}>
          {/* left/centre cards — 3-column grid */}
          <div className={cn("min-w-0 flex-1 grid grid-cols-3 auto-rows-min", gap)}>

            {/* ── Card 1: Εφαρμογή & Βιβλιοθήκη ──────────────────────────── */}
            <GlassPanel className={pad}>
              <div className="mb-3 flex items-center gap-1.5">
                <FolderTree className="h-4 w-4 text-cm-cyan" />
                <span className="font-semibold text-cm-text">Εφαρμογή & Βιβλιοθήκη</span>
              </div>

              {/* real: library_roots */}
              {roots.length > 0 ? (
                <ul className="mb-2 space-y-0.5">
                  {roots.map((r) => (
                    <li key={r} className="truncate font-mono text-[11px] text-cm-muted">
                      {r}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="mb-2 rounded-xl border border-cm-amber/25 bg-cm-amber/10 px-3 py-2 text-xs leading-relaxed text-cm-amber">
                  Δεν έχουν οριστεί library roots. Βάλε{" "}
                  <code className="font-mono">CRATEMIND_LIBRARY_ROOTS</code> στο{" "}
                  <code className="font-mono">backend/.env</code> και κάνε restart το backend.
                </div>
              )}

              {/* real: db_path, output_dir, backup_dir */}
              <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
                {dbPath && (
                  <>
                    <dt className="text-cm-faint">DB</dt>
                    <dd className="truncate font-mono text-cm-muted">{dbPath}</dd>
                  </>
                )}
                {outputDir && (
                  <>
                    <dt className="text-cm-faint">Output</dt>
                    <dd className="truncate font-mono text-cm-muted">{outputDir}</dd>
                  </>
                )}
                {backupDir && (
                  <>
                    <dt className="text-cm-faint">Backup</dt>
                    <dd className="truncate font-mono text-cm-muted">{backupDir}</dd>
                  </>
                )}
              </dl>

              {/* local pref: defaultQueue */}
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-cm-muted">Προεπιλεγμένη ουρά</span>
                <Select
                  value={defaultQueue}
                  onValueChange={(v) => setDefaultQueue(v as "untagged" | "testing" | "")}
                >
                  <SelectTrigger size="sm" className="w-[130px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="untagged">Αταξινόμητα</SelectItem>
                    <SelectItem value="testing">Δοκιμή</SelectItem>
                    <SelectItem value="">Κανένα</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </GlassPanel>

            {/* ── Card 2: Ήχος & Ανάλυση ──────────────────────────────────── */}
            <GlassPanel className={pad}>
              <div className="mb-3 flex items-center gap-1.5">
                <AudioWaveform className="h-4 w-4 text-cm-violet" />
                <span className="font-semibold text-cm-text">Ήχος & Ανάλυση</span>
              </div>

              {/* real: ffprobe / fpcalc presence */}
              <div className="mb-3 flex flex-wrap gap-1.5">
                <SmartChip
                  tone={hasFfprobe ? "cyan" : "rose"}
                  icon={hasFfprobe ? CheckCircle2 : TriangleAlert}
                >
                  ffprobe {hasFfprobe ? "βρέθηκε" : "λείπει"}
                </SmartChip>
                <SmartChip
                  tone={hasFpcalc ? "cyan" : "muted"}
                  icon={hasFpcalc ? CheckCircle2 : CircleDot}
                >
                  fpcalc {hasFpcalc ? "βρέθηκε" : "προαιρετικό"}
                </SmartChip>
              </div>

              {/* local prefs */}
              <div className="space-y-3">
                <label className="flex cursor-pointer items-center justify-between gap-2">
                  <span className="text-xs text-cm-muted">Κυματομορφή μεταφοράς</span>
                  <Switch
                    size="sm"
                    checked={showWaveform}
                    onCheckedChange={setShowWaveform}
                    aria-label="Κυματομορφή μεταφοράς"
                  />
                </label>
                <label className="flex cursor-pointer items-center justify-between gap-2">
                  <span className="text-xs text-cm-muted">Αυτόματη αναπαραγωγή επιλογής</span>
                  <Switch
                    size="sm"
                    checked={autoplayOnSelect}
                    onCheckedChange={setAutoplayOnSelect}
                    aria-label="Αυτόματη αναπαραγωγή επιλογής"
                  />
                </label>
              </div>
            </GlassPanel>

            {/* ── Card 3: Εμφάνιση ────────────────────────────────────────── */}
            <GlassPanel className={pad}>
              <div className="mb-3 flex items-center gap-1.5">
                <Palette className="h-4 w-4 text-cm-magenta" />
                <span className="font-semibold text-cm-text">Εμφάνιση</span>
              </div>

              <div className="space-y-3">
                {/* local pref: density */}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-cm-muted">Πυκνότητα</span>
                  <Select
                    value={density}
                    onValueChange={(v) => setDensity(v as "comfortable" | "compact")}
                  >
                    <SelectTrigger size="sm" className="w-[130px] text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="comfortable">Άνετη</SelectItem>
                      <SelectItem value="compact">Συμπαγής</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* local pref: reduceMotion */}
                <label className="flex cursor-pointer items-center justify-between gap-2">
                  <span className="text-xs text-cm-muted">Μειωμένη κίνηση</span>
                  <Switch
                    size="sm"
                    checked={reduceMotion}
                    onCheckedChange={setReduceMotion}
                    aria-label="Μειωμένη κίνηση"
                  />
                </label>

                {/* local pref: showWaveform (appearance axis) */}
                <label className="flex cursor-pointer items-center justify-between gap-2">
                  <span className="text-xs text-cm-muted">Εμφάνιση κυματομορφής</span>
                  <Switch
                    size="sm"
                    checked={showWaveform}
                    onCheckedChange={setShowWaveform}
                    aria-label="Εμφάνιση κυματομορφής"
                  />
                </label>
              </div>
            </GlassPanel>

            {/* ── Card 4: Backup & Export ──────────────────────────────────── */}
            <GlassPanel className={pad}>
              <div className="mb-3 flex items-center gap-1.5">
                <Archive className="h-4 w-4 text-cm-blue" />
                <span className="font-semibold text-cm-text">Backup & Export</span>
              </div>

              {/* real actions */}
              <div className="mb-3 flex flex-wrap gap-2">
                <Button
                  onClick={backup}
                  variant="outline"
                  size="sm"
                  className="gap-1.5 border-cm-blue/25 bg-cm-blue/12 text-xs font-medium text-cm-blue hover:bg-cm-blue/20 hover:text-cm-blue"
                >
                  <Download className="h-3.5 w-3.5" />
                  JSON Backup
                </Button>
                <Button
                  onClick={runScan}
                  disabled={busy || roots.length === 0}
                  variant="outline"
                  size="sm"
                  className="gap-1.5 border-cm-cyan/25 bg-cm-cyan/12 text-xs font-medium text-cm-cyan hover:bg-cm-cyan/20 hover:text-cm-cyan disabled:opacity-40"
                >
                  {busy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Scan className="h-3.5 w-3.5" />
                  )}
                  {busy ? "Εργασία…" : "Scan βιβλιοθήκης"}
                </Button>
                <Button
                  onClick={runFingerprint}
                  disabled={busy || !hasFpcalc}
                  variant="outline"
                  size="sm"
                  className="gap-1.5 border-cm-violet/25 bg-cm-violet/14 text-xs font-medium text-cm-violet hover:bg-cm-violet/20 hover:text-cm-violet disabled:opacity-40"
                >
                  <Activity className="h-3.5 w-3.5" />
                  Fingerprint
                </Button>
                <Button
                  onClick={runAnalyze}
                  disabled={busy || !hasFfmpeg}
                  variant="outline"
                  size="sm"
                  className="gap-1.5 border-cm-violet/25 bg-cm-violet/14 text-xs font-medium text-cm-violet hover:bg-cm-violet/20 hover:text-cm-violet disabled:opacity-40"
                  title={!hasFfmpeg ? "ffmpeg δεν βρέθηκε στο PATH" : undefined}
                >
                  <AudioWaveform className="h-3.5 w-3.5" />
                  Ανάλυση BPM + Key
                </Button>
              </div>

              {/* local pref: exportConfirm */}
              <label className="flex cursor-pointer items-center justify-between gap-2">
                <span className="text-xs text-cm-muted">Επιβεβαίωση πριν export</span>
                <Switch
                  size="sm"
                  checked={exportConfirm}
                  onCheckedChange={setExportConfirm}
                  aria-label="Επιβεβαίωση πριν export"
                />
              </label>

              {/* real: last job status */}
              {job && (
                <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
                  <span className="text-cm-faint">τελευταία εργασία</span>
                  <span className="font-mono text-cm-muted">{jobKindLabel(job.kind)}</span>
                  <Badge
                    variant="outline"
                    className={cn(
                      "border-transparent text-[10px] font-medium",
                      job.status === "done"
                        ? "text-cm-chartreuse"
                        : job.status === "error"
                          ? "text-cm-rose"
                          : "text-cm-amber",
                    )}
                  >
                    {jobStatusLabel(job.status)}
                  </Badge>
                  {job.message && (
                    <span className="text-cm-muted">({translateJobMessage(job.message)})</span>
                  )}
                  {job.error && <span className="text-cm-rose">({job.error})</span>}
                  {job.status === "running" && (job.processed ?? 0) > 0 && (
                    <span className="font-mono tabular-nums text-cm-faint">
                      · {job.processed} αρχεία
                    </span>
                  )}
                </div>
              )}
            </GlassPanel>

            {/* ── Card 5: Απόρρητο & Ασφάλεια ────────────────────────────── */}
            <GlassPanel className={pad}>
              <div className="mb-3 flex items-center gap-1.5">
                <ShieldCheck className="h-4 w-4 text-cm-chartreuse" />
                <span className="font-semibold text-cm-text">Απόρρητο & Ασφάλεια</span>
              </div>

              {/* real: local-mode facts */}
              <div className="mb-3 flex flex-wrap gap-1.5">
                <SmartChip tone="chartreuse" icon={ShieldCheck}>
                  Τοπική λειτουργία
                </SmartChip>
                <SmartChip tone="cyan" icon={Shield}>
                  Χωρίς cloud
                </SmartChip>
                <SmartChip tone="chartreuse" icon={CheckCircle2}>
                  Χωρίς τηλεμετρία
                </SmartChip>
              </div>
              <p className="text-[11px] leading-relaxed text-cm-faint">
                Το CrateMind λειτουργεί αποκλειστικά τοπικά. Δεν αποστέλλονται δεδομένα
                στο διαδίκτυο. Ό,τι αλλάζεις μένει στο μηχάνημά σου.
              </p>
            </GlassPanel>

            {/* ── Card 6: Διαγνωστικά ─────────────────────────────────────── */}
            <GlassPanel className={pad}>
              <div className="mb-3 flex items-center gap-1.5">
                <Wrench className="h-4 w-4 text-cm-faint" />
                <span className="font-semibold text-cm-text">Διαγνωστικά</span>
              </div>

              {/* real: derived from api.health() */}
              <div className="divide-y divide-white/6">
                <IntelRow
                  label="ffprobe"
                  value={hFfprobe ? "Ενεργό" : "Λείπει"}
                  tone={hFfprobe ? "cyan" : "rose"}
                />
                <IntelRow
                  label="fpcalc"
                  value={hFpcalc ? "Ενεργό" : "Προαιρετικό"}
                  tone={hFpcalc ? "chartreuse" : "muted"}
                />
                <IntelRow
                  label="Βάση Δεδομένων"
                  value={hDb ? "Ενεργή" : "Σφάλμα"}
                  tone={hDb ? "cyan" : "rose"}
                />
                <IntelRow
                  label="Βιβλιοθήκη"
                  value={hRoots ? `${roots.length} path${roots.length === 1 ? "" : "s"}` : "Δεν βρέθηκε"}
                  tone={hRoots ? "chartreuse" : "amber"}
                />
              </div>

              {job && (
                <div className="mt-2 border-t border-white/8 pt-2 text-[10px]">
                  <span className="text-cm-faint">τελευταία εργασία: </span>
                  <span className="font-mono text-cm-muted">{jobKindLabel(job.kind)}</span>
                  <span
                    className={cn(
                      "ml-1.5 font-medium",
                      job.status === "done"
                        ? "text-cm-chartreuse"
                        : job.status === "error"
                          ? "text-cm-rose"
                          : "text-cm-amber",
                    )}
                  >
                    {jobStatusLabel(job.status)}
                  </span>
                </div>
              )}
            </GlassPanel>

            {/* ── Card 7: Συντομεύσεις Πληκτρολογίου (spans 3 cols) ───────── */}
            <GlassPanel className={cn(pad, "col-span-3")}>
              <div className="mb-3 flex items-center gap-1.5">
                <KeyRound className="h-4 w-4 text-cm-blue" />
                <span className="font-semibold text-cm-text">Συντομεύσεις Πληκτρολογίου</span>
              </div>
              <div className="grid grid-cols-3 gap-x-8">
                <div>
                  <p className="mb-2 text-[10px] uppercase tracking-wider text-cm-faint">
                    Αναζήτηση & πλοήγηση
                  </p>
                  <KeyboardHint keys={["⌘", "K"]} label="Παλέτα εντολών" />
                  <KeyboardHint keys={["J"]} label="Επόμενο κομμάτι" />
                  <KeyboardHint keys={["K"]} label="Προηγούμενο κομμάτι" />
                  <KeyboardHint keys={["Esc"]} label="Κλείσιμο διαλόγου" />
                </div>
                <div>
                  <p className="mb-2 text-[10px] uppercase tracking-wider text-cm-faint">
                    Αναπαραγωγή
                  </p>
                  <KeyboardHint keys={["Space"]} label="Αναπαραγωγή / Παύση" />
                  <KeyboardHint keys={["←", "→"]} label="Seek ∓5 δευτ." />
                  <KeyboardHint keys={["Shift", "←/→"]} label="Seek ∓30 δευτ." />
                </div>
                <div>
                  <p className="mb-2 text-[10px] uppercase tracking-wider text-cm-faint">
                    Tagging (στην ουρά)
                  </p>
                  <KeyboardHint keys={["1–9", "0"]} label="Ένταση 1–10" />
                  <KeyboardHint keys={["Shift", "1–0"]} label="Σκοτεινότητα" />
                  <KeyboardHint keys={["M"]} label="Μελωδικό" />
                  <KeyboardHint keys={["B", "P", "R"]} label="Γέφυρα / Κορύφωση / Reset" />
                  <KeyboardHint keys={["W", "A", "X"]} label="Όπλο / Εγκεκρ. / Απόφυγε" />
                </div>
              </div>
            </GlassPanel>
          </div>

          {/* ── System Overview sidebar ──────────────────────────────────── */}
          <GlassPanel strong className={cn("flex w-[240px] shrink-0 flex-col", gap, pad)}>
            <div className="flex items-center gap-1.5">
              <SettingsIcon className="h-4 w-4 text-cm-faint" />
              <span className="font-semibold text-cm-text">Επισκόπηση Συστήματος</span>
            </div>

            {/* real: gauge derived from api.health() checks */}
            <div className="flex justify-center py-1">
              <Gauge
                value={gaugeValue}
                size={112}
                tone={gaugeTone}
                label={gaugeLabel}
                sub="Σύστημα"
              />
            </div>

            {/* real: health status rows */}
            <div className="divide-y divide-white/6">
              <IntelRow
                label="ffprobe"
                value={hFfprobe ? "OK" : "—"}
                tone={hFfprobe ? "cyan" : "rose"}
              />
              <IntelRow
                label="fpcalc"
                value={hFpcalc ? "OK" : "—"}
                tone={hFpcalc ? "chartreuse" : "muted"}
              />
              <IntelRow
                label="Βάση Δεδομένων"
                value={hDb ? "OK" : "—"}
                tone={hDb ? "cyan" : "rose"}
              />
              <IntelRow
                label="Βιβλιοθήκη"
                value={hRoots ? String(roots.length) : "—"}
                tone={hRoots ? "chartreuse" : "amber"}
              />
            </div>

            {/* real: DB path */}
            {dbPath && (
              <div>
                <p className="mb-0.5 text-[10px] text-cm-faint">DB Path</p>
                <p className="break-all font-mono text-[10px] text-cm-muted">{dbPath}</p>
              </div>
            )}

            {/* real: latest job */}
            {job && (
              <div>
                <p className="mb-0.5 text-[10px] text-cm-faint">Τελευταία Εργασία</p>
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-[10px] text-cm-muted">
                    {jobKindLabel(job.kind)}
                  </span>
                  <Badge
                    variant="outline"
                    className={cn(
                      "border-transparent px-1 py-0 text-[10px] font-medium",
                      job.status === "done"
                        ? "text-cm-chartreuse"
                        : job.status === "error"
                          ? "text-cm-rose"
                          : "text-cm-amber",
                    )}
                  >
                    {jobStatusLabel(job.status)}
                  </Badge>
                </div>
              </div>
            )}

            {/* real quick actions */}
            <div className="mt-auto space-y-2 border-t border-white/8 pt-3">
              <p className="text-[10px] uppercase tracking-wider text-cm-faint">
                Γρήγορες Ενέργειες
              </p>
              <Button
                onClick={runScan}
                disabled={busy || roots.length === 0}
                variant="outline"
                size="sm"
                className="w-full gap-1.5 border-cm-cyan/25 bg-cm-cyan/12 text-xs font-medium text-cm-cyan hover:bg-cm-cyan/20 hover:text-cm-cyan disabled:opacity-40"
              >
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                Rescan Βιβλιοθήκης
              </Button>
              <Button
                onClick={runFingerprint}
                disabled={busy || !hasFpcalc}
                variant="outline"
                size="sm"
                className="w-full gap-1.5 border-cm-violet/25 bg-cm-violet/14 text-xs font-medium text-cm-violet hover:bg-cm-violet/20 hover:text-cm-violet disabled:opacity-40"
              >
                <Activity className="h-3.5 w-3.5" />
                Fingerprint
              </Button>
              <Button
                onClick={runAnalyze}
                disabled={busy || !hasFfmpeg}
                variant="outline"
                size="sm"
                className="w-full gap-1.5 border-cm-violet/25 bg-cm-violet/14 text-xs font-medium text-cm-violet hover:bg-cm-violet/20 hover:text-cm-violet disabled:opacity-40"
                title={!hasFfmpeg ? "ffmpeg δεν βρέθηκε στο PATH" : undefined}
              >
                <AudioWaveform className="h-3.5 w-3.5" />
                Ανάλυση BPM + Key
              </Button>
              <Button
                onClick={backup}
                variant="outline"
                size="sm"
                className="w-full gap-1.5 border-cm-blue/25 bg-cm-blue/12 text-xs font-medium text-cm-blue hover:bg-cm-blue/20 hover:text-cm-blue"
              >
                <Download className="h-3.5 w-3.5" />
                Δημιουργία Backup
              </Button>
            </div>
          </GlassPanel>
        </div>
      </div>
    </div>
  );
}
