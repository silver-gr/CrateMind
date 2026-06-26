import { useEffect, useRef, useState } from "react";
import { audioUrl, usePlayer } from "../lib/player";

const UNSUPPORTED = new Set(["aiff", "aif"]);

function fmt(t: number): string {
  if (!isFinite(t) || t < 0) return "0:00";
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

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
      setError(`.${ext} can't be played in the browser (transcoding not supported yet)`);
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
      if (isTyping(e.target)) return;
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
          setError("Couldn't load audio — unsupported format or file unavailable.");
        }
      }}
    />
  );

  if (!current) return <>{audio}</>;

  const label = current.artist
    ? `${current.artist} — ${current.title || current.file_name}`
    : current.title || current.file_name;

  function toggle() {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) a.play().catch(() => {});
    else a.pause();
  }

  return (
    <div className="flex items-center gap-4 border-t border-neutral-800 bg-neutral-950 px-4 py-2 text-sm">
      {audio}
      <button
        onClick={toggle}
        disabled={!!error}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-base hover:bg-emerald-500 disabled:opacity-40"
        title="Play/Pause (Space)"
      >
        {playing ? "❚❚" : "▶"}
      </button>

      <div className="min-w-0 w-56 shrink-0">
        <div className="truncate font-medium text-neutral-100" title={label}>{label}</div>
        <div className="truncate text-xs text-neutral-500">
          {current.bpm ? `${current.bpm.toFixed(0)} BPM` : ""}
          {current.key_text ? ` · ${current.key_text}` : ""}
          {` · ${current.extension}`}
        </div>
      </div>

      <span className="w-10 shrink-0 text-right text-xs tabular-nums text-neutral-400">{fmt(time)}</span>
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
        className="min-w-0 flex-1 accent-emerald-500"
        aria-label="Seek"
      />
      <span className="w-10 shrink-0 text-xs tabular-nums text-neutral-400">{fmt(duration)}</span>

      <div className="flex w-28 shrink-0 items-center gap-1">
        <span className="text-xs text-neutral-500">🔊</span>
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
          className="w-full accent-emerald-500"
          aria-label="Volume"
        />
      </div>

      <div className="w-40 shrink-0 text-right text-xs">
        {error ? (
          <span className="text-red-400" title={error}>⚠ {error.length > 28 ? "unplayable" : error}</span>
        ) : loading ? (
          <span className="text-neutral-500">loading…</span>
        ) : (
          <span className="text-neutral-700">audition</span>
        )}
      </div>
    </div>
  );
}
