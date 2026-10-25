import TrackTable from "../components/TrackTable";
import { sortTracks, type SortState } from "../lib/trackSort";
import CompletenessSummary, { useCompletenessMetrics } from '../components/CompletenessSummary';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { useCapabilities } from "../lib/capabilities";
import { api } from "../lib/api";
import type { ArtistStats, SavedSearch, Track } from "../lib/types";
import type { ChipTone } from "../lib/queryChips";
import { cn } from "../lib/cn";
import { ALL_CAMELOT } from "../lib/camelot";
import { GlassPanel } from "../components/ui/GlassPanel";
import { GlassCard } from "../components/ui/GlassCard";
import { MetricCard } from "../components/ui/MetricCard";
import { AnimatedNumber } from "../components/ui/AnimatedNumber";
import { BentoSpotlight } from "../components/ui/BentoSpotlight";
import { Shiny } from "../components/ui/Shiny";
import { ElectricFrame } from "../components/ui/ElectricFrame";
import { SmartChip } from "../components/ui/SmartChip";
import { SectionHeader } from "../components/ui/SectionHeader";
import { EmptyState } from "../components/ui/EmptyState";
import { Separator } from "../components/ui/separator";
import { IntelRow } from "../components/ui/IntelRow";
import { Artwork } from "../components/ui/Artwork";
import { Waveform } from "../components/ui/Waveform";
import { Gauge, Bars } from "../components/ui/Gauge";
import { usePlayer } from "../lib/player";
import {
  Flame,
  Music2,
  CheckCircle2,
  Trophy,
  Clock,
  Tags,
  Radio,
  Archive,
  Sparkles,
  Split,
  Boxes,
  FileQuestion,
  Pin,
  Trash2,
  Plus,
  Download,
  Play,
  HardDrive,
  Activity,
} from "../lib/icons";

gsap.registerPlugin(useGSAP);

type IconType = ComponentType<{ className?: string }>;

interface Queue {
  label: string;
  query: string;
  to: string;
  hint: string;
  icon: IconType;
  tone: ChipTone;
  flagship?: boolean;
}

interface ArtistCard {
  key: keyof ArtistStats;
  label: string;
  to: string;
  hint: string;
  icon: IconType;
  tone: ChipTone;
}

// flagship "right track for moment" preset (Library mini-syntax).
const FLAGSHIP_QUERY =
  "status:approved darkness:7+ energy:8+ bpm:150-160 role:bridge break:long tolerance:huge not_recent:30 dramatic";

// Top-of-page vital signs — DJ brain at glance.
const STATS: { key: string; label: string; query: string; hint: string; icon: IconType; tone: ChipTone }[] = [
  { key: "tracks",   label: "Tracks",        query: "",                              hint: "στη βιβλιοθήκη",        icon: Music2,       tone: "cyan"       },
  { key: "approved", label: "Εγκεκριμένα",   query: "status:approved",               hint: "έτοιμα για set",        icon: CheckCircle2, tone: "chartreuse" },
  { key: "weapons",  label: "Όπλα",           query: "weapons",                       hint: "δοκιμασμένα",           icon: Trophy,       tone: "amber"      },
  { key: "forgotten",label: "Ξεχασμένα",      query: "status:approved not_recent:90", hint: "90η χωρίς play",        icon: Clock,        tone: "violet"     },
  { key: "untagged", label: "Χωρίς tags",     query: "untagged",                      hint: "θέλουν προφίλ",         icon: Tags,         tone: "blue"       },
  { key: "recent",   label: "Πρόσφατα",       query: "added:30",                      hint: "προστέθηκαν σε 30η",      icon: Radio,        tone: "magenta"    },
];

// Built-in review queues (the dashboard cards from v1.1 spec). Flagship renders first.
const QUEUES: Queue[] = [
  {
    label: "Όπλα",
    query: "weapons",
    to: "/library?q=weapons",
    hint: "δοκιμασμένα, υψηλή σιγουριά",
    icon: Trophy,
    tone: "chartreuse",
    flagship: true,
  },
  {
    label: "Ξεχασμένα εγκεκριμένα",
    query: "status:approved not_recent:90",
    to: "/library?q=" + encodeURIComponent("status:approved not_recent:90"),
    hint: "εγκεκριμένα, 90 ημέρες χωρίς play",
    icon: Archive,
    tone: "violet",
  },
  {
    label: "Εγκεκριμένα που δεν παίχτηκαν",
    query: "status:approved never_played",
    to: "/library?q=" + encodeURIComponent("status:approved never_played"),
    hint: "εγκεκριμένα αλλά ποτέ live",
    icon: Sparkles,
    tone: "magenta",
  },
  {
    label: "Νέα χωρίς tags",
    query: "untagged",
    to: "/tag",
    hint: "θέλουν ταξινόμηση",
    icon: Tags,
    tone: "cyan",
  },
  {
    label: "Υποψήφια με μεγάλα breaks",
    query: "break:long",
    to: "/library?q=" + encodeURIComponent("break:long"),
    hint: "μεγάλα μελωδικά breakdowns",
    icon: Split,
    tone: "blue",
  },
];

const ARTIST_CARDS: ArtistCard[] = [
  {
    key: "unenriched_artists",
    label: "Χωρίς enrichment",
    to: "/artists?view=unenriched",
    hint: "καλλιτέχνες χωρίς προφίλ",
    icon: Sparkles,
    tone: "violet",
  },
  {
    key: "needs_review_artists",
    label: "Θέλουν έλεγχο",
    to: "/artists?view=needs_review",
    hint: "προφίλ χαμηλής βεβαιότητας",
    icon: Tags,
    tone: "amber",
  },
];

// Energy level colours — low (1) → warm (10).
const ENERGY_TONES: ChipTone[] = [
  "blue", "blue", "cyan", "cyan", "chartreuse",
  "chartreuse", "amber", "amber", "magenta", "rose",
];

export default function Dashboard() {
  const capabilities = useCapabilities();
  const completeness = useCompletenessMetrics(capabilities.identity);
  const nav = useNavigate();
  const { play } = usePlayer();

  const [stats,        setStats]        = useState<Record<string, number>>({});
  const [counts,       setCounts]       = useState<Record<string, number>>({});
  const [dupes,        setDupes]        = useState(0);
  const [missingCount, setMissingCount] = useState<number | null>(null);
  const [missingError, setMissingError] = useState(false);
  useEffect(() => {
    let active = true;
    api.trackCount("missing")
      .then(({ count }) => { if (active) setMissingCount(count); })
      .catch(() => { if (active) setMissingError(true); });
    return () => { active = false; };
  }, []);
  const [crates,       setCrates]       = useState<SavedSearch[]>([]);
  const [energyCounts, setEnergyCounts] = useState<number[]>([]);
  const [recentTracks, setRecentTracks] = useState<Track[]>([]);
  const [recentLoading, setRecentLoading] = useState(true);
  const [recentError, setRecentError] = useState("");
  const [recentSort, setRecentSort] = useState<SortState>({key: "added", dir: "desc"});
  useEffect(() => {
    let active = true;
    api.listTracks("added:30", 0).then(rows => { if (active) setRecentTracks(rows); })
      .catch(() => { if (active) setRecentError("Δεν ήταν δυνατή η φόρτωση των πρόσφατων tracks."); })
      .finally(() => { if (active) setRecentLoading(false); });
    return () => { active = false; };
  }, []);
  const [keyed,        setKeyed]        = useState(0);
  const [artistStats,  setArtistStats]  = useState<ArtistStats | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const [crateGrid]  = useAutoAnimate();

  const load = useCallback(async () => {
    // Existing fan-outs — preserved exactly.
    const statEntries = await Promise.all(
      STATS.map(async (s) => [s.key, (await api.trackCount(s.query)).count] as const),
    );
    setStats(Object.fromEntries(statEntries));

    const entries = await Promise.all(
      QUEUES.map(async (q) => [q.label, (await api.trackCount(q.query)).count] as const),
    );
    setCounts(Object.fromEntries(entries));

    setDupes((await api.listDuplicates()).length);
    setCrates(await api.listSearches());
    setArtistStats(await api.artistStats().catch(() => null));

    // Intelligence panel — energy histogram (energy:1..10), key coverage.
    const energyData = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        api.trackCount(`energy:${i + 1}`).then((r) => r.count).catch(() => 0),
      ),
    );
    setEnergyCounts(energyData);

    const keyCounts = await Promise.all(
        ALL_CAMELOT.map((code) => api.trackCount(`key:${code}`).then((r) => r.count).catch(() => 0)),
      );
    setKeyed(keyCounts.reduce((a, b) => a + b, 0));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        gsap.from("[data-reveal]", {
          opacity: 0,
          y: 12,
          duration: 0.4,
          stagger: 0.05,
          ease: "power2.out",
        });
      });
    },
    { scope: containerRef },
  );

  // Derived ratios for Intelligence panel.
  const total        = stats["tracks"]   ?? 0;
  const untaggedCt   = stats["untagged"] ?? 0;
  const tagCoverage  = total > 0 ? (total - untaggedCt) / total                : 0;
  const keyCoverage  = total > 0 ? keyed / total                               : 0;
  const approvedRatio = total > 0 ? (stats["approved"] ?? 0) / total           : 0;
  const weaponsRatio  = total > 0 ? (stats["weapons"]  ?? 0) / total           : 0;

  // 6-tile stat strip: Tracks / Tagged / Untagged / Weapons / Approved / Crates.
  const TILES: { key: string; label: string; value: number | string; tone: ChipTone; icon: IconType }[] = [
    { key: "tracks",   label: "Tracks",    value: stats["tracks"]  ?? "…",                     tone: "cyan",        icon: Music2       },
    { key: "tagged",   label: "Με tags",   value: total > 0 ? total - untaggedCt : "…",         tone: "chartreuse",  icon: CheckCircle2 },
    { key: "untagged", label: "Χωρίς tags",value: stats["untagged"] ?? "…",                    tone: "blue",        icon: Tags         },
    { key: "weapons",  label: "Όπλα",      value: stats["weapons"]  ?? "…",                    tone: "amber",       icon: Trophy       },
    { key: "approved", label: "Εγκεκριμένα",value: stats["approved"] ?? "…",                   tone: "chartreuse",  icon: CheckCircle2 },
    { key: "crates",   label: "Crates",    value: crates.length > 0 ? crates.length : "…",      tone: "violet",      icon: Boxes        },
  ];

  const flagship = QUEUES.find((q) => q.flagship)!;

  // Handlers.
  const importInputRef = useRef<HTMLInputElement>(null);
  const handleImportClick = () => { if (capabilities.backup_import) importInputRef.current?.click(); };
  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !capabilities.backup_import) return;
    try {
      const payload = JSON.parse(await file.text());
      const res = await api.importBackup(payload);
      toast.success(
        `Τα metadata εισήχθησαν — BPM/key σε ${res.analysis_tracks ?? 0} tracks, ` +
          `${res.matched_tracks ?? 0} αντιστοιχίστηκαν, ${res.profiles ?? 0} profiles`,
      );
      load();
    } catch {
      toast.error("Σφάλμα import backup");
    }
  };
  const handleExport  = () =>
    api.exportArtifact("csv", { all_tracks: true }).then((r) => toast.success(`Export ολοκληρώθηκε — ${r.path}`)).catch(() => toast.error("Σφάλμα export"));
  const handleNewCrate = () => {
    const d = new Date().toLocaleDateString("el-GR");
    api.createSearch(`Νέο Crate ${d}`, "").then(load).catch(() => toast.error("Σφάλμα δημιουργίας"));
  };
  const handlePlayFlagship = async () => {
    try {
      const tracks = await api.listTracks(FLAGSHIP_QUERY, 1);
      if (tracks[0]) play(tracks[0]);
      else toast.error("Δεν βρέθηκαν tracks");
    } catch {
      toast.error("Σφάλμα αναπαραγωγής");
    }
  };
  const handleDeleteCrate = (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    api.deleteSearch(id).then(load).catch(() => toast.error("Σφάλμα διαγραφής"));
  };
  const handlePinCrate = (c: SavedSearch, e: React.MouseEvent) => {
    e.stopPropagation();
    api.updateSearch(c.id, { pinned: !c.pinned }).then(load).catch(() => toast.error("Σφάλμα"));
  };

  const weaponsCount = counts["Όπλα"] ?? stats["weapons"] ?? 0;

  return (
    <div ref={containerRef} className="h-full overflow-y-auto overflow-x-hidden">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="sticky top-0 z-10 border-b border-cm-border bg-cm-bg/80 backdrop-blur-md">
        <div className="flex items-center justify-between gap-4 px-6 py-3">
          <div className="flex min-w-0 items-center gap-4">
            <div className="min-w-0">
              <h1 className="text-base font-semibold leading-tight text-cm-text">Πίνακας</h1>
              <p className="text-[11px] text-cm-muted">Βρες το σωστό track πριν χαθεί η στιγμή</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={() => nav("/library?q=" + encodeURIComponent(FLAGSHIP_QUERY))}
              className="hidden sm:flex items-center gap-1.5 rounded-lg border border-cm-chartreuse/30 bg-cm-chartreuse/10 px-3 py-1.5 text-xs font-semibold text-cm-chartreuse transition hover:bg-cm-chartreuse/20 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-chartreuse/50"
            >
              <Flame className="h-3.5 w-3.5" />
              Κύριο Crate
            </button>
            {capabilities.backup_import && <>
            <input
              ref={importInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={handleImportFile}
            />
            <button
              onClick={handleImportClick}
              title="Εισαγωγή metadata από JSON"
              className="flex items-center gap-1.5 rounded-lg border border-cm-line/20 dark:border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-cm-muted transition hover:bg-white/10 hover:text-cm-text cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
            >
              <HardDrive className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Εισαγωγή metadata</span>
            </button>
            </>}
            <button
              onClick={handleExport}
              className="flex items-center gap-1.5 rounded-lg border border-cm-line/20 dark:border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-cm-muted transition hover:bg-white/10 hover:text-cm-text cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
            >
              <Download className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Export</span>
            </button>
            <button
              onClick={handleNewCrate}
              title="Νέο Crate"
              className="grid h-7 w-7 place-items-center rounded-lg border border-cm-line/20 dark:border-white/10 bg-white/5 text-cm-muted transition hover:bg-white/10 hover:text-cm-text cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      <div className="space-y-6 px-6 pt-5 pb-10">

        {/* ── Stat strip (6 tiles) ────────────────────────────────────────── */}
        <BentoSpotlight className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {TILES.map((t) => (
            <div key={t.key} data-reveal className="bento-card rounded-2xl">
              <MetricCard
                value={t.key === "tracks" || t.key === "weapons" ? (
                  <Shiny
                    text={typeof t.value === "number" ? t.value.toLocaleString("el-GR") : t.value}
                    color={`var(--color-cm-${t.tone})`}
                    shineColor="#ffffff"
                  />
                ) : t.value}
                label={t.label}
                icon={t.icon}
                tone={t.tone}
              />
            </div>
          ))}
        </BentoSpotlight>
        {capabilities.identity && <CompletenessSummary metrics={completeness} />}

        {/* ── Main grid: content left + intel right ───────────────────────── */}
        <div className="grid gap-6 lg:grid-cols-[1fr_288px]">

          {/* LEFT ─ Hero · Memory Crates · Recent Activity */}
          <div className="min-w-0 space-y-6">

            {/* Hero — Peak Bridge Weapons ─────────────────────────────────── */}
            <ElectricFrame>
            <GlassPanel strong className="relative overflow-hidden p-0">
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 bg-gradient-to-br from-cm-chartreuse/[0.07] via-transparent to-cm-violet/[0.08]"
              />
              <div className="relative flex gap-4 p-5 sm:p-6">
                <Artwork seed={FLAGSHIP_QUERY} className="h-20 w-20 shrink-0 sm:h-24 sm:w-24" />
                <div className="flex min-w-0 flex-1 flex-col justify-between">
                  <div>
                    <Shiny
                      text="Κύριο preset · Κορυφαία γέφυρα"
                      className="text-[10px] font-semibold uppercase tracking-widest"
                      color="var(--color-cm-chartreuse)"
                      shineColor="var(--color-cm-text)"
                    />
                    <h2 className="mt-1 text-xl font-bold leading-tight">
                      <Shiny text="Peak Bridge Weapons" shineColor="var(--color-cm-cyan)" />
                    </h2>
                    <p className="mt-0.5 line-clamp-1 text-xs text-cm-muted">
                      darkness:7+ · energy:8+ · bpm:150-160 · bridge · not_recent:30
                    </p>
                  </div>
                  <div className="mt-3 flex items-center gap-3">
                    <span className="text-3xl font-bold leading-none tabular-nums text-cm-chartreuse">
                      {weaponsCount ? <AnimatedNumber value={weaponsCount} /> : "…"}
                    </span>
                    <span className="text-xs text-cm-muted">tracks</span>
                    <div className="ml-auto flex items-center gap-2">
                      <button
                        onClick={handlePlayFlagship}
                        className="flex items-center gap-1.5 rounded-lg border border-cm-chartreuse/30 bg-cm-chartreuse/10 px-3 py-1.5 text-xs font-semibold text-cm-chartreuse transition hover:bg-cm-chartreuse/20 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-chartreuse/50"
                      >
                        <Play className="h-3.5 w-3.5 fill-current" />
                        Play
                      </button>
                      <button
                        onClick={() => nav("/library?q=" + encodeURIComponent(FLAGSHIP_QUERY))}
                        className="flex items-center gap-1.5 rounded-lg border border-cm-line/20 dark:border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-cm-muted transition hover:bg-white/10 hover:text-cm-text cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
                      >
                        Library →
                      </button>
                    </div>
                  </div>
                </div>
              </div>
              {/* Cosmetic waveform strip */}
              <div className="relative h-10 border-t border-cm-line/15 dark:border-white/[0.06]">
                <Waveform
                  seed={FLAGSHIP_QUERY}
                  played="var(--color-cm-chartreuse)"
                  className="absolute inset-0 px-5"
                />
              </div>
            </GlassPanel>
            </ElectricFrame>

            {/* Memory Crates ──────────────────────────────────────────────── */}
            <section>
              <SectionHeader
                right={
                  <span className="tabular-nums text-xs text-cm-faint">
                    {crates.length} crates
                  </span>
                }
              >
                Memory Crates
              </SectionHeader>
              {crates.length === 0 ? (
                <EmptyState title="Δεν υπάρχουν αποθηκευμένα crates" />
              ) : (
                <div
                  ref={crateGrid}
                  className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
                >
                  {crates.map((c) => (
                    <GlassCard
                      key={c.id}
                      interactive
                      spotlight
                      onClick={() => nav("/library?q=" + encodeURIComponent(c.query))}
                      className="group flex cursor-pointer flex-col gap-2 p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="line-clamp-2 flex-1 text-sm font-semibold leading-snug text-cm-text">
                          {c.name}
                        </span>
                        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                          <button
                            onClick={(e) => handlePinCrate(c, e)}
                            title={c.pinned ? "Ξεκαρφίτσωσε" : "Καρφίτσωσε"}
                            className={cn(
                              "grid h-6 w-6 place-items-center rounded text-cm-muted transition hover:text-cm-text cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/20",
                              c.pinned && "text-cm-amber opacity-100",
                            )}
                          >
                            <Pin className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={(e) => handleDeleteCrate(c.id, e)}
                            title="Διαγραφή"
                            className="grid h-6 w-6 place-items-center rounded text-cm-muted transition hover:text-cm-rose cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/20"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                      <div className="text-2xl font-bold tabular-nums text-cm-text">
                        <AnimatedNumber value={c.count} />
                      </div>
                      <SmartChip tone="muted" className="min-w-0 max-w-full font-mono text-[10px]">
                        <span className="truncate">{c.query || "…"}</span>
                      </SmartChip>
                    </GlassCard>
                  ))}
                </div>
              )}
            </section>

            <section data-reveal>
              <SectionHeader>Καλλιτέχνες</SectionHeader>
              <div className="grid gap-3 sm:grid-cols-2">
                {ARTIST_CARDS.map((card) => (
                  <GlassCard
                    key={card.key}
                    role="button"
                    onClick={() => nav(card.to)}
                    className="cursor-pointer p-4 transition hover:border-cm-line/30 dark:hover:border-white/15 hover:bg-white/[0.06]"
                  >
                    <div className="flex items-center gap-2">
                      <card.icon className="h-4 w-4 text-cm-cyan" />
                      <div className="text-sm font-medium text-cm-text">{card.label}</div>
                    </div>
                    <div className="mt-2 text-2xl font-bold tabular-nums text-cm-text">
                      {artistStats ? <AnimatedNumber value={artistStats[card.key] ?? 0} /> : "…"}
                    </div>
                    <div className="mt-1 text-xs text-cm-faint">{card.hint}</div>
                  </GlassCard>
                ))}
              </div>
            </section>

            {/* Recent Activity ────────────────────────────────────────────── */}
            <section>
              <SectionHeader
                right={<a href="/library?q=added%3A30" className="text-xs text-cm-cyan hover:underline">30 ημέρες · Άνοιγμα στη βιβλιοθήκη →</a>}
              >
                Πρόσφατα
              </SectionHeader>
              <p className="mb-3 text-xs text-cm-muted">Προστέθηκαν στη βιβλιοθήκη τις τελευταίες 30 ημέρες.</p>
              {recentError ? <p role="alert" className="text-sm text-cm-rose">{recentError}</p> : !recentLoading && recentTracks.length === 0 ? (
                <EmptyState title="Δεν προστέθηκαν tracks τις τελευταίες 30 ημέρες" />
              ) : (
                <div style={{height: recentLoading ? 420 : Math.min(1200, 40 + recentTracks.length * 46), maxHeight: 1200}} className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-cm-line/20">
                  <TrackTable tracks={sortTracks(recentTracks, recentSort)} loading={recentLoading}
                    onSelect={() => nav("/library?q=added%3A30")} onPlay={play}
                    sortKey={recentSort.key} sortDir={recentSort.dir}
                    onSort={key => setRecentSort(current => ({key, dir: current.key === key && current.dir === "asc" ? "desc" : "asc"}))} />
                </div>
              )}
            </section>
          </div>

          {/* RIGHT ─ Intelligence Status + cosmetic waveforms ─────────────── */}
          <div className="space-y-4">

            {/* Intelligence Status panel */}
            <GlassPanel className="p-4">
              <SectionHeader
                right={<Activity className="h-3.5 w-3.5 text-cm-faint" />}
              >
                Κατάσταση Νοημοσύνης
              </SectionHeader>

              {/* Coverage gauges (circular) */}
              <div className="mt-3 flex justify-around">
                <Gauge
                  value={tagCoverage}
                  size={80}
                  tone="chartreuse"
                  sub="Tags"
                />
                <Gauge
                  value={keyCoverage}
                  size={80}
                  tone="cyan"
                  sub="Key"
                />
                <Gauge
                  value={approvedRatio}
                  size={80}
                  tone="violet"
                  sub="Εγκεκρ."
                />
              </div>

              {/* Ratio rows */}
              <div className="mt-2 divide-y divide-cm-line/15 dark:divide-white/[0.06]">
                <IntelRow
                  label="Κάλυψη Tags"
                  value={total > 0 ? `${Math.round(tagCoverage  * 100)}%` : "–"}
                  tone="chartreuse"
                  pct={tagCoverage}
                />
                <IntelRow
                  label="Κάλυψη Key"
                  value={total > 0 ? `${Math.round(keyCoverage  * 100)}%` : "–"}
                  tone="cyan"
                  pct={keyCoverage}
                />
                <IntelRow
                  label="Εγκεκριμένα"
                  value={total > 0 ? `${Math.round(approvedRatio * 100)}%` : "–"}
                  tone="violet"
                  pct={approvedRatio}
                />
                <IntelRow
                  label="Όπλα / σύνολο"
                  value={total > 0 ? `${Math.round(weaponsRatio  * 100)}%` : "–"}
                  tone="amber"
                  pct={weaponsRatio}
                />
              </div>

              {/* Energy Balance histogram */}
              {energyCounts.length > 0 && (
                <>
                  <Separator className="my-3 opacity-[0.08]" />
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-cm-faint">
                    Energy Balance
                  </p>
                  <Bars
                    data={energyCounts.map((c, i) => ({
                      label: String(i + 1),
                      value: c,
                      tone: ENERGY_TONES[i],
                    }))}
                    height={68}
                    onSelect={(lbl) => nav(`/library?q=energy:${lbl}`)}
                    className="w-full"
                  />
                </>
              )}
            </GlassPanel>

            {/* Cosmetic waveform mini-cards */}
            <GlassCard className="p-3">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-cm-faint">
                Peak Bridge
              </p>
              <div className="h-14">
                <Waveform
                  seed="peak-bridge-001"
                  played="var(--color-cm-chartreuse)"
                  progress={0.42}
                  className="h-full"
                />
              </div>
            </GlassCard>

            <GlassCard className="p-3">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-cm-faint">
                Σήμα / Δυναμική
              </p>
              <div className="h-14">
                <Waveform
                  seed="dynamic-signal-007"
                  played="var(--color-cm-violet)"
                  progress={0.67}
                  className="h-full"
                />
              </div>
            </GlassCard>

            {capabilities.identity && <>
            <GlassCard interactive spotlight>
            <MetricCard
              loading={completeness === null}
              value={completeness?.active_collections ?? "…"}
              className="w-full !border-0 !bg-transparent !shadow-none !backdrop-filter-none hover:!translate-y-0"
              label={<span className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3"><span>Καθημερινές συλλογές</span><span aria-hidden="true">→</span></span>}
              tone="cyan"
              onClick={() => nav("/collections")}
            />
            </GlassCard>
            <GlassCard interactive spotlight>
            <MetricCard
              loading={completeness === null}
              value={completeness?.source_observations ?? "…"}
              className="w-full !border-0 !bg-transparent !shadow-none !backdrop-filter-none hover:!translate-y-0"
              label={<span className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3"><span>Αρχικές παρατηρήσεις στο ιστορικό</span><span aria-hidden="true">→</span></span>}
              tone="violet"
              onClick={() => nav("/collections?all_sources=true")}
            />
            </GlassCard>
            </>}
            {/* Dupes quick-access tile */}
            <GlassCard
              interactive
              spotlight
              onClick={() => nav("/duplicates")}
              className="flex cursor-pointer items-center justify-between p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
            >
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-cm-faint">
                  Ύποπτα διπλότυπα
                </p>
                <p className="mt-1 text-xl font-bold tabular-nums text-cm-amber">
                  {dupes ? <AnimatedNumber value={dupes} /> : "…"}
                </p>
              </div>
              <Boxes className="h-8 w-8 text-cm-amber/30" />
            </GlassCard>
            <GlassCard interactive spotlight className="relative">
              <MetricCard
                loading={missingCount === null && !missingError}
                value={missingCount ?? "—"}
                label="Tracks με αρχείο που λείπει"
                hint={<span className="block max-w-[160px] text-balance">{missingError ? "Δεν ήταν δυνατή η φόρτωση του αριθμού" : "Σύμφωνα με τον τελευταίο έλεγχο αρχείων"}</span>}
                tone="rose"
                className="w-full pr-14 !border-0 !bg-transparent !shadow-none !backdrop-filter-none hover:!translate-y-0"
                onClick={() => nav("/library?q=missing")}
              />
              <FileQuestion aria-hidden="true" className="pointer-events-none absolute right-4 top-1/2 h-8 w-8 -translate-y-1/2 text-cm-rose/30" />
            </GlassCard>

          </div>
        </div>
      </div>
    </div>
  );
}
