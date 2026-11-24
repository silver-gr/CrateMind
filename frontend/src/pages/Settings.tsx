import { PlaybackOptions } from "../components/PlaybackOptions";
import { MasterHostSection } from "../components/MasterHostSection";
import BackgroundPicker from "../components/backgrounds/BackgroundPicker";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { hasProviderWorkflows, useCapabilities } from "../lib/capabilities";
import { isDesktopRuntime } from "../lib/desktopRuntime";
import { api } from "../lib/api";
import type { Job } from "../lib/types";
import { pollJob, type JobConnection } from "../lib/jobPolling";
import { cn } from "../lib/cn";
import { jobKindLabel, jobStatusLabel, TASK_RESULT_TOAST, translateJobError, translateJobMessage } from "../lib/labels";
import { SmartChip } from "../components/ui/SmartChip";
import { Gauge } from "../components/ui/Gauge";
import { IntelRow } from "../components/ui/IntelRow";
import { PageTransition } from "../components/ui/PageTransition";
import { BpmAnalysisCard } from "../components/BpmAnalysisCard";
import { DjayBeatgridCard } from "../components/DjayBeatgridCard";
import { DesktopLibrarySettings } from "../components/DesktopLibrarySettings";
import { LibraryExchangeSettings } from "../components/LibraryExchangeSettings";
import { VocabularySettings } from "../components/VocabularySettings";
import { SettingsNav } from "../components/settings/SettingsNav";
import { ChoiceGroup, SettingRow, SettingsCard } from "../components/settings/SettingRow";
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
import { usePref } from "../lib/prefs";
import { preferenceStorage } from "../lib/preferenceStorage";
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
import { SETTINGS_GROUPS, SETTINGS_SECTIONS, type SettingsSectionId } from "../lib/settingsSections";
import { useTheme } from "../lib/theme";
import { clearUnhandledMidi, formatUnhandled, useUnhandledMidi } from "../lib/midiDiagnostics";
import {
  Activity,
  Download,
  Loader2,
  CheckCircle2,
  TriangleAlert,
  CircleDot,
  SettingsIcon,
  RefreshCw,
  Scan,
  AudioWaveform,
  ShieldCheck,
  ChevronDown,
} from "../lib/icons";
import SpecularButton from "../components/ui/SpecularButton";

// Desktop only: read by the backend at launch (config._apply_desktop_backup_keep); "1"–"7", else 3.
const BACKUP_KEEP_KEY = "cratemind-backup-keep";
const BACKUP_KEEP_DAYS = ["1", "2", "3", "4", "5", "6", "7"];

const STATUS_TEXT = {
  chartreuse: "text-cm-chartreuse",
  cyan: "text-cm-cyan",
  amber: "text-cm-amber",
  rose: "text-cm-rose",
} as const;

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
  const [params, setParams] = useSearchParams();

  // ── per-device preferences, applied live ────────────────────────────────
  const [density, setDensity] = usePref("density");
  const [reduceMotion, setReduceMotion] = usePref("reduceMotion");
  const [defaultQueue, setDefaultQueue] = usePref("defaultQueue");
  const [libraryProfile, setLibraryProfile] = usePref("libraryProfile");
  const [autoplayOnSelect, setAutoplayOnSelect] = usePref("autoplayOnSelect");
  const [exportConfirm, setExportConfirm] = usePref("exportConfirm");
  const [showWaveform, setShowWaveform] = usePref("showWaveform");
  const [keyFormat, setKeyFormat] = usePref("keyFormat");
  const [recordingFormat, setRecordingFormat] = usePref("recordingFormat");
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
  const [backupKeep, setBackupKeep] = useState(() => {
    const stored = isDesktopRuntime() ? preferenceStorage.getItem(BACKUP_KEEP_KEY) : null;
    return stored && BACKUP_KEEP_DAYS.includes(stored) ? stored : "3";
  });
  function chooseBackupKeep(value: string) {
    setBackupKeep(value);
    preferenceStorage.setItem(BACKUP_KEEP_KEY, value);
  }

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
        toast.error(translateJobError(terminal.error, `${jobKindLabel(terminal.kind)}: Απέτυχε`), TASK_RESULT_TOAST);
      } else {
        toast.success(terminal.message ? translateJobMessage(terminal.message) : `${jobKindLabel(terminal.kind)}: Ολοκληρώθηκε`, TASK_RESULT_TOAST);
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
  const gaugeLabel = `${healthScore}/4`;
  const problems = 4 - healthScore;
  const systemLabel = problems === 0 ? "Κανένα πρόβλημα" : problems === 1 ? "1 πρόβλημα" : `${problems} προβλήματα`;
  const gaugeTone =
    healthScore === 4
      ? "chartreuse"
      : healthScore >= 3
        ? "cyan"
        : healthScore >= 2
          ? "amber"
          : "rose";

  // ── sections: the sidebar's selection lives in ?section= so it survives reloads and can be linked ──
  const sections = SETTINGS_SECTIONS.filter(section =>
    section.id === "analysis" ? capabilities.analysis || hasProviderWorkflows(capabilities)
      : section.id === "djay" ? libraryProfile === "dj"
        : true);
  const section = sections.find(item => item.id === params.get("section")) ?? sections[0];
  const groupLabel = SETTINGS_GROUPS.find(group => group.id === section.group)?.label;
  function selectSection(id: SettingsSectionId) {
    setParams(previous => {
      const next = new URLSearchParams(previous);
      next.set("section", id);
      return next;
    }, { replace: true });
  }

  const connectionNote = connection === "retrying"
    ? "Η σύνδεση διακόπηκε. Γίνεται νέα προσπάθεια· η εργασία μπορεί να συνεχίζεται."
    : "Σύνδεση με την τρέχουσα εργασία…";
  const jobTone = job?.status === "done" ? "text-cm-chartreuse" : job?.status === "error" ? "text-cm-rose" : "text-cm-amber";
  const showRootRanges = capabilities.analysis && !therapy;

  const statusFooter = (
    <button
      type="button"
      onClick={() => selectSection("status")}
      className="glass flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors duration-150 hover:border-cm-border-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-cyan/60"
    >
      <span aria-hidden="true" className={cn("h-2 w-2 shrink-0 rounded-full bg-current", STATUS_TEXT[gaugeTone])} />
      <span className="min-w-0">
        <span className="block text-xs font-medium text-cm-text">Σύστημα: <span className={STATUS_TEXT[gaugeTone]}>{systemLabel}</span></span>
        <span className="block truncate text-[11px] text-cm-muted">
          {connection !== "connected"
            ? "Σύνδεση με την εργασία…"
            : job
              ? <>{jobKindLabel(job.kind)}: <span className={jobTone}>{jobStatusLabel(job.status)}</span></>
              : "Καμία πρόσφατη εργασία"}
        </span>
      </span>
    </button>
  );

  function renderSection() {
    switch (section.id) {
      case "general":
        return (
          <SettingsCard>
            <SettingRow
              label="Προφίλ χρήσης"
              help="Το DJ ενεργοποιεί το beatgrid από djay και τα εύρη BPM ανά φάκελο. Η μουσικοθεραπεία αναλύει σε εύρος 40–240 BPM."
            >
              <ChoiceGroup
                ariaLabel="Προφίλ χρήσης"
                value={libraryProfile}
                onChange={setLibraryProfile}
                options={[{ value: "dj", label: "DJ" }, { value: "therapy", label: "Μουσικοθεραπεία" }]}
              />
            </SettingRow>
            <SettingRow label="Προεπιλεγμένη ουρά">
              <ChoiceGroup
                ariaLabel="Προεπιλεγμένη ουρά"
                value={defaultQueue}
                onChange={setDefaultQueue}
                options={[
                  { value: "untagged", label: "Αταξινόμητα" },
                  { value: "testing", label: "Δοκιμή" },
                  { value: "", label: "Κανένα" },
                ]}
              />
            </SettingRow>
            <SettingRow label="Μορφή κλειδιού" help="Για tracklist και player. Camelot: 8A · μουσικό: Am.">
              <ChoiceGroup
                ariaLabel="Μορφή κλειδιού"
                value={keyFormat}
                onChange={setKeyFormat}
                options={[
                  { value: "camelot", label: "Camelot" },
                  { value: "musical", label: "Μουσικό" },
                  { value: "both", label: "Και τα δύο" },
                ]}
              />
            </SettingRow>
            <SettingRow label="Επιβεβαίωση πριν export">
              <Switch size="sm" checked={exportConfirm} onCheckedChange={setExportConfirm} aria-label="Επιβεβαίωση πριν export" />
            </SettingRow>
            <SettingRow label="Μορφή εγγραφής set"
              help="WAV: χωρίς απώλειες, ~17 MB/λεπτό. AAC: ~1,9 MB/λεπτό στα 256 kbps, ~1 MB/λεπτό στα 128 kbps. Η εγγραφή γράφεται πρώτα ως WAV και γίνεται AAC όταν σταματήσει· το WAV σβήνεται μόνο αν η μετατροπή πετύχει.">
              <ChoiceGroup
                ariaLabel="Μορφή εγγραφής set"
                value={recordingFormat}
                onChange={setRecordingFormat}
                options={[
                  { value: "wav", label: "WAV" },
                  { value: "aac256", label: "AAC 256 kbps" },
                  { value: "aac128", label: "AAC 128 kbps" },
                ]}
              />
            </SettingRow>
          </SettingsCard>
        );

      case "appearance":
        return (
          <>
            <SettingsCard title="Θέμα">
              <SettingRow label="Θέμα εμφάνισης">
                <ChoiceGroup
                  ariaLabel="Θέμα εμφάνισης"
                  value={theme}
                  onChange={setTheme}
                  options={[{ value: "dark", label: "Νυχτερινό Κενό" }, { value: "light", label: "Ηλιακό Φως" }]}
                />
              </SettingRow>
              <SettingRow label="Φόντο" help="Προσαρμόζεται στο θέμα της εφαρμογής. Η μειωμένη κίνηση κρατά το φόντο στατικό.">
                <BackgroundPicker compact hideLabel />
              </SettingRow>
            </SettingsCard>
            <SettingsCard title="Διάταξη">
              <SettingRow label="Πυκνότητα">
                <ChoiceGroup
                  ariaLabel="Πυκνότητα"
                  value={density}
                  onChange={setDensity}
                  options={[{ value: "comfortable", label: "Άνετη" }, { value: "compact", label: "Συμπαγής" }]}
                />
              </SettingRow>
              <SettingRow label="Σύμπτυξη πλαϊνής μπάρας">
                <ChoiceGroup
                  ariaLabel="Σύμπτυξη πλαϊνής μπάρας"
                  value={sidebarCollapseStyle}
                  onChange={setSidebarCollapseStyle}
                  options={[{ value: "dock", label: "Αιωρούμενη μπάρα" }, { value: "rail", label: "Στενή πλαϊνή μπάρα" }]}
                />
              </SettingRow>
              <SettingRow label="Μειωμένη κίνηση">
                <Switch size="sm" checked={reduceMotion} onCheckedChange={setReduceMotion} aria-label="Μειωμένη κίνηση" />
              </SettingRow>
            </SettingsCard>
          </>
        );

      case "folders":
        return (
          <>
            {capabilities.native_dialogs && <DesktopLibrarySettings connectedRoots={roots} />}
            <SettingsCard title="Συνδεδεμένοι φάκελοι">
              {roots.length > 0 ? (
                roots.map(root => (
                  <SettingRow key={root} label={<span className="break-all font-mono text-xs">{root}</span>}>
                    {showRootRanges && (
                      <Select value={isDjRangeKey(tempoRangeByRoot[root]) ? tempoRangeByRoot[root] : "default"} onValueChange={value => setRootRange(root, value)}>
                        <SelectTrigger size="sm" className="w-[190px] max-w-full text-xs" aria-label={`Εύρος BPM για ${root}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="default">Όπως η προεπιλογή</SelectItem>
                          {DJ_RANGE_KEYS.map(key => (
                            <SelectItem key={key} value={key}>{TEMPO_RANGE_LABELS[key]}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </SettingRow>
                ))
              ) : (
                <p className="px-4 py-3.5 text-xs text-cm-muted">
                  {capabilities.native_dialogs ? "Πρόσθεσε ή αντιστοίχισε έναν φάκελο μουσικής παραπάνω." : <>Δεν έχουν οριστεί library roots. Βάλε{" "}
                    <code className="rounded bg-cm-contrast/5 px-1 font-mono">CRATEMIND_LIBRARY_ROOTS</code> στο{" "}
                    <code className="rounded bg-cm-contrast/5 px-1 font-mono">backend/.env</code> και κάνε restart το backend.</>}
                </p>
              )}
              {roots.length > 0 && showRootRanges && (
                <p className="px-4 py-3 text-xs text-cm-muted">Το εύρος BPM ανά φάκελο ισχύει για νέες αναλύσεις των tracks του.</p>
              )}
            </SettingsCard>
          </>
        );

      case "scan":
        return (
          <>
            <SettingsCard>
              <SettingRow
                label="Τρόπος σάρωσης"
                help="Ο έλεγχος αλλαγών διαβάζει metadata μόνο για νέα ή τροποποιημένα αρχεία, με βάση όνομα, μέγεθος και ημερομηνία. Η πλήρης σάρωση ανανεώνει τα metadata όλων."
              >
                <ChoiceGroup
                  ariaLabel="Τρόπος σάρωσης"
                  value={scanMode}
                  onChange={setScanMode}
                  disabled={busy}
                  options={[{ value: "delta", label: "Μόνο αλλαγές" }, { value: "full", label: "Πλήρης σάρωση" }]}
                />
              </SettingRow>
              <SettingRow label="Υποφάκελος" help="Προαιρετικό. Περιορίζει τη σάρωση σε έναν υποφάκελο.">
                <Input
                  aria-label="Φάκελος σάρωσης"
                  placeholder="Πλήρης διαδρομή υποφακέλου"
                  value={scanFolder}
                  onChange={event => setScanFolder(event.target.value)}
                  disabled={busy}
                  className="h-8 w-72 max-w-full text-xs"
                />
              </SettingRow>
              <div className="flex flex-wrap items-center justify-between gap-3 bg-cm-contrast/[0.025] px-4 py-3.5">
                <p className="flex items-center gap-2 text-xs text-cm-muted">
                  <ShieldCheck className="h-4 w-4 shrink-0 text-cm-chartreuse" />
                  Τα αρχεία ήχου δεν τροποποιούνται.
                </p>
                <SpecularButton onClick={runScan} disabled={busy || roots.length === 0} size="sm">
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Scan className="h-3.5 w-3.5" />}
                  {busy ? "Εργασία…" : scanMode === "delta" ? "Έλεγχος αλλαγών" : "Πλήρης σάρωση"}
                </SpecularButton>
              </div>
            </SettingsCard>
            <SettingsCard>
              <SettingRow label="Fingerprint" help="Ακουστικά αποτυπώματα Chromaprint για τον εντοπισμό διπλότυπων. Χρειάζεται το fpcalc.">
                <SmartChip tone={hasFpcalc ? "cyan" : "muted"} icon={hasFpcalc ? CheckCircle2 : CircleDot}>
                  fpcalc {hasFpcalc ? "βρέθηκε" : "προαιρετικό"}
                </SmartChip>
                <Button onClick={runFingerprint} disabled={busy || !hasFpcalc} variant="outline" size="sm">
                  <Activity className="h-3.5 w-3.5" />
                  Fingerprint
                </Button>
              </SettingRow>
            </SettingsCard>
          </>
        );

      case "vocabularies":
        return <VocabularySettings />;

      case "analysis":
        return (
          <>
            {capabilities.analysis && (
              <SettingsCard>
                <SettingRow label="Εργαλεία" help="Εντοπίζονται αυτόματα. Η εφαρμογή για υπολογιστή τα έχει ενσωματωμένα.">
                  <SmartChip tone={hasFfmpeg ? "cyan" : "rose"} icon={hasFfmpeg ? CheckCircle2 : TriangleAlert}>
                    ffmpeg {hasFfmpeg ? "βρέθηκε" : "λείπει"}
                  </SmartChip>
                  <SmartChip tone={hasFfprobe ? "cyan" : "rose"} icon={hasFfprobe ? CheckCircle2 : TriangleAlert}>
                    ffprobe {hasFfprobe ? "βρέθηκε" : "λείπει"}
                  </SmartChip>
                </SettingRow>
                {therapy ? (
                  <SettingRow label="Εύρος BPM ανάλυσης" help="Μουσικοθεραπεία. Μουσική χωρίς σταθερό ρυθμό μένει χωρίς BPM.">
                    <span className="font-mono text-xs tabular-nums text-cm-text">40–240 BPM</span>
                  </SettingRow>
                ) : (
                  <SettingRow
                    label="Εύρος BPM ανάλυσης"
                    help="Ισχύει για νέες αναλύσεις. Για tracks που έχουν ήδη αναλυθεί, χρησιμοποίησε «Ανάλυση BPM» σε επιλογή ή crate."
                  >
                    <Select value={isDjRangeKey(djTempoRange) ? djTempoRange : DEFAULT_DJ_RANGE} onValueChange={value => setDjTempoRange(value as DjRangeKey)}>
                      <SelectTrigger size="sm" className="w-[210px] max-w-full text-xs" aria-label="Εύρος BPM ανάλυσης">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {DJ_RANGE_KEYS.map(key => (
                          <SelectItem key={key} value={key}>{TEMPO_RANGE_LABELS[key]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </SettingRow>
                )}
                <SettingRow
                  label="Εκτέλεση ανάλυσης"
                  help="Μόνο νέα: αρχεία χωρίς προηγούμενη προσπάθεια ανάλυσης, και μέτρηση LUFS όσων tracks δεν έχουν μετρηθεί ακόμη. Η επανανάλυση επεξεργάζεται ξανά όλη τη βιβλιοθήκη, εκτός από όσα αρχεία σημειώθηκαν ως απόντα."
                >
                  <Button
                    onClick={() => runAnalyze(true)}
                    disabled={busy || !hasFfmpeg}
                    variant="outline"
                    size="sm"
                    title="Επανεκτελεί την ανάλυση για όλα τα μη σημειωμένα ως απόντα αρχεία, ακόμη και όσα έχουν ήδη αναλυθεί."
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Επανανάλυση
                  </Button>
                  <SpecularButton onClick={() => runAnalyze(false)} disabled={busy || !hasFfmpeg} size="sm">
                    {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <AudioWaveform className="h-3.5 w-3.5" />}
                    BPM + Key · μόνο νέα
                  </SpecularButton>
                </SettingRow>
                {!hasFfmpeg && (
                  <p role="status" className="px-4 py-3 text-xs text-cm-rose">
                    {isDesktopRuntime() ? "Λείπει το ενσωματωμένο ffmpeg· επανεγκατάστησε το CrateMind." : "Δεν βρέθηκε το ffmpeg στο PATH."}
                  </p>
                )}
              </SettingsCard>
            )}
            {hasProviderWorkflows(capabilities) && (
              <BpmAnalysisCard job={job} busy={busy} canAnalyze={hasFfmpeg} onRunAnalyze={() => runAnalyze(false)} />
            )}
          </>
        );

      case "djay":
        return <DjayBeatgridCard job={job} busy={busy} onStarted={followJob} />;

      case "playback":
        return (
          <>
            <SettingsCard title="Ένταση ακρόασης">
              <div className="px-4 pb-4 pt-2">
                <PlaybackOptions />
                <MasterHostSection />
              </div>
            </SettingsCard>
            <SettingsCard>
              <SettingRow label="Αυτόματη αναπαραγωγή επιλογής">
                <Switch size="sm" checked={autoplayOnSelect} onCheckedChange={setAutoplayOnSelect} aria-label="Αυτόματη αναπαραγωγή επιλογής" />
              </SettingRow>
            </SettingsCard>
          </>
        );

      case "waveforms":
        return (
          <SettingsCard>
            <SettingRow label="Κυματομορφή μεταφοράς">
              <Switch size="sm" checked={showWaveform} onCheckedChange={setShowWaveform} aria-label="Κυματομορφή μεταφοράς" />
            </SettingRow>
            <SettingRow label="Χρώματα κυματομορφής" help="Στα decks και στην επισκόπηση του track.">
              <ChoiceGroup
                ariaLabel="Χρώματα κυματομορφής"
                value={waveformPalette}
                onChange={setWaveformPalette}
                options={[{ value: "theme", label: "Θέμα (πλήρες φάσμα)" }, { value: "frequency", label: "Συχνότητες (djay)" }]}
              />
            </SettingRow>
            <SettingRow label="Θέση κυματομορφών decks" help="Σε λειτουργία δύο decks.">
              <ChoiceGroup
                ariaLabel="Θέση κυματομορφών decks"
                value={deckViewPosition}
                onChange={setDeckViewPosition}
                options={[{ value: "top", label: "Πάνω" }, { value: "bottom", label: "Κάτω, πάνω από τα decks" }]}
              />
            </SettingRow>
          </SettingsCard>
        );

      case "backup":
        return (
          <>
            <SettingsCard>
              <SettingRow
                label={capabilities.complete_backup ? "Πλήρες backup" : "Εξαγωγή metadata"}
                help={capabilities.complete_backup
                  ? "Κράτησε το JSON μαζί με τον συνοδευτικό φάκελο για πλήρη επαναφορά της βιβλιοθήκης."
                  : "Εξάγονται τα metadata. Η πλήρης επαναφορά της ενοποιημένης βιβλιοθήκης δεν υποστηρίζεται σε αυτή την εγκατάσταση."}
              >
                <SpecularButton onClick={backup} size="sm">
                  <Download className="h-3.5 w-3.5" />
                  {capabilities.complete_backup ? "Πλήρες backup" : "Εξαγωγή metadata (JSON)"}
                </SpecularButton>
              </SettingRow>
              {isDesktopRuntime() && (
                <SettingRow
                  label="Αντίγραφα ασφαλείας που κρατιούνται"
                  help="Όταν ανοίγει, η εφαρμογή φτιάχνει αντίγραφο ασφαλείας της βιβλιοθήκης, το πολύ ένα την ημέρα. Εδώ ορίζεις πόσα κρατιούνται, από 1 έως 7: με 7 μπορείς να επαναφέρεις τη βιβλιοθήκη όπως ήταν σε μία από τις 7 τελευταίες ημέρες που άνοιξε η εφαρμογή (οι ημέρες που έμεινε κλειστή δεν μετράνε). Λιγότερες ημέρες πιάνουν λιγότερο χώρο. Η αλλαγή ισχύει την επόμενη φορά που θα ανοίξει η εφαρμογή."
                >
                  <Select value={backupKeep} onValueChange={chooseBackupKeep}>
                    <SelectTrigger size="sm" className="w-[190px] max-w-full text-xs" aria-label="Αντίγραφα ασφαλείας που κρατιούνται">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {BACKUP_KEEP_DAYS.map(days => (
                        <SelectItem key={days} value={days}>
                          {days === "1" ? "1 ημέρα" : `${days} ημέρες`}{days === "3" ? " (προεπιλογή)" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </SettingRow>
              )}
            </SettingsCard>
            {capabilities.library_exchange && <LibraryExchangeSettings desktop={!!capabilities.native_dialogs} />}
            {(dbPath || outputDir || backupDir) && (
              <SettingsCard title="Διαδρομές">
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 px-4 pb-4 pt-2 text-xs">
                  {dbPath && <><dt className="text-cm-muted">Βάση δεδομένων</dt><dd className="break-all font-mono text-cm-text">{dbPath}</dd></>}
                  {outputDir && <><dt className="text-cm-muted">Φάκελος export</dt><dd className="break-all font-mono text-cm-text">{outputDir}</dd></>}
                  {backupDir && <><dt className="text-cm-muted">Φάκελος backup</dt><dd className="break-all font-mono text-cm-text">{backupDir}</dd></>}
                </dl>
              </SettingsCard>
            )}
          </>
        );

      case "status":
        return (
          <>
            <SettingsCard>
              <div className="flex flex-wrap items-center gap-x-8 gap-y-4 p-5">
                <Gauge value={gaugeValue} size={112} tone={gaugeTone} label={gaugeLabel} sub="Σύστημα" />
                <div className="min-w-0 flex-[1_1_16rem] space-y-1">
                  <IntelRow label="ffprobe" value={hFfprobe ? "OK" : "—"} tone={hFfprobe ? "cyan" : "rose"} />
                  <IntelRow label="fpcalc" value={hFpcalc ? "OK" : "—"} tone={hFpcalc ? "chartreuse" : "muted"} />
                  <IntelRow label="Βάση Δεδομένων" value={hDb ? "OK" : "—"} tone={hDb ? "cyan" : "rose"} />
                  <IntelRow label="Βιβλιοθήκη" value={hRoots ? String(roots.length) : "—"} tone={hRoots ? "chartreuse" : "amber"} />
                </div>
              </div>
            </SettingsCard>
            <SettingsCard title="Τελευταία εργασία">
              {connection !== "connected" && <p role="status" className="px-4 py-3 text-xs text-cm-amber">{connectionNote}</p>}
              {job ? (
                <SettingRow label={jobKindLabel(job.kind)}>
                  <Badge variant="outline" className={cn("border-transparent px-1.5 py-0 text-[11px] font-medium", jobTone)}>
                    {jobStatusLabel(job.status)}
                  </Badge>
                </SettingRow>
              ) : (
                connection === "connected" && <p className="px-4 py-3 text-xs text-cm-muted">Δεν υπάρχει πρόσφατη εργασία.</p>
              )}
            </SettingsCard>
            {isDesktopRuntime() && <UnhandledMidiCard />}
          </>
        );
    }
  }

  return (
    <div className="flex h-full flex-col text-sm">
      <PageHeader
        icon={SettingsIcon}
        title="Ρυθμίσεις"
        subtitle="Διαμόρφωσε το CrateMind ανάλογα με τη ροή σου. Όλα παραμένουν τοπικά."
      />
      <div className="@container min-h-0 flex-1">
        <div className="flex h-full flex-col @[52rem]:flex-row">
          <SettingsNav sections={sections} current={section.id} onSelect={selectSection} footer={statusFooter} />
          <div key={section.id} className="scroll-fade-y min-h-0 min-w-0 flex-1 overflow-auto">
            <PageTransition>
              <section aria-labelledby="settings-section-title" className="flex max-w-[880px] flex-col gap-4 p-6">
                <header className="mb-1 space-y-1.5">
                  {groupLabel && <p className="micro-label text-cm-faint">{groupLabel}</p>}
                  <h2 id="settings-section-title" className="text-xl font-semibold tracking-tight text-cm-text">{section.label}</h2>
                  <p className="max-w-prose text-sm text-cm-muted">{section.description}</p>
                </header>
                {renderSection()}
              </section>
            </PageTransition>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Controller diagnostics (desktop only): the MIDI messages CrateMind received but does not use, newest first. */
function UnhandledMidiCard() {
  const entries = useUnhandledMidi();
  return (
    <SettingsCard title="Controller">
      <div className="px-4 py-3">
        <details className="group/midi min-w-0">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md py-1 text-sm font-medium text-cm-text focus-visible:outline-2 focus-visible:outline-cm-cyan [&::-webkit-details-marker]:hidden">
            <ChevronDown aria-hidden className="size-3.5 shrink-0 -rotate-90 transition-transform group-open/midi:rotate-0 motion-reduce:transition-none" />
            Μηνύματα χωρίς αντιστοίχιση
            <span className="ml-auto font-mono text-xs tabular-nums text-cm-faint">{entries.length}</span>
          </summary>
          <p className="mt-1 max-w-prose text-xs leading-relaxed text-cm-muted">
            Κουμπιά και knobs του controller που το CrateMind δεν χρησιμοποιεί ακόμα. Κρατιούνται μόνο όσο είναι ανοιχτή η εφαρμογή.
          </p>
          {entries.length > 0 ? (
            <ol className="mt-2 space-y-0.5 text-xs">
              {entries.map(e => (
                <li key={`${e.status}-${e.d1}`} className="flex justify-between gap-4">
                  <span className="font-mono tabular-nums text-cm-text">{formatUnhandled(e)}</span>
                  <span className="tabular-nums text-cm-faint">{new Date(e.at).toLocaleTimeString("el-GR")}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-2 text-xs text-cm-faint">Κανένα μήνυμα ακόμα.</p>
          )}
          <Button variant="outline" size="sm" className="mt-3" disabled={entries.length === 0} onClick={clearUnhandledMidi}>
            Καθαρισμός
          </Button>
        </details>
      </div>
    </SettingsCard>
  );
}
