import { useEffect, useRef, useState } from "react";
import { audioUrl, usePlayer } from "../lib/player";
import { isTypingTarget } from "../lib/keyboardGuard";
import { cn } from "../lib/cn";
import { Headphones, Pause, Play, TriangleAlert, Volume2, VolumeX } from "../lib/icons";
import { StatusBadge } from "./ui/StatusBadge";
import { Artwork } from "./ui/Artwork";
import { Waveform } from "./ui/Waveform";

const UNSUPPORTED = new Set(["aiff", "aif"]);

function fmt(t: number): string {
  if (!isFinite(t) || t < 0) return "0:00";
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// keyboard-shortcut guard now lives in lib/keyboardGuard (Radix-aware, shared)

export default function MiniPlayer() {
  const { current, token } = usePlayer();
  const audioRef = useRef<HTMLAudioElement>(null);

  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load (and autoplay) whenever the selected track or play-token changes.
  useEffect(() => {
    const a = audioRef.current;
    if (!a || !current) return;
    setError(null);
    setTime(0);
    setDuration(0);

    const ext = (current.extension || "").toLowerCase();
    if (UNSUPPORTED.has(ext)) {
      a.removeAttribute("src");
      a.load();
      setLoading(false);
      setPlaying(false);
      setError(`Δεν γίνεται preview για .${ext} στο browser. Άνοιξέ το εξωτερικά ή κάνε convert αργότερα.`);
      return;
    }

    setLoading(true);
    a.src = audioUrl(current.id);
    a.volume = volume;
    a.load();
    a.play().catch(() => setPlaying(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, token]);

  // Keyboard: Space = play/pause, Arrows = seek ±5s (±30s with Shift).
  // Never fires while typing; uses keys not bound by tagging shortcuts.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return;
      const a = audioRef.current;
      if (!a || !current) return;
      if (e.code === "Space") {
        e.preventDefault();
        if (a.paused) a.play().catch(() => {});
        else a.pause();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        a.currentTime = Math.min(a.duration || 0, a.currentTime + (e.shiftKey ? 30 : 5));
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        a.currentTime = Math.max(0, a.currentTime - (e.shiftKey ? 30 : 5));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current]);

  // The <audio> element is always mounted so refs/effects stay stable.
  const audio = (
    <audio
      ref={audioRef}
      preload="metadata"
      onPlay={() => setPlaying(true)}
      onPause={() => setPlaying(false)}
      onWaiting={() => setLoading(true)}
      onPlaying={() => setLoading(false)}
      onCanPlay={() => setLoading(false)}
      onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
      onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
      onEnded={() => setPlaying(false)}
      onError={() => {
        setLoading(false);
        setPlaying(false);
        if (current && !UNSUPPORTED.has((current.extension || "").toLowerCase())) {
          setError("Δεν φορτώθηκε audio — μη υποστηριζόμενο format ή μη διαθέσιμο αρχείο.");
        }
      }}
    />
  );

  const dockBase =
    "flex items-center gap-4 border-t border-white/8 bg-cm-bg-2/70 px-5 py-2.5 backdrop-blur-xl";

  // Idle dock — always present so the cockpit feels alive and content never jumps.
  if (!current) {
    return (
      <div className={dockBase}>
        {audio}
        <Headphones className="h-4 w-4 text-cm-faint" />
        <span className="text-xs text-cm-faint">Διάλεξε track για ακρόαση.</span>
      </div>
    );
  }

  const label = current.title || current.file_name;
  const pct = duration > 0 ? (time / duration) * 100 : 0;

  function toggle() {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) a.play().catch(() => {});
    else a.pause();
  }

  return (
    <div className={cn(dockBase, playing && !error && "border-cm-cyan/20")}>
      {audio}

      <button
        onClick={toggle}
        disabled={!!error}
        title="Αναπαραγωγή / Παύση (Space)"
        aria-label={playing ? "Παύση" : "Αναπαραγωγή"}
        className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-cm-bg transition disabled:opacity-40",
          "bg-gradient-to-br from-cm-cyan to-cm-blue hover:brightness-110",
          playing && !error && "glow-cyan",
        )}
      >
        {playing ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}
      </button>

      {/* equalizer — only while actually playing; CSS handles reduced-motion */}
      {playing && !error && (
        <div className="hidden h-5 items-end gap-0.5 sm:flex" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              className="cm-eq-bar w-0.5 rounded-full bg-cm-cyan"
              style={{ height: "100%", animationDelay: `${i * 120}ms` }}
            />
          ))}
        </div>
      )}

      <Artwork seed={current.id} className="h-10 w-10" />

      <div className="min-w-0 w-48 shrink-0">
        <div className="truncate text-sm font-medium text-cm-text" title={current.artist ? `${current.artist} — ${label}` : label}>
          {label}
        </div>
        <div className="flex items-center gap-1.5 truncate text-xs text-cm-faint">
          {current.artist && <span className="truncate">{current.artist}</span>}
          <StatusBadge status={current.personal_status} className="scale-90" />
        </div>
      </div>

      <span className="w-10 shrink-0 text-right font-mono text-[11px] tabular-nums text-cm-muted">
        {fmt(time)}
      </span>

      {/* Cosmetic waveform scrubber: Waveform is decorative (pointer-events-none);
          the invisible range input on top does the real seeking — invariant preserved. */}
      <div className="relative h-8 min-w-0 flex-1">
        <Waveform seed={current.id} progress={duration > 0 ? time / duration : 0} className="absolute inset-0" />
        <div className="pointer-events-none absolute inset-y-0 w-px bg-cm-cyan/80" style={{ left: `${pct}%` }} />
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={time}
          onChange={(e) => {
            const a = audioRef.current;
            if (a) a.currentTime = Number(e.target.value);
          }}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          aria-label="Μετακίνηση στο track"
        />
      </div>

      <span className="w-10 shrink-0 font-mono text-[11px] tabular-nums text-cm-muted">{fmt(duration)}</span>

      <div className="hidden w-28 shrink-0 items-center gap-1.5 md:flex">
        <button
          onClick={() => {
            const v = volume > 0 ? 0 : 1;
            setVolume(v);
            if (audioRef.current) audioRef.current.volume = v;
          }}
          aria-label={volume > 0 ? "Σίγαση" : "Ήχος"}
          className="text-cm-faint transition hover:text-cm-text"
        >
          {volume > 0 ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => {
            const v = Number(e.target.value);
            setVolume(v);
            if (audioRef.current) audioRef.current.volume = v;
          }}
          className="w-full cursor-pointer"
          aria-label="Ένταση ήχου"
        />
      </div>

      <div className="hidden w-44 shrink-0 justify-end text-right text-xs lg:flex">
        {error ? (
          <span className="inline-flex items-center gap-1 text-cm-rose" title={error}>
            <TriangleAlert className="h-3.5 w-3.5" /> μη υποστηριζόμενο
          </span>
        ) : loading ? (
          <span className="text-cm-faint">φόρτωση…</span>
        ) : (
          <span className="font-mono text-[10px] uppercase tracking-wider text-cm-faint">
            {current.bpm ? `${current.bpm.toFixed(0)} BPM` : ""}
            {current.key_text ? ` · ${current.key_text}` : ""}
          </span>
        )}
      </div>
    </div>
  );
}
