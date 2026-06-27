import type { ComponentType } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { isTypingTarget } from "../lib/keyboardGuard";
import { statusLabel, valueLabel } from "../lib/labels";
import { usePlayer } from "../lib/player";
import type { ChipTone } from "../lib/queryChips";
import type { Profile, Track } from "../lib/types";
import { Artwork } from "../components/ui/Artwork";
import { EmptyState } from "../components/ui/EmptyState";
import { GlassPanel } from "../components/ui/GlassPanel";
import { IntelRow } from "../components/ui/IntelRow";
import { KeyboardHint, Kbd } from "../components/ui/KeyboardHint";
import { Segmented } from "../components/ui/Segmented";
import { SmartChip } from "../components/ui/SmartChip";
import { Waveform } from "../components/ui/Waveform";
import { Button } from "../components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { Separator } from "../components/ui/separator";
import { Textarea } from "../components/ui/textarea";
import {
  Activity,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Crosshair,
  Disc3,
  Eye,
  Flame,
  GitBranch,
  Headphones,
  Layers,
  Moon,
  Music2,
  Play,
  ShieldCheck,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Sparkles,
  Tags,
  Waves,
  Zap,
} from "../lib/icons";

gsap.registerPlugin(useGSAP);

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

/** Keyboard reference panel — expanded mirror of the keydown map (the source of truth). */
const SHORTCUTS: { section: string; rows: { keys: string[]; label: string }[] }[] = [
  {
    section: "Βαθμολογία",
    rows: [
      { keys: ["1–9", "0"], label: "ενέργεια 1–10" },
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
  muted: "border-white/10 text-cm-muted hover:border-white/20 hover:bg-white/5",
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

/** Real, non-fabricated facts about the current track (Track + fetched Profile). */
function trackFacts(t: Track, p: Profile | null): { label: string; value: string; tone: ChipTone }[] {
  const rows: { label: string; value: string; tone: ChipTone }[] = [];
  if (t.bpm != null) rows.push({ label: "BPM", value: t.bpm.toFixed(0), tone: "blue" });
  if (t.key_text) rows.push({ label: "Key", value: t.key_text, tone: "violet" });
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
  const [queue, setQueue] = useState("untagged");
  const [tracks, setTracks] = useState<Track[]>([]);
  const [idx, setIdx] = useState(0);
  const [flash, setFlash] = useState<string>("");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [notes, setNotes] = useState("");
  const [qmOpen, setQmOpen] = useState(false);
  const { play } = usePlayer();
  const rootRef = useRef<HTMLDivElement>(null);
  const flashRef = useRef<HTMLSpanElement>(null);

  const load = useCallback(async (q: string) => {
    const t = await api.listTracks(q, 0); // 0 = no limit — load the whole queue
    setTracks(t);
    setIdx(0);
  }, []);

  useEffect(() => {
    load(queue);
  }, [queue, load]);

  const current = tracks[idx];
  const currentId = current?.id;

  // Fetch the full profile for the current track so the meters reflect canonical
  // energy/darkness/confidence and the notes field reflects saved notes.
  useEffect(() => {
    if (currentId == null) {
      setProfile(null);
      setNotes("");
      return;
    }
    let alive = true;
    api
      .getTrack(currentId)
      .then((d) => {
        if (alive) {
          setProfile(d.profile);
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
      apply(patch, label);
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

  const move = useCallback(
    (delta: number) => {
      setIdx((i) => Math.min(Math.max(i + delta, 0), Math.max(tracks.length - 1, 0)));
    },
    [tracks.length],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return;
      if (!current) return;
      const k = e.key;

      if (/^[0-9]$/.test(k)) {
        const val = k === "0" ? 10 : Number(k);
        if (e.shiftKey) apply({ darkness: val }, `σκοτεινότητα ${val}`);
        else apply({ energy: val }, `ενέργεια ${val}`);
        e.preventDefault();
        return;
      }
      switch (k.toLowerCase()) {
        case "m": apply({ melody: 8 }, "μελωδικό"); break;
        case "b": apply({ set_role: "bridge" }, "ρόλος γέφυρα"); break;
        case "p": apply({ set_role: "peak" }, "ρόλος κορύφωση"); break;
        case "r": apply({ set_role: "reset" }, "ρόλος reset"); break;
        case "w": apply({ personal_status: "weapon" }, "ΟΠΛΟ"); break;
        case "a": apply({ personal_status: "approved" }, "εγκεκριμένο"); break;
        case "x": apply({ personal_status: "avoid" }, "απόφυγε"); break;
        case "j": move(1); break;
        case "k": move(-1); break;
        default: return;
      }
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, apply, move]);

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
    <div ref={rootRef} className="flex h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/8 px-6 py-4">
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
                className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-white/10 bg-cm-panel-2/50 px-3 text-xs text-cm-muted transition hover:border-white/20 hover:text-cm-text"
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                Διαχείριση ουράς
                <ChevronDown className="h-3 w-3" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-56 border-white/10 bg-cm-bg-2/95 p-2 backdrop-blur-xl">
              <div className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-cm-faint">Ουρές</div>
              <div className="flex flex-col gap-0.5">
                {FILTERS.map((f) => {
                  const Icon = f.icon;
                  const active = queue === f.q;
                  return (
                    <button
                      key={f.label}
                      type="button"
                      onClick={() => {
                        setQueue(f.q);
                        setQmOpen(false);
                      }}
                      className={cn(
                        "flex cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm transition",
                        active ? "bg-cm-cyan/15 text-cm-cyan" : "text-cm-muted hover:bg-white/5 hover:text-cm-text",
                      )}
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
          </div>

          {current ? (
            <>
              <GlassPanel strong className="glow-violet p-6">
                <div className="flex items-center gap-6">
                  <div className="relative shrink-0">
                    <Artwork seed={current.id} circle className="glow-cyan h-28 w-28 ring-2 ring-cm-cyan/40" />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="truncate text-2xl font-semibold tracking-tight text-cm-text">
                      {current.title || current.file_name}
                    </div>
                    <div className="mt-0.5 text-base text-cm-magenta">{current.artist || "Άγνωστος καλλιτέχνης"}</div>
                    {current.album && <div className="mt-0.5 truncate text-sm text-cm-faint">{current.album}</div>}

                    <div className="mt-3 flex flex-wrap items-center gap-2 font-mono">
                      <SmartChip tone="cyan" icon={Activity}>
                        {current.bpm ? `${current.bpm.toFixed(0)} BPM` : "χωρίς BPM"}
                      </SmartChip>
                      <SmartChip tone="violet" icon={Music2}>
                        {current.key_text || "χωρίς key"}
                      </SmartChip>
                      <SmartChip tone="blue" icon={Disc3}>
                        {current.genre || "χωρίς genre"}
                      </SmartChip>
                      <SmartChip tone="muted">{current.extension}</SmartChip>
                    </div>
                  </div>

                  <div className="flex shrink-0 flex-col items-end gap-3">
                    <button
                      onClick={() => play(current)}
                      title="Ακρόαση (μετά Space για play/pause)"
                      className="glow-cyan inline-flex h-10 cursor-pointer items-center gap-2 rounded-xl border border-cm-cyan/30 bg-cm-cyan/12 px-5 text-sm font-semibold text-cm-cyan transition hover:bg-cm-cyan/20"
                    >
                      <Play className="h-4 w-4" />
                      Ακρόαση
                    </button>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => move(-1)}
                        title="Προηγούμενο (K)"
                        className="inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-xl border border-white/10 bg-cm-panel-2/60 text-cm-muted transition hover:border-white/20 hover:text-cm-text"
                      >
                        <SkipBack className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => play(current)}
                        title="Ακρόαση"
                        className="inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-xl border border-cm-cyan/30 bg-cm-cyan/12 text-cm-cyan transition hover:bg-cm-cyan/20"
                      >
                        <Play className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => move(1)}
                        title="Επόμενο (J)"
                        className="inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-xl border border-white/10 bg-cm-panel-2/60 text-cm-muted transition hover:border-white/20 hover:text-cm-text"
                      >
                        <SkipForward className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </div>

                <div className="mt-5 h-12">
                  <Waveform seed={current.id} className="h-full" />
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

              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                {ACTIONS.map((a) => {
                  const Icon = a.icon;
                  return (
                    <button
                      key={a.label}
                      type="button"
                      onClick={() => rate(a.patch, a.flash)}
                      title={a.hint ? `${a.label} (${a.hint})` : a.label}
                      className={cn(
                        "relative flex cursor-pointer flex-col items-start gap-2 rounded-xl border bg-cm-panel-2/40 p-3 text-left transition",
                        ACTION_TONE[a.tone],
                      )}
                    >
                      <Icon className="h-4 w-4" />
                      <span className="text-xs font-semibold uppercase tracking-wide text-cm-text">{a.label}</span>
                      {a.hint && <Kbd className="absolute right-2 top-2">{a.hint}</Kbd>}
                    </button>
                  );
                })}
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
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
                    tone="amber"
                    ariaLabel="σιγουριά"
                    onChange={(v) => rate({ confidence: v }, `σιγουριά ${v}`)}
                  />
                </GlassPanel>
              </div>
            </>
          ) : (
            <EmptyState icon={CheckCircle2} title="Άδεια ουρά" className="w-full">
              Δεν μένει τίποτα για tagging εδώ.
            </EmptyState>
          )}
        </main>

        <aside className="flex w-80 shrink-0 flex-col gap-4 overflow-y-auto border-l border-white/8 bg-cm-bg-2/40 p-4">
          <GlassPanel className="p-4">
            <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-cm-faint">Πληκτρολόγιο</div>
            <div className="flex flex-col gap-3">
              {SHORTCUTS.map((group) => (
                <div key={group.section}>
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-cm-faint/70">{group.section}</div>
                  <div className="divide-y divide-white/5">
                    {group.rows.map((row) => (
                      <KeyboardHint key={row.label} keys={row.keys} label={row.label} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <Separator className="my-3 bg-white/5" />
            <p className="text-[11px] leading-relaxed text-cm-faint">
              Κάθε πλήκτρο γράφει αμέσως. Χωρίς dropdown γραφειοκρατία.
            </p>
          </GlassPanel>

          {current && (
            <GlassPanel className="p-4">
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-cm-faint">
                <Activity className="h-3.5 w-3.5" />
                Στοιχεία κομματιού
              </div>
              <div className="divide-y divide-white/5">
                {trackFacts(current, profile).map((f) => (
                  <IntelRow key={f.label} label={f.label} value={f.value} tone={f.tone} />
                ))}
              </div>
            </GlassPanel>
          )}

          {current && (
            <GlassPanel className="p-4">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-cm-faint">Σημειώσεις</div>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                onBlur={saveNotes}
                placeholder="Ιδέες για μεταβάσεις, διάθεση, που ταιριάζει στο set…"
                className="min-h-24 resize-none border-white/10 bg-cm-panel-2/40 text-cm-text placeholder:text-cm-faint"
              />
              <p className="mt-2 text-[11px] leading-relaxed text-cm-faint">
                Αποθηκεύεται όταν φύγει το focus. Τα πλήκτρα βαθμολογίας δεν ενεργοποιούνται όσο γράφεις.
              </p>
            </GlassPanel>
          )}
        </aside>
      </div>
    </div>
  );
}
