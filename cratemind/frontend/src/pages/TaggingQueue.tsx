import type { ComponentType } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { api } from "../lib/api";
import { isTypingTarget } from "../lib/keyboardGuard";
import { usePlayer } from "../lib/player";
import type { ChipTone } from "../lib/queryChips";
import type { Profile, Track } from "../lib/types";
import { GlassPanel } from "../components/ui/GlassPanel";
import { SmartChip } from "../components/ui/SmartChip";
import { KeyboardHint } from "../components/ui/KeyboardHint";
import { EmptyState } from "../components/ui/EmptyState";
import { Separator } from "../components/ui/separator";
import {
  Activity,
  Ban,
  CheckCircle2,
  CircleDot,
  Crosshair,
  Disc3,
  Flame,
  GitBranch,
  Headphones,
  ListFilter,
  Music2,
  Play,
  SkipBack,
  SkipForward,
  Sparkles,
} from "../lib/icons";

gsap.registerPlugin(useGSAP);

const QUEUES: { label: string; q: string }[] = [
  { label: "Χωρίς tags", q: "untagged" },
  { label: "Δοκιμή", q: "testing" },
  { label: "Όλα", q: "" },
];

const HELP = [
  ["1–9 / 0", "ενέργεια 1–10"],
  ["Shift+1–0", "σκοτεινότητα 1–10"],
  ["M", "μελωδικό"],
  ["B / P / R", "γέφυρα / κορύφωση / reset"],
  ["W / A / X", "όπλο / εγκεκριμένο / απόφυγε"],
  ["J / K", "επόμενο / προηγούμενο"],
];

const ACTIONS: {
  label: string;
  tone: ChipTone;
  icon: ComponentType<{ className?: string }>;
  patch: Partial<Profile>;
  flash: string;
}[] = [
  { label: "Δοκιμή", tone: "cyan", icon: Headphones, patch: { personal_status: "testing" }, flash: "δοκιμή" },
  { label: "Εγκεκριμένο", tone: "chartreuse", icon: CheckCircle2, patch: { personal_status: "approved" }, flash: "εγκεκριμένο" },
  { label: "Όπλο", tone: "magenta", icon: Crosshair, patch: { personal_status: "weapon" }, flash: "ΟΠΛΟ" },
  { label: "Απόφυγε", tone: "rose", icon: Ban, patch: { personal_status: "avoid" }, flash: "απόφυγε" },
  { label: "Γέφυρα", tone: "blue", icon: GitBranch, patch: { set_role: "bridge" }, flash: "ρόλος γέφυρα" },
  { label: "Κορύφωση", tone: "amber", icon: Flame, patch: { set_role: "peak" }, flash: "ρόλος κορύφωση" },
  { label: "Reset", tone: "muted", icon: CircleDot, patch: { set_role: "reset" }, flash: "ρόλος reset" },
];

export default function TaggingQueue() {
  const [queue, setQueue] = useState("untagged");
  const [tracks, setTracks] = useState<Track[]>([]);
  const [idx, setIdx] = useState(0);
  const [flash, setFlash] = useState<string>("");
  const { play } = usePlayer();
  const rootRef = useRef<HTMLDivElement>(null);
  const flashRef = useRef<HTMLSpanElement>(null);

  const load = useCallback(async (q: string) => {
    const t = await api.listTracks(q);
    setTracks(t);
    setIdx(0);
  }, []);

  useEffect(() => {
    load(queue);
  }, [queue, load]);

  const current = tracks[idx];

  const apply = useCallback(
    async (patch: Partial<Profile>, label: string) => {
      if (!current) return;
      await api.updateProfile(current.id, patch);
      setFlash(`${current.title || current.file_name}: ${label}`);
    },
    [current],
  );

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

  return (
    <div ref={rootRef} className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-5 p-8">
        <div className="flex items-center gap-2">
          {QUEUES.map((qd) => (
            <SmartChip
              key={qd.label}
              tone="violet"
              icon={ListFilter}
              active={queue === qd.q}
              onClick={() => setQueue(qd.q)}
            >
              {qd.label}
            </SmartChip>
          ))}
        </div>

        {current ? (
          <>
            <GlassPanel strong className="glow-violet w-full max-w-xl p-7 text-center">
              <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-cm-faint tabular-nums">
                {idx + 1} <span className="text-cm-faint/50">/</span> {tracks.length}
              </div>
              <div className="mt-3 truncate text-2xl font-semibold tracking-tight text-cm-text">
                {current.title || current.file_name}
              </div>
              <div className="mt-1 text-base text-cm-muted">{current.artist || "Άγνωστος καλλιτέχνης"}</div>

              <div className="mt-4 flex flex-wrap items-center justify-center gap-2 font-mono">
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

              <div
                className="mt-4 truncate font-mono text-[11px] text-cm-faint"
                title={current.absolute_path}
              >
                {current.absolute_path}
              </div>

              <Separator className="mx-auto mt-5 max-w-xs bg-white/8" />

              <div className="mt-4 flex items-center justify-center gap-2">
                <button
                  onClick={() => move(-1)}
                  title="Προηγούμενο (K)"
                  className="inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-xl border border-white/10 bg-cm-panel-2/60 text-cm-muted transition hover:border-white/20 hover:text-cm-text"
                >
                  <SkipBack className="h-4 w-4" />
                </button>
                <button
                  onClick={() => play(current)}
                  title="Ακρόαση (μετά Space για play/pause)"
                  className="glow-cyan inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-xl border border-cm-cyan/30 bg-cm-cyan/12 px-4 text-sm font-medium text-cm-cyan transition hover:bg-cm-cyan/20"
                >
                  <Play className="h-4 w-4" />
                  Ακρόαση
                </button>
                <button
                  onClick={() => move(1)}
                  title="Επόμενο (J)"
                  className="inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-xl border border-white/10 bg-cm-panel-2/60 text-cm-muted transition hover:border-white/20 hover:text-cm-text"
                >
                  <SkipForward className="h-4 w-4" />
                </button>
              </div>

              {flash && (
                <div className="mt-5 flex justify-center">
                  <span
                    ref={flashRef}
                    className="glow-cyan inline-flex items-center gap-1.5 rounded-full border border-cm-cyan/30 bg-cm-cyan/12 px-3 py-1 font-mono text-xs text-cm-cyan"
                  >
                    <Sparkles className="h-3 w-3" />
                    {flash}
                  </span>
                </div>
              )}
            </GlassPanel>

            <div className="flex w-full max-w-xl flex-wrap items-center justify-center gap-2">
              {ACTIONS.map((a) => (
                <SmartChip key={a.label} tone={a.tone} icon={a.icon} onClick={() => apply(a.patch, a.flash)}>
                  {a.label}
                </SmartChip>
              ))}
            </div>
          </>
        ) : (
          <EmptyState icon={CheckCircle2} title="Άδεια ουρά" className="w-full max-w-xl">
            Δεν μένει τίποτα για tagging εδώ.
          </EmptyState>
        )}
      </div>

      <aside className="flex w-72 shrink-0 flex-col gap-4 border-l border-white/8 bg-cm-bg-2/40 p-4">
        <GlassPanel className="p-4">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-cm-faint">Πληκτρολόγιο</div>
          <div className="divide-y divide-white/5">
            {HELP.map(([k, v]) => (
              <KeyboardHint key={k} keys={k.split(" / ")} label={v} />
            ))}
          </div>
          <Separator className="my-3 bg-white/5" />
          <p className="text-[11px] leading-relaxed text-cm-faint">
            Κάθε πλήκτρο γράφει αμέσως. Χωρίς dropdown γραφειοκρατία.
          </p>
        </GlassPanel>
      </aside>
    </div>
  );
}
