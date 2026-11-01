import { effectiveBpm } from "../lib/tempo";
import { bpmColor } from "../lib/bpmColor";
import { NUM_FIELDS, SUBSTYLES, BREAKDOWNS, TOLERANCES, BOOL_FIELDS, ProfileSelect } from "../components/ProfileEditor";
import { SET_ROLES, STATUS_VALUES } from "../lib/types";
import { toast } from "sonner";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import type { ComponentType } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { formatKey, keyColor, type KeyFormat } from "../lib/camelot";
import { usePref } from "../lib/prefs";
import { isTypingTarget } from "../lib/keyboardGuard";
import { statusLabel, valueLabel } from "../lib/labels";
import { hasPlaybackKeyOwner, usePlayer, useTwoDeck, type DeckId } from "../lib/player";
import { BROWSE_FOCUS_CLASS, useBrowseList } from "../lib/browseTarget";
import { isCueJumpKey, tagKeyAction } from "../lib/tagKeys";
import type { ChipTone } from "../lib/queryChips";
import type { ArtistPrefill, Profile, Track, Tag } from "../lib/types";
import { Artwork } from "../components/ui/Artwork";
import { EmptyState } from "../components/ui/EmptyState";
import { GlassPanel } from "../components/ui/GlassPanel";
import { IntelRow } from "../components/ui/IntelRow";
import { KeyboardHint, Kbd } from "../components/ui/KeyboardHint";
import { Segmented } from "../components/ui/Segmented";
import { SmartChip } from "../components/ui/SmartChip";
import { TrackWaveform } from "../components/ui/TrackWaveform";
import { Button } from "../components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { Separator } from "../components/ui/separator";
import { Textarea } from "../components/ui/textarea";
import { useResizable } from "../lib/useResizable";
import { ResizeHandle } from "../components/ui/ResizeHandle";
import {
  Activity,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Crosshair,
  Eye,
  Flame,
  GitBranch,
  Gauge,
  Headphones,
  Layers,
  Moon,
  Music2,
  Play,
  ShieldCheck,
  Shuffle,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Sparkles,
  Tags,
  Waves,
  Zap,
} from "../lib/icons";

gsap.registerPlugin(useGSAP);

const RATING_ICONS: Partial<Record<keyof Profile, ComponentType<{ className?: string }>>> = {
  intensity: Gauge,
  melody: Music2,
  weirdness: Sparkles,
  chaos_level: Shuffle,
  mixability: SlidersHorizontal,
};

/**
 * Queue filters → CrateMind search mini-syntax (services/search.py). Display-only
 * Greek labels; each `q` is a real query string handed to api.listTracks().
 */
const FILTERS: { label: string; q: string; icon: ComponentType<{ className?: string }> }[] = [
  { label: "Όλα", q: "", icon: Layers },
  { label: "Χωρίς tags", q: "untagged", icon: Tags },
  { label: "Δοκιμή", q: "testing", icon: Headphones },
  { label: "Για έλεγχο", q: "status:unknown", icon: Eye },
  { label: "Υποψήφιες γέφυρες", q: "role:bridge", icon: GitBranch },
  { label: "Μεγάλο blend", q: "tolerance:huge", icon: Waves },
];

/** Fisher–Yates on a copy — display order only, the loaded tracks are never mutated. */
function shuffled<T>(xs: T[]): T[] {
  const out = xs.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Keyboard reference panel — expanded mirror of the keydown map (the source of truth). */
const SHORTCUTS: { section: string; rows: { keys: string[]; label: string }[] }[] = [
  {
    section: "Ακρόαση",
    rows: [
      { keys: ["Space"], label: "αναπαραγωγή / παύση" },
      { keys: ["1–8"], label: "μετάβαση στα cue pads του επιλεγμένου track" },
    ],
  },
  {
    section: "Βαθμολογία",
    rows: [
      { keys: ["1–9", "0"], label: "ενέργεια 1–10 (1–8 μόνο χωρίς επιλεγμένο track)" },
      { keys: ["Shift", "1–0"], label: "σκοτεινότητα 1–10" },
      { keys: ["M"], label: "μελωδικό" },
    ],
  },
  {
    section: "Κατάσταση",
    rows: [
      { keys: ["W"], label: "όπλο" },
      { keys: ["A"], label: "εγκεκριμένο" },
      { keys: ["X"], label: "απόφυγε" },
    ],
  },
  {
    section: "Ρόλος",
    rows: [
      { keys: ["B"], label: "γέφυρα" },
      { keys: ["P"], label: "κορύφωση" },
      { keys: ["R"], label: "reset" },
    ],
  },
  {
    section: "Πλοήγηση",
    rows: [
      { keys: ["J"], label: "επόμενο" },
      { keys: ["K"], label: "προηγούμενο" },
    ],
  },
];

/**
 * On-screen action grid. Each button calls the SAME apply() patch+flash as the
 * keydown map — the six with a `hint` mirror a real key (A/W/X/B/P/R); the three
 * without (Δοκιμή / Δραματικό / Μεγάλο blend) are screen-only writes with no
 * keyboard binding, so they intentionally show no key badge.
 */
const ACTIONS: {
  label: string;
  tone: ChipTone;
  icon: ComponentType<{ className?: string }>;
  patch: Partial<Profile>;
  flash: string;
  hint?: string;
}[] = [
  { label: "Δοκιμή", tone: "cyan", icon: Headphones, patch: { personal_status: "testing" }, flash: "δοκιμή" },
  { label: "Εγκεκριμένο", tone: "chartreuse", icon: CheckCircle2, patch: { personal_status: "approved" }, flash: "εγκεκριμένο", hint: "A" },
  { label: "Όπλο", tone: "magenta", icon: Crosshair, patch: { personal_status: "weapon" }, flash: "ΟΠΛΟ", hint: "W" },
  { label: "Απόφυγε", tone: "rose", icon: Ban, patch: { personal_status: "avoid" }, flash: "απόφυγε", hint: "X" },
  { label: "Γέφυρα", tone: "blue", icon: GitBranch, patch: { set_role: "bridge" }, flash: "ρόλος γέφυρα", hint: "B" },
  { label: "Κορύφωση", tone: "amber", icon: Flame, patch: { set_role: "peak" }, flash: "ρόλος κορύφωση", hint: "P" },
  { label: "Reset", tone: "muted", icon: CircleDot, patch: { set_role: "reset" }, flash: "ρόλος reset", hint: "R" },
  { label: "Δραματικό", tone: "violet", icon: Zap, patch: { dramatic_transition_candidate: true }, flash: "δραματικό" },
  { label: "Μεγάλο blend", tone: "amber", icon: Waves, patch: { bpm_jump_tolerance: "huge" }, flash: "ανοχή huge" },
];

const ACTION_TONE: Record<ChipTone, string> = {
  cyan: "border-cm-cyan/25 text-cm-cyan hover:border-cm-cyan/50 hover:bg-cm-cyan/10",
  blue: "border-cm-blue/25 text-cm-blue hover:border-cm-blue/50 hover:bg-cm-blue/10",
  violet: "border-cm-violet/25 text-cm-violet hover:border-cm-violet/50 hover:bg-cm-violet/10",
  chartreuse: "border-cm-chartreuse/25 text-cm-chartreuse hover:border-cm-chartreuse/50 hover:bg-cm-chartreuse/10",
  magenta: "border-cm-magenta/25 text-cm-magenta hover:border-cm-magenta/50 hover:bg-cm-magenta/10",
  amber: "border-cm-amber/25 text-cm-amber hover:border-cm-amber/50 hover:bg-cm-amber/10",
  rose: "border-cm-rose/25 text-cm-rose hover:border-cm-rose/50 hover:bg-cm-rose/10",
  muted: "border-cm-line/20 dark:border-white/10 text-cm-muted hover:border-cm-line/30 dark:hover:border-white/20 hover:bg-white/5",
};

function fmtDur(s?: number | null): string {
  if (s == null) return "—";
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
}

function fmtDate(s?: string | null): string {
  if (!s) return "—";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString();
}

function prefillEnergy(prefill: ArtistPrefill): number | null {
  const range = prefill.energy_range;
  if (!range) return null;
  const [min, max] = range;
  if (min == null && max == null) return null;
  if (min != null && max != null) return Math.round((min + max) / 2);
  return min ?? max ?? null;
}

/** Real, non-fabricated facts about the current track (Track + fetched Profile). */
function trackFacts(t: Track, p: Profile | null, keyFormat: KeyFormat): { label: string; value: string; tone: ChipTone; color?: string }[] {
  const rows: { label: string; value: string; tone: ChipTone; color?: string }[] = [];
  const bpm = effectiveBpm(t);
  if (bpm != null) rows.push({ label: "BPM", value: bpm.toFixed(0), tone: "blue", color: bpmColor(bpm) });
  if (t.key_text || t.key_analyzed) rows.push({ label: "Key", value: formatKey(t.key_text, t.key_analyzed, keyFormat), tone: "violet", color: keyColor(t.key_text, t.key_analyzed) });
  if (t.genre) rows.push({ label: "Genre", value: t.genre, tone: "cyan" });
  if (t.duration != null) rows.push({ label: "Διάρκεια", value: fmtDur(t.duration), tone: "cyan" });
  if (t.year != null) rows.push({ label: "Έτος", value: String(t.year), tone: "muted" });
  if (t.label) rows.push({ label: "Label", value: t.label, tone: "muted" });
  rows.push({ label: "Format", value: t.extension.replace(/^\./, "").toUpperCase(), tone: "muted" });
  if (t.bitrate != null) rows.push({ label: "Bitrate", value: `${Math.round(t.bitrate / 1000)} kbps`, tone: "muted" });
  rows.push({ label: "Παίχτηκε", value: `${t.play_count}×`, tone: t.play_count > 0 ? "amber" : "muted" });
  if (t.last_played_at) rows.push({ label: "Τελευταίο play", value: fmtDate(t.last_played_at), tone: "amber" });
  const st = p?.personal_status ?? t.personal_status;
  if (st) rows.push({ label: "Κατάσταση", value: statusLabel(st), tone: "chartreuse" });
  const role = p?.set_role ?? t.set_role;
  if (role) rows.push({ label: "Ρόλος", value: valueLabel(role), tone: "blue" });
  return rows;
}

export default function TaggingQueue() {
  const [keyFormat] = usePref("keyFormat");
  const [queue, setQueue] = useState("untagged");
  const [shuffle, setShuffle] = useState(false);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [idx, setIdx] = useState(0);
  const [flash, setFlash] = useState<string>("");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [notes, setNotes] = useState("");
  const [trackTags, setTrackTags] = useState<Tag[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [qmOpen, setQmOpen] = useState(false);
  const { play, load: loadDeck } = usePlayer();
  const twoDeck = useTwoDeck();
  const rootRef = useRef<HTMLDivElement>(null);
  const flashRef = useRef<HTMLSpanElement>(null);

  const {
    size: rightPanelWidth,
    isDragging: isRightDragging,
    handleProps: rightHandleProps,
  } = useResizable({
    direction: "horizontal",
    initial: 320,
    min: 260,
    max: 560,
    storageKey: "cm:tagging-sidebar-width",
    reverse: true,
  });

  const load = useCallback(async (q: string, random: boolean) => {
    const t = await api.listTracks(q, 0); // 0 = no limit — load the whole queue
    setTracks(random ? shuffled(t) : t);
    setIdx(0);
  }, []);

  useEffect(() => {
    load(queue, shuffle);
  }, [queue, shuffle, load]);

  const current = tracks[idx];
  const currentBpm = effectiveBpm(current);
  const currentId = current?.id;
  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;
  // Controller browse: the cursor is the queue position (move = previous / next).
  const browse = useBrowseList("tagging-queue", { rows: () => tracks, onCursor: (_track, index) => setIdx(index) }, currentId);
  const listen = (deck: DeckId) => {
    if (current && !loadDeck(deck, current, { play: true, ifIdle: true })) toast(`Το Deck ${deck} παίζει — δεν φορτώθηκε`);
  };
  const artistPrefill = current?.artist_prefill;

  // A controller pad bank wrote this track's profile on a deck: refresh the meters (notes in progress stay untouched).
  useEffect(() => {
    function onProfileUpdated(e: Event) {
      const trackId = (e as CustomEvent<{ trackId?: number }>).detail?.trackId;
      if (trackId == null || trackId !== currentIdRef.current) return;
      api.getTrack(trackId).then(d => { if (currentIdRef.current === trackId) setProfile(d.profile); }).catch(() => {});
    }
    window.addEventListener("cratemind:profile-updated", onProfileUpdated);
    return () => window.removeEventListener("cratemind:profile-updated", onProfileUpdated);
  }, []);

  // Fetch the full profile for the current track so the meters reflect canonical
  // energy/darkness/confidence and the notes field reflects saved notes.
  useEffect(() => {
    if (currentId == null) {
      setProfile(null);
      setNotes("");
      return;
    }
    let alive = true;
    setTrackTags([]);
    setTagInput("");
    api
      .getTrack(currentId)
      .then((d) => {
        if (alive) {
          setProfile(d.profile);
          setTrackTags(d.tags);
          setNotes(d.profile?.notes ?? "");
        }
      })
      .catch(() => {
        if (alive) {
          setProfile(null);
          setNotes("");
        }
      });
    return () => {
      alive = false;
    };
  }, [currentId]);

  const apply = useCallback(
    async (patch: Partial<Profile>, label: string) => {
      if (!current) return;
      await api.updateProfile(current.id, patch);
      setFlash(`${current.title || current.file_name}: ${label}`);
    },
    [current],
  );

  // Same write as the keyboard (apply → api.updateProfile + flash), plus an
  // optimistic local-profile merge so the on-screen meters/insight update live.
  const rate = useCallback(
    (patch: Partial<Profile>, label: string) => {
      void apply(patch, label).catch(e => toast.error((e as Error).message));
      setProfile((p) => ({ ...(p ?? { track_id: currentId ?? 0 }), ...patch }) as Profile);
    },
    [apply, currentId],
  );

  const saveNotes = useCallback(() => {
    if (!current) return;
    if ((profile?.notes ?? "") === notes) return;
    api.updateProfile(current.id, { notes });
    setProfile((p) => (p ? { ...p, notes } : p));
    setFlash(`${current.title || current.file_name}: σημειώσεις`);
  }, [current, profile, notes]);

  async function acceptPrefill(patch: Partial<Profile>, label: string) {
    if (!current) return;
    await api.acceptArtistPrefill(current.id, patch);
    setProfile((p) => ({ ...(p ?? { track_id: current.id }), ...patch }) as Profile);
    setFlash(`${current.title || current.file_name}: ${label}`);
  }

  const move = useCallback(
    (delta: number) => {
      setIdx((i) => Math.min(Math.max(i + delta, 0), Math.max(tracks.length - 1, 0)));
    },
    [tracks.length],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      // An active deck reserves 1–8 for cue jumps, including currently empty pads.
      if (isCueJumpKey(e.key, e.shiftKey, hasPlaybackKeyOwner())) return;
      if (!current) return;
      const k = e.key;

      // The key table is shared with the controller's pad banks (lib/tagKeys.ts).
      const tag = tagKeyAction(k, e.shiftKey);
      if (tag) {
        if (tag.optimistic) rate(tag.patch, tag.label);
        else apply(tag.patch, tag.label);
        e.preventDefault();
        return;
      }
      switch (k.toLowerCase()) {
        case "j": move(1); break;
        case "k": move(-1); break;
        default: return;
      }
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, apply, rate, move]);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        if (flash) {
          gsap.fromTo(
            flashRef.current,
            { scale: 0.9, opacity: 0.6 },
            { scale: 1, opacity: 1, duration: 0.25, ease: "back.out(2)" },
          );
        }
      });
    },
    { scope: rootRef, dependencies: [flash] },
  );

  const remaining = current ? Math.max(tracks.length - idx, 0) : 0;

  return (
    <div ref={rootRef} className={cn("flex h-full flex-col", BROWSE_FOCUS_CLASS)} {...browse.bind}>
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-black/10 dark:border-white/10 px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-cm-text">Ουρά tagging</h1>
          <p className="text-xs text-cm-faint">Συγκέντρωση. Γρήγορο tagging. Χτίσε sets.</p>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <div className="text-right">
            <div className="font-mono text-xl font-semibold tabular-nums text-cm-cyan">Απομένουν {remaining}</div>
            <div className="font-mono text-[11px] uppercase tracking-wider text-cm-faint tabular-nums">
              {current ? `Κομμάτι ${idx + 1} / ${tracks.length}` : "—"}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => move(-1)} disabled={!current || idx === 0}>
              <ChevronLeft className="h-4 w-4" />
              Προηγούμενο
            </Button>
            <Button variant="outline" size="sm" onClick={() => move(1)} disabled={!current || idx >= tracks.length - 1}>
              Επόμενο
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>

          <Popover open={qmOpen} onOpenChange={setQmOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border surface-field px-3 text-xs text-cm-muted transition hover:border-cm-line/30 dark:hover:border-white/20 hover:text-cm-text"
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                Διαχείριση ουράς
                <ChevronDown className="h-3 w-3" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-56 p-2">
              <div className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-cm-faint">Ουρές</div>
              <div className="flex flex-col gap-0.5">
                {FILTERS.map((f) => {
                  const Icon = f.icon;
                  const active = queue === f.q;
                  return (
                    <button
                      key={f.label}
                      type="button"
                      aria-pressed={active}
                      onClick={() => {
                        setQueue(f.q);
                        setQmOpen(false);
                      }}
                      className="menu-item flex cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm text-cm-muted transition"
                    >
                      <span className="flex items-center gap-2">
                        <Icon className="h-3.5 w-3.5" />
                        {f.label}
                      </span>
                      {active && <CheckCircle2 className="h-3.5 w-3.5" />}
                    </button>
                  );
                })}
              </div>
              <div className="mt-2 border-t border-cm-line/20 dark:border-white/10 pt-2">
                <div className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-cm-faint">Σειρά</div>
                <button
                  type="button"
                  onClick={() => setShuffle((s) => !s)}
                  aria-pressed={shuffle}
                  className="menu-item flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm text-cm-muted transition"
                >
                  <span className="flex items-center gap-2">
                    <Shuffle className="h-3.5 w-3.5" />
                    Τυχαία σειρά
                  </span>
                  {shuffle && <CheckCircle2 className="h-3.5 w-3.5" />}
                </button>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto p-6">
          <div className="flex flex-wrap items-center gap-2">
            {FILTERS.map((f) => (
              <SmartChip
                key={f.label}
                tone={queue === f.q ? "cyan" : "muted"}
                icon={f.icon}
                active={queue === f.q}
                onClick={() => setQueue(f.q)}
              >
                {f.label}
              </SmartChip>
            ))}
            <span className="mx-1 h-4 w-px bg-white/10" />
            <SmartChip
              tone={shuffle ? "cyan" : "muted"}
              icon={Shuffle}
              active={shuffle}
              onClick={() => setShuffle((s) => !s)}
            >
              Τυχαία σειρά
            </SmartChip>
          </div>

          {current ? (
            <>
              <GlassPanel strong className="glow-violet p-6">
                <div className="flex flex-wrap items-center gap-6">
                  <div className="relative shrink-0">
                    <Artwork seed={current.id} circle className="glow-cyan h-[150px] w-[150px] ring-2 ring-cm-cyan/40" />
                  </div>

                  <div className="min-w-0 flex-1 basis-48">
                    <div className="truncate text-2xl font-semibold tracking-tight text-cm-text">
                      {current.title || current.file_name}
                    </div>
                    <div className="mt-0.5 text-base text-cm-magenta">{current.artist || "Άγνωστος καλλιτέχνης"}</div>
                    {current.album && <div className="mt-0.5 truncate text-sm text-cm-faint">{current.album}</div>}

                    <div className="mt-3 flex flex-wrap items-center gap-2 font-mono">
                      <SmartChip tone="cyan" icon={Activity}>
                        <span style={{color: bpmColor(currentBpm)}}>{currentBpm != null ? `${currentBpm.toFixed(0)} BPM` : "χωρίς BPM"}</span>
                      </SmartChip>
                      <SmartChip tone="violet" icon={Music2}>
                        <span style={{ color: keyColor(current.key_text, current.key_analyzed) }}>{(current.key_text || current.key_analyzed) ? formatKey(current.key_text, current.key_analyzed, keyFormat) : "χωρίς key"}</span>
                      </SmartChip>
                      <SmartChip tone="muted">{current.extension.replace(/^\./, "").toUpperCase()}</SmartChip>
                    </div>
                  </div>

                  <div className="ml-auto flex shrink-0 items-center gap-2">
                    <button
                      onClick={() => move(-1)}
                      title="Προηγούμενο (K)"
                      aria-label="Προηγούμενο track (K)"
                      className="inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-xl border surface-field text-cm-muted transition hover:border-cm-line/30 dark:hover:border-white/20 hover:text-cm-text"
                    >
                      <SkipBack className="h-4 w-4" />
                    </button>
                    {twoDeck ? (["A", "B"] as const).map(deck => (
                      <button
                        key={deck}
                        onClick={() => listen(deck)}
                        title={`Ακρόαση στο Deck ${deck}`}
                        aria-label={`Ακρόαση στο Deck ${deck}`}
                        className="glow-cyan inline-flex h-10 cursor-pointer items-center gap-2 rounded-xl border border-cm-cyan/30 bg-cm-cyan/12 px-4 text-sm font-semibold text-cm-cyan transition hover:bg-cm-cyan/20"
                      >
                        <Play className="h-4 w-4" />
                        Ακρόαση {deck}
                      </button>
                    )) : (
                      <button
                        onClick={() => play(current)}
                        title="Ακρόαση (μετά Space για play/pause)"
                        className="glow-cyan inline-flex h-10 cursor-pointer items-center gap-2 rounded-xl border border-cm-cyan/30 bg-cm-cyan/12 px-5 text-sm font-semibold text-cm-cyan transition hover:bg-cm-cyan/20"
                      >
                        <Play className="h-4 w-4" />
                        Ακρόαση
                      </button>
                    )}
                      <button
                        onClick={() => move(1)}
                        title="Επόμενο (J)"
                        aria-label="Επόμενο track (J)"
                        className="inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-xl border surface-field text-cm-muted transition hover:border-cm-line/30 dark:hover:border-white/20 hover:text-cm-text"
                      >
                        <SkipForward className="h-4 w-4" />
                      </button>
                  </div>
                </div>

                <div data-tagging-waveform className="mx-auto mt-5 h-12 w-full max-w-[800px]">
                  <TrackWaveform trackId={current.id} sourceRevision={current.modified_time} className="h-full" />
                </div>
              </GlassPanel>

              {flash && (
                <div className="-mt-1 flex justify-center">
                  <span
                    ref={flashRef}
                    className="glow-cyan inline-flex items-center gap-1.5 rounded-full border border-cm-cyan/30 bg-cm-cyan/12 px-3 py-1 font-mono text-xs text-cm-cyan"
                  >
                    <Sparkles className="h-3 w-3" />
                    {flash}
                  </span>
                </div>
              )}

              <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
                <div className="min-w-0 space-y-4">
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                {ACTIONS.map((a) => {
                  const Icon = a.icon;
                  const selected = profile?.track_id === current.id && Object.entries(a.patch)
                    .every(([field, value]) => profile[field as keyof Profile] === value);
                  return (
                    <button
                      key={a.label}
                      type="button"
                      onClick={() => rate(a.patch, a.flash)}
                      onKeyDown={(e) => {
                        if (e.key === " " || e.key === "Enter") e.stopPropagation();
                      }}
                      aria-pressed={selected}
                      title={a.hint ? `${a.label} (${a.hint})` : a.label}
                      className={cn(
                        "relative flex cursor-pointer flex-col items-start gap-2 rounded-xl border bg-cm-panel-2/40 p-3 text-left transition-[background-color,border-color,box-shadow,transform] duration-150 motion-reduce:transition-none motion-safe:active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-cyan/70",
                        ACTION_TONE[a.tone],
                        selected && "border-current bg-current/15 ring-1 ring-current/40 hover:border-current hover:bg-current/20",
                      )}
                    >
                      <Icon aria-hidden="true" className="h-4 w-4" />
                      <span className="flex w-full items-center gap-2 text-xs font-semibold uppercase tracking-wide text-cm-text">
                        {a.label}
                        {selected && <CheckCircle2 aria-hidden="true" className="ml-auto h-3.5 w-3.5 shrink-0" />}
                      </span>
                      {a.hint && <Kbd className="absolute right-2 top-2">{a.hint}</Kbd>}
                    </button>
                  );
                })}
              </div>

              <div className="grid grid-cols-1 gap-3">
                <GlassPanel className="p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-cm-faint">
                      <Zap className="h-3 w-3 text-cm-chartreuse" />
                      Ενέργεια
                    </span>
                    <span className="font-mono text-xs tabular-nums text-cm-text">{profile?.energy ?? current.energy ?? "—"}</span>
                  </div>
                  <Segmented
                    value={profile?.energy ?? current.energy}
                    ramp="energy"
                    ariaLabel="ενέργεια"
                    onChange={(v) => rate({ energy: v }, `ενέργεια ${v}`)}
                  />
                </GlassPanel>

                <GlassPanel className="p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-cm-faint">
                      <Moon className="h-3 w-3 text-cm-violet" />
                      Σκοτεινότητα
                    </span>
                    <span className="font-mono text-xs tabular-nums text-cm-text">{profile?.darkness ?? current.darkness ?? "—"}</span>
                  </div>
                  <Segmented
                    value={profile?.darkness ?? current.darkness}
                    ramp="darkness"
                    ariaLabel="σκοτεινότητα"
                    onChange={(v) => rate({ darkness: v }, `σκοτεινότητα ${v}`)}
                  />
                </GlassPanel>

                <GlassPanel className="p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-cm-faint">
                      <ShieldCheck className="h-3 w-3 text-cm-amber" />
                      Σιγουριά
                    </span>
                    <span className="font-mono text-xs tabular-nums text-cm-text">{profile?.confidence ?? "—"}</span>
                  </div>
                  <Segmented
                    value={profile?.confidence}
                    max={5}
                    tone="amber"
                    ariaLabel="σιγουριά"
                    onChange={(v) => rate({ confidence: v }, `σιγουριά ${v}`)}
                  />
                </GlassPanel>
                {NUM_FIELDS.filter(f=>!['energy','darkness','confidence'].includes(f.key)).map(f=>{
                  const Icon = RATING_ICONS[f.key] ?? Activity;
                  return (
                  <GlassPanel key={f.key} className="p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-cm-faint"><Icon className="h-3 w-3 text-cm-cyan"/>{f.label}</span>
                      <span className="font-mono text-xs tabular-nums text-cm-text">{(profile?.[f.key] as number | undefined) ?? '—'}</span>
                    </div>
                    <Segmented value={profile?.[f.key] as number | undefined} max={f.max} tone="cyan" ariaLabel={f.label} onChange={v=>rate({[f.key]:v},`${f.label} ${v}`)}/>
                  </GlassPanel>
                  );
                })}
              </div>
                </div>

                <div className="min-w-0 space-y-4">
                  <GlassPanel className="space-y-4 p-4">
                    <h2 className="text-xs font-semibold uppercase tracking-wider text-cm-faint">Προφίλ μετάβασης</h2>
                    <div className="grid grid-cols-2 gap-3">
                      <ProfileSelect label="Κατάσταση" value={profile?.personal_status??''} options={STATUS_VALUES} onChange={v=>rate({personal_status:v},statusLabel(v))}/>
                      <ProfileSelect label="Ρόλος στο set" value={profile?.set_role??''} options={SET_ROLES} onChange={v=>rate({set_role:v},valueLabel(v))}/>
                      <ProfileSelect label="Psy substyle" value={profile?.psy_substyle??''} options={profile?.psy_substyle&&!SUBSTYLES.includes(profile.psy_substyle)?[profile.psy_substyle,...SUBSTYLES]:SUBSTYLES} onChange={v=>rate({psy_substyle:v},v)}/>
                      <ProfileSelect label="Breakdown" value={profile?.breakdown_profile??''} options={BREAKDOWNS} onChange={v=>rate({breakdown_profile:v},valueLabel(v))}/>
                      <ProfileSelect label="Ανοχή σε άλμα BPM" value={profile?.bpm_jump_tolerance??''} options={TOLERANCES} onChange={v=>rate({bpm_jump_tolerance:v},valueLabel(v))}/>
                    </div>
                    {BOOL_FIELDS.map(f=><label key={f.key} className="flex cursor-pointer items-center justify-between gap-3 text-xs text-cm-muted"><span>{f.label}</span><Switch checked={Boolean(profile?.[f.key])} onCheckedChange={v=>rate({[f.key]:v},f.label)}/></label>)}
                  </GlassPanel>
                  <GlassPanel className="space-y-3 p-4">
                    <h2 className="text-xs font-semibold uppercase tracking-wider text-cm-faint">Tags</h2>
                    <div className="flex flex-wrap gap-2">{trackTags.map(tag=><Button key={tag.id} variant="outline" size="sm" className="cursor-pointer" aria-label={`Αφαίρεση tag ${tag.name}`} onClick={async()=>{try{await api.removeTag(current.id,tag.id);if(currentIdRef.current!==current.id)return;setTrackTags(tags=>tags.filter(t=>t.id!==tag.id));}catch(e){toast.error((e as Error).message)}}}>{tag.name} ×</Button>)}</div>
                    <form className="flex gap-2" onSubmit={async e=>{e.preventDefault();if(!tagInput.trim())return;try{await api.assignTag(current.id,tagInput.trim());const d=await api.getTrack(current.id);if(currentIdRef.current!==current.id)return;setTrackTags(d.tags);setTagInput('');}catch(error){toast.error((error as Error).message)}}}>
                      <Input aria-label="Νέο tag" placeholder="Νέο tag…" value={tagInput} onChange={e=>setTagInput(e.target.value)}/><Button type="submit" variant="outline" className="cursor-pointer" disabled={!tagInput.trim()}>Προσθήκη</Button>
                    </form>
                  </GlassPanel>
            {current && (
              <GlassPanel className="p-4">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-cm-faint">Σημειώσεις</div>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  onBlur={saveNotes}
                  placeholder="Ιδέες για μεταβάσεις, διάθεση, που ταιριάζει στο set…"
                  className="min-h-24 resize-none text-cm-text placeholder:text-cm-faint"
                />
                <p className="mt-2 text-[11px] leading-relaxed text-cm-faint">
                  Αποθηκεύεται όταν φύγει το focus. Τα πλήκτρα βαθμολογίας δεν ενεργοποιούνται όσο γράφεις.
                </p>
              </GlassPanel>
            )}
                </div>
              </div>
            </>
          ) : (
            <EmptyState icon={CheckCircle2} title="Άδεια ουρά" className="w-full">
              Δεν μένει τίποτα για tagging εδώ.
            </EmptyState>
          )}
        </main>

        <div
          style={{ width: `${rightPanelWidth}px` }}
          className="relative shrink-0 flex flex-col min-h-0 border-l border-black/10 dark:border-white/10 bg-cm-bg-2/40"
        >
          <ResizeHandle
            orientation="vertical"
            isDragging={isRightDragging}
            ariaLabel="Αλλαγή πλάτους δεξιού panel"
            className="absolute -left-1.5 inset-y-0 z-30"
            {...rightHandleProps}
          />
          <aside className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
            <div className="my-auto flex shrink-0 flex-col gap-4">
            <GlassPanel className="p-4">
              <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-cm-faint">Πληκτρολόγιο</div>
              <div className="flex flex-col gap-3">
                {SHORTCUTS.map((group) => (
                  <div key={group.section}>
                    <div className="mb-1 text-[10px] uppercase tracking-wider text-cm-faint/70">{group.section}</div>
                    <div className="divide-y divide-cm-line/15 dark:divide-white/5">
                      {group.rows.map((row) => (
                        <KeyboardHint key={row.label} keys={row.keys} label={row.label} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </GlassPanel>

            {current && (
              <GlassPanel className="p-4">
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-cm-faint">
                  <Activity className="h-3.5 w-3.5" />
                  Στοιχεία κομματιού
                </div>
                <div className="divide-y divide-cm-line/15 dark:divide-white/5">
                  {trackFacts(current, profile, keyFormat).map((f) => (
                    <IntelRow key={f.label} label={f.label} value={f.value} tone={f.tone} valueColor={f.color} />
                  ))}
                </div>
                {artistPrefill && (
                  <div className="mt-3 space-y-2">
                    <Separator className="bg-cm-line/15 dark:bg-white/5" />
                    <div className="flex flex-wrap gap-1.5 pt-2">
                      {artistPrefill.scene_cluster && <SmartChip tone="violet">{artistPrefill.scene_cluster}</SmartChip>}
                      {artistPrefill.primary_subgenre && <SmartChip tone="cyan">{artistPrefill.primary_subgenre}</SmartChip>}
                      {artistPrefill.confidence_label && <SmartChip tone="chartreuse">{artistPrefill.confidence_label}</SmartChip>}
                      {artistPrefill.needs_review && <SmartChip tone="amber">Θέλει έλεγχο</SmartChip>}
                      {artistPrefill.bpm_conflict && <SmartChip tone="rose">BPM conflict</SmartChip>}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {artistPrefill.primary_subgenre && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={profile?.psy_substyle === artistPrefill.primary_subgenre}
                          onClick={() => acceptPrefill({ psy_substyle: artistPrefill.primary_subgenre, human_confirmed: true }, "subgenre")}
                        >
                          {profile?.psy_substyle === artistPrefill.primary_subgenre ? "Subgenre OK" : "Subgenre"}
                        </Button>
                      )}
                      {prefillEnergy(artistPrefill) != null && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={profile?.energy === prefillEnergy(artistPrefill)}
                          onClick={() => acceptPrefill({ energy: prefillEnergy(artistPrefill) ?? undefined, human_confirmed: true }, "ενέργεια")}
                        >
                          {profile?.energy === prefillEnergy(artistPrefill) ? "Ενέργεια OK" : "Ενέργεια"}
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </GlassPanel>
            )}


            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
