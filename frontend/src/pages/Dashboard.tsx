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
import { notifyFacetsChanged, useFacets } from "../lib/facets";
import type { ArtistStats, DJSet, SavedSearch, Track } from "../lib/types";
import { parseQueryChips, type ChipTone } from "../lib/queryChips";
import { cn } from "../lib/cn";
import { ALL_CAMELOT, formatKey, keyColor, type KeyFormat } from "../lib/camelot";
import { effectiveBpm } from "../lib/tempo";
import { bpmColor } from "../lib/bpmColor";
import { relativeTime } from "../lib/deckHistory";
import { dealColumns } from "../lib/masonry";
import { useMediaQuery } from "../lib/useMediaQuery";
import { libraryPlaceholder } from "../lib/profileCopy";
import {
  ATTENTION_QUERIES,
  RECENT_PLAYS_QUERY,
  latestSet,
  libraryHref,
  recentPlays,
  resolveMainCrate,
  toggleMainCrate,
} from "../lib/dashboardStart";
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
import { Gauge, Bars } from "../components/ui/Gauge";
import { Button } from "@/components/ui/button";
import { usePlayer, type DeckId } from "../lib/player";
import { usePref } from "../lib/prefs";
import { quickLists, therapyStats } from "../lib/dashboardTherapy";
import { progressLine } from "../lib/queuePaging";
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
  Search,
  Star,
  TriangleAlert,
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
  const { play, load: loadDeck } = usePlayer();
  const [profile] = usePref("libraryProfile");
  const therapy = profile === "therapy";
  const [mainCrateId, setMainCrateId] = usePref("mainCrateId");
  const [keyFormat] = usePref("keyFormat");
  const { facets } = useFacets();
  const [searchText, setSearchText] = useState("");

  const [stats,        setStats]        = useState<Record<string, number>>({});
  const [counts,       setCounts]       = useState<Record<string, number>>({});
  const [dupes,        setDupes]        = useState<number | null>(null);
  const [attention,    setAttention]    = useState<Record<string, number | null>>({});
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
  const [cratesLoaded, setCratesLoaded] = useState(false);
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
  // «Συνέχεια»: the last played tracks and the newest set (undefined while loading).
  const [plays, setPlays] = useState<Track[] | null>(null);
  const [playsError, setPlaysError] = useState(false);
  useEffect(() => {
    let active = true;
    api.listTracks(RECENT_PLAYS_QUERY, 0).then(rows => { if (active) setPlays(recentPlays(rows)); })
      .catch(() => { if (active) setPlaysError(true); });
    return () => { active = false; };
  }, []);
  // The tracks last loaded into a deck on this device, fetched fresh; deleted ones are skipped.
  const [deckLoads] = usePref("recentDeckLoads");
  const deckLoadIds = deckLoads.slice(0, 8).map((e) => e.id).join(",");
  const [deckTracks, setDeckTracks] = useState<Map<number, Track> | null>(null);
  useEffect(() => {
    let active = true;
    const ids = deckLoadIds ? deckLoadIds.split(",").map(Number) : [];
    void Promise.allSettled(ids.map((id) => api.getTrack(id))).then((results) => {
      if (!active) return;
      const found = new Map<number, Track>();
      results.forEach((r) => { if (r.status === "fulfilled") found.set(r.value.track.id, r.value.track); });
      setDeckTracks(found);
    });
    return () => { active = false; };
  }, [deckLoadIds]);
  const recentLoads = deckTracks === null ? null : deckLoads.slice(0, 8).flatMap((e) => {
    const track = deckTracks.get(e.id);
    return track ? [{ ...e, track }] : [];
  });
  // «Συνέχεια» masonry: two columns only where the rows keep room for their titles.
  const continueColumns = useMediaQuery("(min-width: 1536px)") ? 2 : 1;
  const [lastSet, setLastSet] = useState<DJSet | null | undefined>(undefined);
  const [setsError, setSetsError] = useState(false);
  useEffect(() => {
    let active = true;
    api.listSets().then(rows => { if (active) setLastSet(latestSet(rows)); })
      .catch(() => { if (active) setSetsError(true); });
    return () => { active = false; };
  }, []);
  const [keyed,        setKeyed]        = useState(0);
  const [artistStats,  setArtistStats]  = useState<ArtistStats | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const [crateGrid]  = useAutoAnimate();

  // The hero's crates load on their own, so it never waits on (or dies with) the count fan-out.
  const [cratesError, setCratesError] = useState(false);
  const loadCrates = useCallback(async () => {
    try {
      setCrates(await api.listSearches());
      setCratesLoaded(true);
      setCratesError(false);
    } catch {
      setCratesError(true);
    }
  }, []);

  const load = useCallback(async () => {
    void loadCrates();
    void Promise.all(
      ATTENTION_QUERIES.map(async (q) => [q.key, await api.trackCount(q.query).then((r) => r.count).catch(() => null)] as const),
    ).then((entries) => setAttention(Object.fromEntries(entries)));

    // Existing fan-outs. Therapy drops the weapons count and the review queues.
    const statDefs = therapy ? therapyStats(STATS) : STATS;
    const statEntries = await Promise.all(
      statDefs.map(async (s) => [s.key, (await api.trackCount(s.query)).count] as const),
    );
    setStats(Object.fromEntries(statEntries));

    const entries = await Promise.all(
      (therapy ? [] : QUEUES).map(async (q) => [q.label, (await api.trackCount(q.query)).count] as const),
    );
    setCounts(Object.fromEntries(entries));

    setDupes((await api.listDuplicates()).length);
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
  }, [therapy, loadCrates]);

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
  const tiles = therapy ? therapyStats(TILES) : TILES;

  // Hero: the main crate, or «Όπλα» when none is set (or it was deleted).
  const hero = resolveMainCrate(crates, mainCrateId, counts["Όπλα"] ?? stats["weapons"] ?? null);
  const heroChips = parseQueryChips(hero.query, facets);

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
      notifyFacetsChanged(); // the backup restores vocabularies
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
  const handlePlayHero = async () => {
    try {
      const tracks = await api.listTracks(hero.query, 1);
      if (tracks[0]) play(tracks[0]);
      else toast.error("Δεν βρέθηκαν tracks");
    } catch {
      toast.error("Σφάλμα αναπαραγωγής");
    }
  };
  const handleDeleteCrate = (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    api.deleteSearch(id).then(() => {
      if (mainCrateId === id) setMainCrateId(null);
      return load();
    }).catch(() => toast.error("Σφάλμα διαγραφής"));
  };
  const handleMainCrate = (c: SavedSearch, e: React.MouseEvent) => {
    e.stopPropagation();
    setMainCrateId(toggleMainCrate(mainCrateId, c.id));
  };
  function loadOnDeck(deck: DeckId, track: Track) {
    if (!loadDeck(deck, track, { play: false, ifIdle: true })) toast(`Το Deck ${deck} παίζει — δεν φορτώθηκε`);
  }
  const handlePinCrate = (c: SavedSearch, e: React.MouseEvent) => {
    e.stopPropagation();
    api.updateSearch(c.id, { pinned: !c.pinned }).then(load).catch(() => toast.error("Σφάλμα"));
  };

  const pinnedCrates = quickLists(crates);

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
            {!therapy && (
            <button
              onClick={() => nav(libraryHref(hero.query))}
              disabled={!cratesLoaded}
              className="hidden sm:flex items-center gap-1.5 rounded-lg border border-cm-chartreuse/30 bg-cm-chartreuse/10 px-3 py-1.5 text-xs font-semibold text-cm-chartreuse transition hover:bg-cm-chartreuse/20 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-chartreuse/50 disabled:cursor-default disabled:opacity-40"
            >
              <Flame className="h-3.5 w-3.5" />
              Κύριο Crate
            </button>
            )}
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

        {/* ── Quick search + pinned crates ─────────────────────────────────── */}
        <section data-reveal className="space-y-2.5">
          <form
            role="search"
            onSubmit={(e) => { e.preventDefault(); nav(libraryHref(searchText.trim())); }}
            className="flex items-center gap-2 rounded-xl border border-cm-line/20 dark:border-white/10 bg-white/5 px-3 py-2 focus-within:ring-2 focus-within:ring-white/20"
          >
            <Search aria-hidden className="h-4 w-4 shrink-0 text-cm-faint" />
            <input
              type="search"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder={libraryPlaceholder(profile)}
              aria-label="Αναζήτηση στη βιβλιοθήκη"
              className="min-w-0 flex-1 bg-transparent text-sm text-cm-text outline-none placeholder:text-cm-faint"
            />
          </form>
          {pinnedCrates.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {pinnedCrates.map((c) => (
                <SmartChip
                  key={c.id}
                  tone={mainCrateId === c.id ? "amber" : "muted"}
                  title={mainCrateId === c.id ? "Κύριο crate" : undefined}
                  onClick={() => nav(libraryHref(c.query))}
                  className="text-[11px]"
                >
                  {mainCrateId === c.id && <><span aria-hidden>★ </span><span className="sr-only">Κύριο crate: </span></>}
                  {c.name}
                  <span className="ml-1.5 tabular-nums opacity-70">{c.count.toLocaleString("el-GR")}</span>
                </SmartChip>
              ))}
            </div>
          )}
        </section>

        {/* ── Stat strip (6 tiles) ────────────────────────────────────────── */}
        <BentoSpotlight className={cn("grid grid-cols-2 gap-3 sm:grid-cols-3", therapy ? "lg:grid-cols-5" : "lg:grid-cols-6")}>
          {tiles.map((t) => (
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

          {/* LEFT ─ Hero · Συνέχεια · Memory Crates · Recent Activity */}
          <div className="min-w-0 space-y-6">

            {/* Therapy: the sorting progress, from the stats already loaded ─── */}
            {therapy && total > 0 && (
              <GlassCard
                role="link"
                tabIndex={0}
                onClick={() => nav("/tag")}
                onKeyDown={(e) => { if (e.key === "Enter") nav("/tag"); }}
                className="flex cursor-pointer items-center justify-between gap-3 p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
              >
                <span className="text-sm font-semibold tabular-nums text-cm-text">
                  {progressLine(total - untaggedCt, total)}
                </span>
                <span className="text-xs text-cm-cyan">Ουρά tagging →</span>
              </GlassCard>
            )}

            {/* Hero — the main crate ─────────────────────────────────────── */}
            {!therapy && (
            <ElectricFrame>
            <GlassPanel strong className="relative overflow-hidden p-0">
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 bg-gradient-to-br from-cm-chartreuse/[0.07] via-transparent to-cm-violet/[0.08]"
              />
              <div className="relative flex gap-4 p-5 sm:p-6">
                <Artwork seed={hero.query || hero.name} className="h-20 w-20 shrink-0 sm:h-24 sm:w-24" />
                <div className="flex min-w-0 flex-1 flex-col justify-between">
                  <div>
                    <Shiny
                      text="Κύριο crate"
                      className="text-[10px] font-semibold uppercase tracking-widest"
                      color="var(--color-cm-chartreuse)"
                      shineColor="var(--color-cm-text)"
                    />
                    <h2 className="mt-1 truncate text-xl font-bold leading-tight">
                      {cratesLoaded ? <Shiny text={hero.name} shineColor="var(--color-cm-cyan)" /> : "…"}
                    </h2>
                    {cratesLoaded && heroChips.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {heroChips.slice(0, 5).map((c, i) => (
                          <SmartChip key={i} tone={c.tone} className="text-[11px]">{c.label}</SmartChip>
                        ))}
                        {heroChips.length > 5 && (
                          <SmartChip tone="muted" className="text-[11px]">+{heroChips.length - 5}</SmartChip>
                        )}
                      </div>
                    )}
                    {cratesLoaded && hero.fallback && (
                      <p className="mt-1.5 text-[11px] text-cm-faint">Όρισε ένα crate ως κύριο με το ☆ που εμφανίζεται όταν περνάς πάνω από ένα crate</p>
                    )}
                    {!cratesLoaded && cratesError && (
                      <p role="alert" className="mt-1.5 text-[11px] text-cm-rose">Δεν ήταν δυνατή η φόρτωση των crates.</p>
                    )}
                  </div>
                  <div className="mt-3 flex items-center gap-3">
                    <span className="text-3xl font-bold leading-none tabular-nums text-cm-chartreuse">
                      {cratesLoaded && hero.count !== null ? <AnimatedNumber value={hero.count} /> : "…"}
                    </span>
                    <span className="text-xs text-cm-muted">tracks</span>
                    <div className="ml-auto flex items-center gap-2">
                      <button
                        onClick={handlePlayHero}
                        disabled={!cratesLoaded}
                        className="flex items-center gap-1.5 rounded-lg border border-cm-chartreuse/30 bg-cm-chartreuse/10 px-3 py-1.5 text-xs font-semibold text-cm-chartreuse transition hover:bg-cm-chartreuse/20 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-chartreuse/50 disabled:cursor-default disabled:opacity-40"
                      >
                        <Play className="h-3.5 w-3.5 fill-current" />
                        Play
                      </button>
                      <button
                        onClick={() => nav(libraryHref(hero.query))}
                        disabled={!cratesLoaded}
                        className="flex items-center gap-1.5 rounded-lg border border-cm-line/20 dark:border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-cm-muted transition hover:bg-white/10 hover:text-cm-text cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20 disabled:cursor-default disabled:opacity-40"
                      >
                        Library →
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </GlassPanel>
            </ElectricFrame>
            )}

            {/* Συνέχεια — deck loads, logged plays and the newest set, as a masonry ── */}
            <section data-reveal>
              <SectionHeader>Συνέχεια</SectionHeader>
              <div className="grid items-start gap-3" style={{ gridTemplateColumns: `repeat(${continueColumns}, minmax(0, 1fr))` }}>
                {dealColumns([
                  <GlassCard key="loads" className="min-w-0 py-3">
                    <p className="mb-1 px-4 text-[10px] font-semibold uppercase tracking-widest text-cm-faint">Φορτώθηκαν πρόσφατα</p>
                    {recentLoads === null ? (
                      <p className="px-4 py-2 text-sm text-cm-faint">…</p>
                    ) : recentLoads.length === 0 ? (
                      <p className="px-4 py-2 text-sm text-cm-muted">Δεν έχει φορτωθεί ακόμη κάποιο track σε deck.</p>
                    ) : (
                      <ul className="divide-y divide-cm-line/15 dark:divide-white/[0.06]">
                        {recentLoads.map((e) => (
                          <ContinueRow
                            key={e.id}
                            track={e.track}
                            keyFormat={keyFormat}
                            meta={`Deck ${e.deck} · ${relativeTime(e.at, Date.now())}`}
                            onDeck={loadOnDeck}
                          />
                        ))}
                      </ul>
                    )}
                  </GlassCard>,
                  <GlassCard key="plays" className="min-w-0 py-3">
                    <p className="mb-1 px-4 text-[10px] font-semibold uppercase tracking-widest text-cm-faint">Σημειωμένα ως παιγμένα · 30 ημέρες</p>
                    {playsError ? (
                      <p role="alert" className="px-4 py-2 text-sm text-cm-rose">Δεν ήταν δυνατή η φόρτωση των πρόσφατων αναπαραγωγών.</p>
                    ) : plays === null ? (
                      <p className="px-4 py-2 text-sm text-cm-faint">…</p>
                    ) : plays.length === 0 ? (
                      <p className="px-4 py-2 text-sm text-cm-muted">Κανένα καταγεγραμμένο play τις τελευταίες 30 ημέρες.</p>
                    ) : (
                      <ul className="divide-y divide-cm-line/15 dark:divide-white/[0.06]">
                        {plays.map((t) => (
                          <ContinueRow key={t.id} track={t} keyFormat={keyFormat} onDeck={loadOnDeck} />
                        ))}
                      </ul>
                    )}
                  </GlassCard>,
                  <GlassCard key="set" className="flex min-w-0 flex-col gap-2 p-4">
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-cm-faint">Τελευταίο set</p>
                    {setsError ? (
                      <p role="alert" className="text-sm text-cm-rose">Δεν ήταν δυνατή η φόρτωση των sets.</p>
                    ) : lastSet === undefined ? (
                      <p className="text-sm text-cm-faint">…</p>
                    ) : lastSet === null ? (
                      <p className="text-sm text-cm-muted">Δεν υπάρχει set ακόμη.</p>
                    ) : (
                      <>
                        <div className="line-clamp-2 text-sm font-semibold text-cm-text">{lastSet.title}</div>
                        {lastSet.date && <div className="text-xs text-cm-muted">{lastSet.date}</div>}
                        <button
                          onClick={() => nav(`/sets?id=${lastSet.id}`)}
                          className="mt-1 self-start rounded-lg border border-cm-line/20 dark:border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-cm-muted transition hover:bg-white/10 hover:text-cm-text cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
                        >
                          Άνοιγμα στο Set Builder
                        </button>
                      </>
                    )}
                  </GlassCard>,
                ], continueColumns).map((column, index) => (
                  <div key={index} className="flex min-w-0 flex-col gap-3">{column}</div>
                ))}
              </div>
            </section>

            {therapy ? (
            <section>
              <SectionHeader
                right={
                  <span className="tabular-nums text-xs text-cm-faint">
                    {quickLists(crates).length === 1 ? "1 λίστα" : `${quickLists(crates).length} λίστες`}
                  </span>
                }
              >
                Γρήγορες λίστες
              </SectionHeader>
              {quickLists(crates).length === 0 ? (
                <EmptyState
                  title="Καρφίτσωσε ένα crate για να εμφανιστεί εδώ."
                  action={
                    <button
                      onClick={() => nav("/crates")}
                      className="rounded-lg border border-cm-line/20 dark:border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-cm-muted transition hover:bg-white/10 hover:text-cm-text cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
                    >
                      Στα crates →
                    </button>
                  }
                />
              ) : (
                <div
                  ref={crateGrid}
                  className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
                >
                  {quickLists(crates).map((c) => (
                    <GlassCard
                      key={c.id}
                      interactive
                      spotlight
                      role="link"
                      tabIndex={0}
                      aria-label={`${c.name} — ${c.count.toLocaleString("el-GR")} tracks`}
                      onClick={() => nav("/library?q=" + encodeURIComponent(c.query))}
                      onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) nav("/library?q=" + encodeURIComponent(c.query)); }}
                      className="group flex cursor-pointer flex-col gap-2 p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="line-clamp-2 flex-1 text-sm font-semibold leading-snug text-cm-text">
                          {c.name}
                        </span>
                        <button
                          onClick={(e) => handlePinCrate(c, e)}
                          title="Ξεκαρφίτσωσε"
                          aria-label={`Ξεκαρφίτσωσε: ${c.name}`}
                          className="grid h-6 w-6 shrink-0 place-items-center rounded text-cm-amber transition hover:text-cm-text cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/20"
                        >
                          <Pin className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <div className="text-2xl font-bold tabular-nums text-cm-text">
                        <AnimatedNumber value={c.count} />
                      </div>
                    </GlassCard>
                  ))}
                </div>
              )}
            </section>
            ) : (
            /* Memory Crates ──────────────────────────────────────────────── */
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
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            onClick={(e) => handleMainCrate(c, e)}
                            title={mainCrateId === c.id ? "Κύριο crate — πάτα για αφαίρεση" : "Ορισμός ως κύριο crate"}
                            aria-label={mainCrateId === c.id ? "Κύριο crate" : "Ορισμός ως κύριο crate"}
                            aria-pressed={mainCrateId === c.id}
                            className={cn(
                              "grid h-6 w-6 place-items-center rounded transition cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-cyan/60",
                              mainCrateId === c.id
                                ? "text-cm-amber hover:text-cm-text"
                                : "text-cm-muted opacity-0 hover:text-cm-text group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100",
                            )}
                          >
                            <Star className={cn("h-3.5 w-3.5", mainCrateId === c.id && "fill-current")} />
                          </button>
                        <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
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
                      </div>
                      <div className="text-2xl font-bold tabular-nums text-cm-text">
                        <AnimatedNumber value={c.count} />
                      </div>
                      {c.query && (
                        <div className="flex min-w-0 flex-wrap gap-1">
                          {parseQueryChips(c.query, facets).slice(0, 3).map((chip, i) => (
                            <SmartChip key={i} tone={chip.tone} className="max-w-full text-[10px]">
                              <span className="truncate">{chip.label}</span>
                            </SmartChip>
                          ))}
                        </div>
                      )}
                    </GlassCard>
                  ))}
                </div>
              )}
            </section>
            )}

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

          {/* RIGHT ─ Intelligence Status · Θέλουν προσοχή ─────────────────── */}
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
                {!therapy && (
                <IntelRow
                  label="Όπλα / σύνολο"
                  value={total > 0 ? `${Math.round(weaponsRatio  * 100)}%` : "–"}
                  tone="amber"
                  pct={weaponsRatio}
                />
                )}
              </div>

              {/* Energy Balance histogram */}
              {energyCounts.length > 0 && (
                <>
                  <Separator className="my-3 opacity-[0.08]" />
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-cm-faint">
                    {therapy ? "Διέγερση" : "Energy Balance"}
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

            {/* Θέλουν προσοχή — one-click counts that open the Library ─────── */}
            <GlassPanel className="p-4">
              <SectionHeader right={<TriangleAlert className="h-3.5 w-3.5 text-cm-faint" />}>
                Θέλουν προσοχή
              </SectionHeader>
              <div className="mt-1 divide-y divide-cm-line/15 dark:divide-white/[0.06]">
                {ATTENTION_QUERIES.map((q) => (
                  <AttentionRow
                    key={q.key}
                    label={q.label}
                    count={attention[q.key] === null ? "—" : attention[q.key]}
                    title={attention[q.key] === null ? "Δεν ήταν δυνατή η φόρτωση του αριθμού" : undefined}
                    onClick={() => nav(libraryHref(q.query))}
                  />
                ))}
                <AttentionRow
                  label="Tracks με αρχείο που λείπει"
                  count={missingError ? "—" : missingCount}
                  title={missingError ? "Δεν ήταν δυνατή η φόρτωση του αριθμού" : "Σύμφωνα με τον τελευταίο έλεγχο αρχείων"}
                  tone="text-cm-rose"
                  onClick={() => nav("/library?q=missing")}
                />
                <AttentionRow label="Ύποπτα διπλότυπα" count={dupes} onClick={() => nav("/duplicates")} />
              </div>
            </GlassPanel>

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

          </div>
        </div>
      </div>
    </div>
  );
}

/** One «Συνέχεια» row: title, artist (and deck/time), coloured tempo and key, and the deck buttons. */
function ContinueRow({ track: t, keyFormat, meta, onDeck }: {
  track: Track;
  keyFormat: KeyFormat;
  meta?: string;
  onDeck: (deck: DeckId, track: Track) => void;
}) {
  const bpm = effectiveBpm(t);
  return (
    <li className="flex items-center gap-3 px-4 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-cm-text">{t.title || t.file_name}</div>
        <div className="flex min-w-0 gap-1 text-xs text-cm-muted">
          <span className="truncate">{t.artist || "—"}</span>
          {meta && <span className="shrink-0 text-cm-faint">· {meta}</span>}
        </div>
      </div>
      <span className="w-14 shrink-0 text-right font-mono text-xs tabular-nums text-cm-muted" style={{ color: bpmColor(bpm) }}>
        {bpm != null ? `${bpm.toFixed(0)} BPM` : "—"}
      </span>
      <span className="w-10 shrink-0 font-mono text-xs text-cm-muted" style={{ color: keyColor(t.key_text, t.key_analyzed) }}>
        {formatKey(t.key_text, t.key_analyzed, keyFormat)}
      </span>
      <div className="flex shrink-0 gap-1">
        <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs motion-safe:active:scale-[0.98] transition-transform duration-100 ease-out" onClick={() => onDeck("A", t)}>→ Deck A</Button>
        <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs motion-safe:active:scale-[0.98] transition-transform duration-100 ease-out" onClick={() => onDeck("B", t)}>→ Deck B</Button>
      </div>
    </li>
  );
}

/** One «Θέλουν προσοχή» row: a label and its count, opening where the count came from. */
function AttentionRow({ label, count, title, tone = "text-cm-amber", onClick }: {
  label: string;
  count: number | string | null | undefined;
  title?: string;
  tone?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="flex w-full cursor-pointer items-center justify-between gap-3 py-2 text-left text-xs text-cm-muted transition hover:text-cm-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-cyan/60"
    >
      <span className="min-w-0">{label}</span>
      <span className={cn("shrink-0 font-semibold tabular-nums", typeof count === "number" && count > 0 ? tone : "text-cm-faint")}>
        {typeof count === "number" ? count.toLocaleString("el-GR") : count ?? "…"}
      </span>
    </button>
  );
}
