import { PlaybackOptions } from "../components/PlaybackOptions";
import BackgroundPicker from "../components/backgrounds/BackgroundPicker";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { hasProviderWorkflows, useCapabilities } from "../lib/capabilities";
import { isDesktopRuntime } from "../lib/desktopRuntime";
import { api } from "../lib/api";
import type { Job } from "../lib/types";
import { pollJob, type JobConnection } from "../lib/jobPolling";
import { cn } from "../lib/cn";
import { jobKindLabel, jobStatusLabel, translateJobMessage } from "../lib/labels";
import { GlassPanel } from "../components/ui/GlassPanel";
import { SmartChip } from "../components/ui/SmartChip";
import { Gauge } from "../components/ui/Gauge";
import { IntelRow } from "../components/ui/IntelRow";
import { BpmAnalysisCard } from "../components/BpmAnalysisCard";
import { DjayBeatgridCard } from "../components/DjayBeatgridCard";
import { DesktopLibrarySettings } from "../components/DesktopLibrarySettings";
import { LibraryExchangeSettings } from "../components/LibraryExchangeSettings";
import { VocabularySettings } from "../components/VocabularySettings";
import { Button } from "@/components/ui/button";
import { PageHeader } from "../components/ui/PageHeader";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePref, type LibraryProfile } from "../lib/prefs";
import { followAnalysisJob } from "../lib/bpmUpdates";
import {
  activeRootRanges,
  activeTempoRange,
  DEFAULT_DJ_RANGE,
  DJ_RANGE_KEYS,
  isDjRangeKey,
  TEMPO_RANGE_LABELS,
  type DjRangeKey,
} from "../lib/tempoRanges";
import { useTheme } from "../lib/theme";
import {
  Activity,
  Download,
  Loader2,
  CheckCircle2,
  TriangleAlert,
  CircleDot,
  SettingsIcon,
  FolderTree,
  Palette,
  RefreshCw,
  Scan,
  AudioWaveform,
  Archive,
} from "../lib/icons";
import SpecularButton from "../components/ui/SpecularButton";

export default function Settings() {
  const capabilities = useCapabilities();
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [starting, setStarting] = useState(false);
  const [connection, setConnection] = useState<JobConnection>("connecting");
  const [pollTarget, setPollTarget] = useState<{ id?: number }>({});
  const busy = starting || connection !== "connected" || job?.status === "pending" || job?.status === "running";
  const [scanMode, setScanMode] = useState<"delta" | "full">("delta");
  const [scanFolder, setScanFolder] = useState("");

  // ── per-device preferences, applied live ────────────────────────────────
  const [density, setDensity] = usePref("density");
  const [reduceMotion, setReduceMotion] = usePref("reduceMotion");
  const [defaultQueue, setDefaultQueue] = usePref("defaultQueue");
  const [libraryProfile, setLibraryProfile] = usePref("libraryProfile");
  const [autoplayOnSelect, setAutoplayOnSelect] = usePref("autoplayOnSelect");
  const [exportConfirm, setExportConfirm] = usePref("exportConfirm");
  const [showWaveform, setShowWaveform] = usePref("showWaveform");
  const [keyFormat, setKeyFormat] = usePref("keyFormat");
  const [waveformPalette, setWaveformPalette] = usePref("waveformPalette");
  const [deckViewPosition, setDeckViewPosition] = usePref("deckViewPosition");
  const [sidebarCollapseStyle, setSidebarCollapseStyle] = usePref("sidebarCollapseStyle");
  const [djTempoRange, setDjTempoRange] = usePref("djTempoRange");
  const [tempoRangeByRoot, setTempoRangeByRoot] = usePref("tempoRangeByRoot");
  const therapy = libraryProfile === "therapy";

  function setRootRange(root: string, value: string) {
    const next = { ...tempoRangeByRoot };
    if (isDjRangeKey(value)) next[root] = value;
    else delete next[root];
    setTempoRangeByRoot(next);
  }
  const [theme, setTheme] = useTheme();

  const load = useCallback(async () => {
    const [s, h] = await Promise.allSettled([
      api.settings(),
      api.health(),
    ]);
    if (s.status === "fulfilled") setSettings(s.value);
    if (h.status === "fulfilled") setHealth(h.value);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const controller = new AbortController();
    let observedActive = pollTarget.id !== undefined;
    void pollJob({
      jobId: pollTarget.id,
      signal: controller.signal,
      read: api.scanStatus,
      onConnection: setConnection,
      onJob: current => {
        observedActive ||= current.status === "pending" || current.status === "running";
        // ANALYSIS_FINISHED must reach the decks even after the user leaves Ρυθμίσεις.
        followAnalysisJob(current, api.scanStatus);
        setJob(current);
      },
    }).then(terminal => {
      if (controller.signal.aborted) return;
      if (!terminal) { setJob(null); return; }
      if (!observedActive) return;
      if (terminal.status === "error") {
        toast.error(terminal.error || `${jobKindLabel(terminal.kind)} απέτυχε`);
      } else {
        toast.success(terminal.message ? translateJobMessage(terminal.message) : `${jobKindLabel(terminal.kind)} ολοκληρώθηκε`);
      }
    });
    return () => controller.abort();
  }, [pollTarget]);

  function followJob(current: Job) {
    followAnalysisJob(current, api.scanStatus);
    setJob(current);
    setConnection("connecting");
    setPollTarget({ id: current.id });
  }

  async function runScan() {
    setStarting(true);
    try {
      const j = await api.startScan(scanFolder.trim() ? [scanFolder.trim()] : undefined, scanMode, {
        tempoRange: activeTempoRange(),
        rootRanges: activeRootRanges(),
      });
      followJob(j);
    } catch (e) {
      toast.error((e as Error).message);
      setPollTarget({});
    } finally {
      setStarting(false);
    }
  }

  async function runFingerprint() {
    setStarting(true);
    try {
      const j = await api.startFingerprint();
      followJob(j);
    } catch (e) {
      toast.error((e as Error).message);
      setPollTarget({});
    } finally {
      setStarting(false);
    }
  }

  async function runAnalyze(force = false) {
    if (!capabilities.analysis) return;
    setStarting(true);
    try {
      const j = await api.startAnalyze({ force, tempoRange: activeTempoRange(), rootRanges: activeRootRanges() });
      followJob(j);
    } catch (e) {
      toast.error((e as Error).message);
      setPollTarget({});
    } finally {
      setStarting(false);
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
    <div className="flex h-full flex-col text-sm">
      <PageHeader
        icon={SettingsIcon}
        title="Ρυθμίσεις"
        subtitle="Διαμόρφωσε το CrateMind ανάλογα με τη ροή σου. Όλα παραμένουν τοπικά."
      />
      <div className="scroll-fade-y min-h-0 flex-1 overflow-auto">
        <div className="@container mx-auto max-w-[1440px] p-6">

          {capabilities.native_dialogs && <DesktopLibrarySettings connectedRoots={roots} />}
          {capabilities.library_exchange && <LibraryExchangeSettings desktop={!!capabilities.native_dialogs} />}
          {/* ── main layout: card grid + sidebar ────────────────────────────── */}
          <div className={cn("flex flex-col items-stretch @[68rem]:flex-row @[68rem]:items-start", gap)}>
            {/* left/centre cards — 1 → 2 → 3 columns by container width */}
            <div className={cn("min-w-0 flex-1 grid grid-cols-1 auto-rows-min @[44rem]:grid-cols-2 @[80rem]:grid-cols-3", gap)}>

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
                      <li key={r} className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-cm-muted">{r}</span>
                        {capabilities.analysis && !therapy && (
                          <Select
                            value={isDjRangeKey(tempoRangeByRoot[r]) ? tempoRangeByRoot[r] : "default"}
                            onValueChange={(v) => setRootRange(r, v)}
                          >
                            <SelectTrigger size="sm" className="w-[170px] max-w-full shrink-0 text-[11px]" aria-label={`Εύρος BPM για ${r}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="default">Όπως η προεπιλογή</SelectItem>
                              {DJ_RANGE_KEYS.map((key) => (
                                <SelectItem key={key} value={key}>{TEMPO_RANGE_LABELS[key]}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="mb-2 rounded-xl border border-cm-amber/25 bg-cm-amber/10 px-3 py-2 text-xs leading-relaxed text-cm-amber">
                    {capabilities.native_dialogs ? "Πρόσθεσε ή αντιστοίχισε έναν φάκελο μουσικής παραπάνω." : <>Δεν έχουν οριστεί library roots. Βάλε{" "}
                    <code className="font-mono">CRATEMIND_LIBRARY_ROOTS</code> στο{" "}
                    <code className="font-mono">backend/.env</code> και κάνε restart το backend.</>}
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

                {/* local pref: libraryProfile */}
                <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                  <span className="text-xs text-cm-muted">Προφίλ χρήσης</span>
                  <Select
                    value={libraryProfile}
                    onValueChange={(v) => setLibraryProfile(v as LibraryProfile)}
                  >
                    <SelectTrigger size="sm" className="w-[150px] max-w-full text-xs" aria-label="Προφίλ χρήσης">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="dj">DJ</SelectItem>
                      <SelectItem value="therapy">Μουσικοθεραπεία</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* local pref: defaultQueue */}
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                  <span className="text-xs text-cm-muted">Προεπιλεγμένη ουρά</span>
                  <Select
                    value={defaultQueue}
                    onValueChange={(v) => setDefaultQueue(v as "untagged" | "testing" | "")}
                  >
                    <SelectTrigger size="sm" className="w-[130px] max-w-full text-xs">
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

                {capabilities.analysis && (therapy ? (
                  <p className="mb-3 text-[11px] leading-relaxed text-cm-muted">
                    Εύρος BPM: 40–240 (μουσικοθεραπεία). Μουσική χωρίς σταθερό ρυθμό μένει χωρίς BPM.
                  </p>
                ) : (
                  <div className="mb-3 space-y-1">
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                      <span className="text-xs text-cm-muted">Εύρος BPM ανάλυσης</span>
                      <Select
                        value={isDjRangeKey(djTempoRange) ? djTempoRange : DEFAULT_DJ_RANGE}
                        onValueChange={(v) => setDjTempoRange(v as DjRangeKey)}
                      >
                        <SelectTrigger size="sm" className="w-[190px] max-w-full text-xs" aria-label="Εύρος BPM ανάλυσης">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {DJ_RANGE_KEYS.map((key) => (
                            <SelectItem key={key} value={key}>{TEMPO_RANGE_LABELS[key]}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <p className="text-[10px] leading-relaxed text-cm-faint">
                      Ισχύει για νέες αναλύσεις. Για tracks που έχουν ήδη αναλυθεί, χρησιμοποίησε «Ανάλυση BPM» σε επιλογή ή crate.
                    </p>
                  </div>
                ))}

                <PlaybackOptions />

                {/* local prefs */}
                <div className="mt-4 space-y-3">
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
                  {/* local pref: theme */}
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                    <span className="text-xs text-cm-muted">Θέμα εμφάνισης</span>
                    <Select
                      value={theme}
                      onValueChange={(v) => setTheme(v as "dark" | "light")}
                    >
                      <SelectTrigger size="sm" className="w-[190px] max-w-full text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="dark">Νυχτερινό Κενό (Night)</SelectItem>
                        <SelectItem value="light">Ηλιακό Φως (Solar)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <BackgroundPicker compact />

                  {/* local pref: density */}
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                    <span className="text-xs text-cm-muted">Πυκνότητα</span>
                    <Select
                      value={density}
                      onValueChange={(v) => setDensity(v as "comfortable" | "compact")}
                    >
                      <SelectTrigger size="sm" className="w-[170px] max-w-full text-xs">
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

                  {/* local pref: waveformPalette (deck detail and overview) */}
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                    <span className="text-xs text-cm-muted">Χρώματα κυματομορφής</span>
                    <Select value={waveformPalette} onValueChange={(v) => setWaveformPalette(v as "theme" | "frequency")}>
                      <SelectTrigger size="sm" className="w-[190px] max-w-full text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="theme">Θέμα (πλήρες φάσμα)</SelectItem>
                        <SelectItem value="frequency">Συχνότητες (djay)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* local pref: deckViewPosition (two-deck waveform panel) */}
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                    <span className="text-xs text-cm-muted">Θέση κυματομορφών decks</span>
                    <Select value={deckViewPosition} onValueChange={(v) => setDeckViewPosition(v as "top" | "bottom")}>
                      <SelectTrigger size="sm" className="w-[170px] max-w-full text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="top">Πάνω</SelectItem>
                        <SelectItem value="bottom">Κάτω (πάνω από τα decks)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* local pref: sidebarCollapseStyle */}
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                    <span className="text-xs text-cm-muted">Σύμπτυξη πλαϊνής μπάρας</span>
                    <Select value={sidebarCollapseStyle} onValueChange={(v) => setSidebarCollapseStyle(v as "dock" | "rail")}>
                      <SelectTrigger size="sm" className="w-[170px] max-w-full text-xs" aria-label="Σύμπτυξη πλαϊνής μπάρας">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="dock">Αιωρούμενη μπάρα</SelectItem>
                        <SelectItem value="rail">Στενή πλαϊνή μπάρα</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* local pref: keyFormat */}
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                    <div>
                      <span className="block text-xs text-cm-muted">Μορφή κλειδιού</span>
                      <span className="block text-[10px] text-cm-faint">Για tracklist & player</span>
                    </div>
                    <Select
                      value={keyFormat}
                      onValueChange={(v) => setKeyFormat(v as "camelot" | "musical" | "both")}
                    >
                      <SelectTrigger size="sm" className="w-[190px] max-w-full text-xs font-mono">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="camelot">Camelot (π.χ. 8A)</SelectItem>
                        <SelectItem value="musical">Μουσικό (π.χ. Am)</SelectItem>
                        <SelectItem value="both">Και τα δύο (8A · Am)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </GlassPanel>

              {hasProviderWorkflows(capabilities) && (
                <BpmAnalysisCard
                  job={job}
                  busy={busy}
                  canAnalyze={hasFfmpeg}
                  onRunAnalyze={() => runAnalyze(false)}
                />
              )}

              {libraryProfile === "dj" && <DjayBeatgridCard job={job} busy={busy} onStarted={followJob} />}

              {/* ── Card 4: Backup & Export ──────────────────────────────────── */}
              <GlassPanel className={pad}>
                <div className="mb-3 flex items-center gap-1.5">
                  <Archive className="h-4 w-4 text-cm-blue" />
                  <span className="font-semibold text-cm-text">Backup & Export</span>
                </div>

                <p className="mb-3 text-xs text-cm-muted">{capabilities.complete_backup
                  ? "Κράτησε το JSON μαζί με τον συνοδευτικό φάκελο για πλήρη επαναφορά της βιβλιοθήκης."
                  : "Εξάγονται τα metadata. Η πλήρης επαναφορά της ενοποιημένης βιβλιοθήκης δεν υποστηρίζεται σε αυτή την εγκατάσταση."}</p>
                {/* real actions */}
                <div className="mb-3 flex flex-wrap gap-2">
                  <SpecularButton onClick={backup} size="sm">
                    <Download className="h-3.5 w-3.5" />
                    {capabilities.complete_backup ? "Πλήρες backup" : "Εξαγωγή metadata (JSON)"}
                  </SpecularButton>
                  <div className="w-full space-y-2">
                    <Select value={scanMode} onValueChange={(value) => setScanMode(value as "delta" | "full")} disabled={busy}>
                      <SelectTrigger aria-label="Τρόπος σάρωσης"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="delta">Μόνο αλλαγές (γρήγορα)</SelectItem>
                        <SelectItem value="full">Πλήρης σάρωση / ανανέωση metadata</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input aria-label="Φάκελος σάρωσης" placeholder="Προαιρετικά: πλήρης διαδρομή υποφακέλου" value={scanFolder} onChange={(event) => setScanFolder(event.target.value)} disabled={busy} />
                    <p className="px-2 py-1 text-xs text-muted-foreground">Ο έλεγχος αλλαγών διαβάζει metadata μόνο για νέα ή τροποποιημένα αρχεία. Ελέγχει ονόματα, μέγεθος και ημερομηνία· ο υποφάκελος περιορίζει τη σάρωση. Τα audio δεν τροποποιούνται.</p>
                  </div>
                  <SpecularButton onClick={runScan} disabled={busy || roots.length === 0} size="sm">
                    {busy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Scan className="h-3.5 w-3.5" />
                    )}
                    {busy ? "Εργασία…" : scanMode === "delta" ? "Έλεγχος αλλαγών" : "Πλήρης σάρωση"}
                  </SpecularButton>
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
                </div>

                {/* local pref: exportConfirm */}
                <label className="flex cursor-pointer items-center justify-between gap-2 px-2 py-1">
                  <span className="text-xs text-cm-muted">Επιβεβαίωση πριν export</span>
                  <Switch
                    size="sm"
                    checked={exportConfirm}
                    onCheckedChange={setExportConfirm}
                    aria-label="Επιβεβαίωση πριν export"
                  />
                </label>

              </GlassPanel>

            </div>

            {/* ── System Overview sidebar ──────────────────────────────────── */}
            <GlassPanel strong className={cn("flex w-full shrink-0 flex-col @[68rem]:w-[240px]", gap, pad)}>
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
              <div className="divide-y divide-cm-contrast/6">
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

              {connection !== "connected" && (
                <p role="status" className="text-xs text-cm-amber">
                  {connection === "retrying"
                    ? "Η σύνδεση διακόπηκε. Γίνεται νέα προσπάθεια· η εργασία μπορεί να συνεχίζεται."
                    : "Σύνδεση με την τρέχουσα εργασία…"}
                </p>
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
              <div className="mt-auto space-y-2 border-t border-cm-contrast/8 pt-3">
                <p className="text-[10px] uppercase tracking-wider text-cm-faint">
                  Γρήγορες Ενέργειες
                </p>
                <Button
                  onClick={runScan}
                  disabled={busy || roots.length === 0}
                  variant="outline"
                  size="sm"
                  className="w-full cursor-pointer disabled:cursor-not-allowed gap-1.5 border-cm-cyan/25 bg-cm-cyan/12 text-xs font-medium text-cm-cyan hover:bg-cm-cyan/20 hover:text-cm-cyan disabled:opacity-40"
                >
                  {busy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                  {scanMode === "delta" ? "Έλεγχος αλλαγών" : "Πλήρης σάρωση"}
                </Button>
                <Button
                  onClick={runFingerprint}
                  disabled={busy || !hasFpcalc}
                  variant="outline"
                  size="sm"
                  className="w-full cursor-pointer disabled:cursor-not-allowed gap-1.5 border-cm-violet/25 bg-cm-violet/14 text-xs font-medium text-cm-violet hover:bg-cm-violet/20 hover:text-cm-violet disabled:opacity-40"
                >
                  <Activity className="h-3.5 w-3.5" />
                  Fingerprint
                </Button>
                {capabilities.analysis && <>
                <Button
                  onClick={() => runAnalyze(false)}
                  disabled={busy || !hasFfmpeg}
                  variant="outline"
                  size="sm"
                  className="w-full cursor-pointer disabled:cursor-not-allowed gap-1.5 border-cm-violet/25 bg-cm-violet/14 text-xs font-medium text-cm-violet hover:bg-cm-violet/20 hover:text-cm-violet disabled:opacity-40"
                  title={!hasFfmpeg ? (isDesktopRuntime() ? "Λείπει το ενσωματωμένο ffmpeg· επανεγκατάστησε το CrateMind" : "Δεν βρέθηκε το ffmpeg στο PATH") : undefined}
                >
                  <AudioWaveform className="h-3.5 w-3.5" />
                  BPM + Key · Μόνο νέα
                </Button>
                <Button
                  onClick={() => runAnalyze(true)}
                  disabled={busy || !hasFfmpeg}
                  variant="outline"
                  size="sm"
                  className="w-full cursor-pointer disabled:cursor-not-allowed gap-1.5 border-cm-violet/25 text-xs text-cm-violet hover:bg-cm-violet/20 hover:text-cm-violet"
                  title="Επανεκτελεί την ανάλυση για όλα τα μη σημειωμένα ως απόντα αρχεία, ακόμη και όσα έχουν ήδη αναλυθεί."
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Επανανάλυση
                </Button>
                <p className="px-2 py-1 text-[10px] text-cm-muted">Μόνο νέα: αρχεία χωρίς προηγούμενη προσπάθεια ανάλυσης. Η πλήρης επανανάλυση επεξεργάζεται ξανά όλη τη βιβλιοθήκη.{!therapy && " Χρησιμοποιεί το εύρος κάθε φακέλου ή την προεπιλογή· αναλύσεις με εύρος που επέλεξες σε crate ή επιλογή αντικαθίστανται."}</p>
                </>}
                <Button
                  onClick={backup}
                  variant="outline"
                  size="sm"
                  className="w-full cursor-pointer disabled:cursor-not-allowed gap-1.5 border-cm-blue/25 bg-cm-blue/12 text-xs font-medium text-cm-blue hover:bg-cm-blue/20 hover:text-cm-blue"
                >
                  <Download className="h-3.5 w-3.5" />
                  {capabilities.complete_backup ? "Δημιουργία πλήρους backup" : "Εξαγωγή metadata (JSON)"}
                </Button>
              </div>
            </GlassPanel>
          </div>

          {/* Advanced vocabulary editor, after the core app/audio/appearance cards */}
          <div className="mt-4">
            <VocabularySettings />
          </div>
        </div>
      </div>
    </div>
  );
}
