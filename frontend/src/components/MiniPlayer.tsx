import { bpmColor } from "../lib/bpmColor";
import { effectiveBpm, bpmDescription } from "../lib/tempo";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { activateAudio, releaseAudio, ownsPlaybackKeys, audioUrl, usePlayer } from "../lib/player";
import { isTypingTarget } from "../lib/keyboardGuard";
import { cn } from "../lib/cn";
import { Headphones, Pause, Play, TriangleAlert, Volume2, VolumeX } from "../lib/icons";
import { StatusBadge } from "./ui/StatusBadge";
import { Artwork } from "./ui/Artwork";
import { TrackWaveform } from "./ui/TrackWaveform";
import { CUE_KIND_LABELS, CueMarkers, formatCueTime, PlayerCues } from "./PlayerCues";
import { ResizeHandle } from "./ui/ResizeHandle";
import { usePref } from "../lib/prefs";
import { keyColor, formatKey } from "../lib/camelot";
import { useTrackCues } from "../lib/trackCues";
import type { Track, TrackCueKind } from "../lib/types";

const UNSUPPORTED = new Set(["aiff", "aif"]);

function fmt(t: number): string {
  if (!isFinite(t) || t < 0) return "0:00";
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export interface MiniPlayerProps {
  track?: Track | null;
  autoPlay?: boolean;
  height?: number;
  isDragging?: boolean;
  handleProps?: {
    onPointerDown: (e: React.PointerEvent) => void;
    onDoubleClick: () => void;
  };
}

export default function MiniPlayer({
  track,
  autoPlay = true,
  height = 64,
  isDragging = false,
  handleProps,
}: MiniPlayerProps = {}) {
  const [keyFormat] = usePref("keyFormat");
  const globalPlayer = usePlayer();
  const primary = track === undefined;
  const current = primary ? globalPlayer.current : track;
  const bpm = effectiveBpm(current);
  const token = primary ? globalPlayer.token : 0;
  const audioRef = useRef<HTMLAudioElement>(null);
  // These describe the source in this audio element, independently of library selection.
  const loadedTrackIdRef = useRef<number | null>(null);
  const loadedSourceUrlRef = useRef<string | null>(null);
  const metadataTrackIdRef = useRef<number | null>(null);
  const seekPendingRef = useRef(false);
  const cueState = useTrackCues(current?.id ?? null);

  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [metadataReady, setMetadataReady] = useState(false);
  const [seeking, setSeeking] = useState(false);
  useEffect(() => {
    const audio = audioRef.current;
    return () => { if (audio) releaseAudio(audio); };
  }, []);

  // Load (and autoplay) whenever the selected track or play-token changes.
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    loadedTrackIdRef.current = null;
    loadedSourceUrlRef.current = null;
    metadataTrackIdRef.current = null;
    seekPendingRef.current = false;
    setMetadataReady(false);
    setSeeking(false);
    setError(null);
    setTime(0);
    setDuration(0);
    if (!current) {
      releaseAudio(a);
      a.removeAttribute("src");
      a.load();
      setLoading(false);
      setPlaying(false);
      return;
    }

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
    loadedTrackIdRef.current = current.id;
    a.src = audioUrl(current.id);
    loadedSourceUrlRef.current = a.src;
    a.volume = volume;
    a.load();
    if (autoPlay) a.play().catch(() => setPlaying(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, token, autoPlay]);

  function hasCurrentSource(a: HTMLAudioElement): boolean {
    return current != null && loadedTrackIdRef.current === current.id
      && a.src === loadedSourceUrlRef.current && a.currentSrc === loadedSourceUrlRef.current
      && a.readyState >= 1 && !a.error;
  }

  function seekTo(seconds: number) {
    const a = audioRef.current;
    if (!a || !hasCurrentSource(a) || !Number.isFinite(seconds) || seconds < 0) return;
    const next = Number.isFinite(a.duration) && a.duration > 0
      ? Math.min(seconds, a.duration) : seconds;
    if (next === a.currentTime) return;
    seekPendingRef.current = true;
    setSeeking(true);
    try {
      a.currentTime = next;
      setTime(next);
    } catch {
      seekPendingRef.current = false;
      setSeeking(false);
      toast.error("Δεν έγινε η μετακίνηση στο track.");
    }
  }

  const captureCue = useCallback((kind: TrackCueKind) => {
    const a = audioRef.current;
    // Read both identity and playhead synchronously before the first async operation.
    const trackId = loadedTrackIdRef.current;
    if (!a || trackId == null || trackId !== current?.id
      || metadataTrackIdRef.current !== trackId
      || a.src !== loadedSourceUrlRef.current || a.currentSrc !== loadedSourceUrlRef.current
      || a.readyState < 1 || a.error || error || a.seeking || seekPendingRef.current
      || !Number.isFinite(a.currentTime) || a.currentTime < 0
      || cueState.pendingKinds.has(kind)) return;
    const positionMs = Math.round(a.currentTime * 1000);
    if (!Number.isSafeInteger(positionMs)) return;
    const snapshot = { trackId, positionMs };
    const description = `${current.title || current.file_name} · ${formatCueTime(snapshot.positionMs)}`;
    const notification = toast.loading(`Αποθήκευση ${CUE_KIND_LABELS[kind]}…`, { description });
    // createCue closes over this track ID; switching tracks cannot reassign the write.
    void cueState.createCue({ position_ms: snapshot.positionMs, kind }).then(() => {
      toast.success(`${CUE_KIND_LABELS[kind]} αποθηκεύτηκε`, { id: notification, description, duration: 1800 });
    }).catch((cause: unknown) => {
      toast.error(`Το ${CUE_KIND_LABELS[kind]} δεν αποθηκεύτηκε`, {
        id: notification,
        description: cause instanceof Error ? cause.message : "Δοκίμασε ξανά.",
      });
    });
  }, [current, error, cueState.createCue, cueState.pendingKinds]);

  // Physical I/O/C do not collide with the queue's tagging/rating bindings.
  // Only the audio owning playback keys responds; buttons target their own deck.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || isTypingTarget(e.target)) return;
      const a = audioRef.current;
      if (!a || !current || !ownsPlaybackKeys(a, primary)) return;
      const kind = ({ KeyI: "entry", KeyO: "exit", KeyC: "cue" } as const)[e.code as "KeyI" | "KeyO" | "KeyC"];
      if (kind) {
        if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
        e.preventDefault();
        captureCue(kind);
      } else if (e.code === "Space") {
        e.preventDefault();
        if (a.paused) a.play().catch(() => {});
        else a.pause();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        seekTo(Math.min(a.duration || 0, a.currentTime + (e.shiftKey ? 30 : 5)));
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        seekTo(Math.max(0, a.currentTime - (e.shiftKey ? 30 : 5)));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, primary, captureCue]);

  // The <audio> element is always mounted so refs/effects stay stable.
  const audio = (
    <audio
      ref={audioRef}
      preload="metadata"
      onPlay={(e) => { activateAudio(e.currentTarget); setPlaying(true); }}
      onPause={() => setPlaying(false)}
      onWaiting={() => setLoading(true)}
      onPlaying={() => setLoading(false)}
      onCanPlay={() => setLoading(false)}
      onLoadedMetadata={(e) => {
        if (!hasCurrentSource(e.currentTarget)) return;
        metadataTrackIdRef.current = loadedTrackIdRef.current;
        setMetadataReady(true);
        setDuration(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0);
      }}
      onSeeking={(e) => {
        if (!hasCurrentSource(e.currentTarget)) return;
        seekPendingRef.current = true;
        setSeeking(true);
      }}
      onSeeked={(e) => {
        if (!hasCurrentSource(e.currentTarget)) return;
        seekPendingRef.current = false;
        setSeeking(false);
        setTime(e.currentTarget.currentTime);
      }}
      onTimeUpdate={(e) => {
        if (hasCurrentSource(e.currentTarget)) setTime(e.currentTarget.currentTime);
      }}
      onEnded={() => setPlaying(false)}
      onError={() => {
        metadataTrackIdRef.current = null;
        setMetadataReady(false);
        setLoading(false);
        setPlaying(false);
        if (current && !UNSUPPORTED.has((current.extension || "").toLowerCase())) {
          setError("Δεν φορτώθηκε audio — μη υποστηριζόμενο format ή μη διαθέσιμο αρχείο.");
        }
      }}
    />
  );

  const dockBase =
    "@container/player flex items-center gap-2 md:gap-3 lg:gap-4 border-t border-cm-line/20 dark:border-white/8 bg-cm-bg-2/70 px-3 md:px-5 py-2.5 backdrop-blur-xl";

  const isTall = height >= 90;
  const isDeck = height >= 120;
  const artSize = Math.max(0, height - 30); // 15px above and below at every player height

  // Idle dock — always present so the cockpit feels alive and content never jumps.
  if (!current) {
    return (
      <div
        style={{ height: `${height}px` }}
        className={cn(dockBase, "relative h-full", isTall ? "px-6" : "px-5")}
      >
        {handleProps && (
          <ResizeHandle
            orientation="horizontal"
            isDragging={isDragging}
            ariaLabel="Αλλαγή ύψους player"
            className="absolute -top-1.5 inset-x-0 z-30"
            {...handleProps}
          />
        )}
        {audio}
        <Headphones className={cn("text-cm-faint shrink-0", isTall ? "h-5 w-5" : "h-4 w-4")} />
        <span className={cn("text-cm-faint", isTall ? "text-sm" : "text-xs")}>
          Διάλεξε track για ακρόαση.
        </span>
      </div>
    );
  }

  const label = current.title || current.file_name;
  const pct = duration > 0 ? (time / duration) * 100 : 0;
  const canSeek = metadataReady && metadataTrackIdRef.current === current.id && !error;
  const canCapture = canSeek && !seeking;

  function toggle() {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) a.play().catch(() => {});
    else a.pause();
  }

  return (
    <div
      style={{ height: `${height}px` }}
      className={cn(
        dockBase,
        "relative h-full",
        isTall ? "px-3 md:px-6 py-3" : "px-3 md:px-5 py-2.5",
        playing && !error && "border-cm-cyan/20",
      )}
    >
      {handleProps && (
        <ResizeHandle
          orientation="horizontal"
          isDragging={isDragging}
          ariaLabel="Αλλαγή ύψους player"
          className="absolute -top-1.5 inset-x-0 z-30"
          {...handleProps}
        />
      )}
      {audio}

      <button
        onClick={toggle}
        disabled={!!error}
        title="Αναπαραγωγή / Παύση (Space)"
        aria-label={playing ? "Παύση" : "Αναπαραγωγή"}
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full text-cm-bg transition disabled:opacity-40",
          "bg-gradient-to-br from-cm-cyan to-cm-blue hover:brightness-110",
          isDeck ? "h-12 w-12" : isTall ? "h-11 w-11" : "h-10 w-10",
          playing && !error && "glow-cyan",
        )}
      >
        {playing ? (
          <Pause className={cn(isDeck ? "h-5 w-5" : "h-4 w-4")} />
        ) : (
          <Play className={cn("ml-0.5", isDeck ? "h-5 w-5" : "h-4 w-4")} />
        )}
      </button>

      <div style={{ width: `${artSize}px`, height: `${artSize}px` }} className="hidden shrink-0 @5xl/player:block">
        <Artwork seed={current.id} trackId={current.id} className="h-full w-full rounded-lg object-cover" />
      </div>

      <div className="hidden min-w-0 shrink-0 w-[100px] @3xl/player:block @6xl/player:w-[175px]">
        <div
          className={cn(
            "truncate font-medium text-cm-text",
            isDeck ? "text-[15px] font-semibold" : "text-sm",
          )}
          title={current.artist ? `${current.artist} — ${label}` : label}
        >
          {label}
        </div>
        <div className="flex items-center gap-1.5 truncate text-xs text-cm-faint">
          {current.artist && <span className="truncate">{current.artist}</span>}
          <StatusBadge status={current.personal_status} className="scale-90" />
        </div>
      </div>

      <span
        className={cn(
          "hidden w-10 shrink-0 text-right font-mono tabular-nums text-cm-muted @lg/player:block",
          isTall ? "text-xs" : "text-[11px]",
        )}
      >
        {fmt(time)}
      </span>

      {/* Audio envelope scrubber: the canvas is pointer-events-none;
          the invisible range input on top does the real seeking — invariant preserved.
          self-stretch utilizes the full available vertical height of the bottom player bar. */}
      <div className="relative min-w-8 flex-1 self-stretch my-1">
        <TrackWaveform
          trackId={current.id}
          sourceRevision={current.modified_time}
          progress={duration > 0 ? time / duration : 0}
          className="absolute inset-0"
        />
        <div
          className="pointer-events-none absolute inset-y-0 z-10 w-0.5 bg-cm-cyan shadow-[0_0_8px_var(--color-cm-cyan)]"
          style={{ left: `${pct}%` }}
        />
        <CueMarkers
          cues={cueState.cues}
          duration={duration}
          canSeek={canSeek}
          onSeek={(positionMs) => seekTo(positionMs / 1000)}
        />
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={time}
          onChange={(e) => seekTo(Number(e.target.value))}
          className="absolute inset-0 z-20 h-full w-full cursor-pointer opacity-0"
          aria-label="Μετακίνηση στο track"
        />
      </div>

      <span
        className={cn(
          "hidden w-10 shrink-0 font-mono tabular-nums text-cm-muted @lg/player:block",
          isTall ? "text-xs" : "text-[11px]",
        )}
      >
        {fmt(duration)}
      </span>

      <PlayerCues
        key={current.id}
        trackId={current.id}
        state={cueState}
        canCapture={canCapture}
        canSeek={canSeek}
        onCapture={captureCue}
        onSeek={(positionMs) => seekTo(positionMs / 1000)}
      />

      {/* Volume and BPM/key badges adapt to this deck's available width. */}
      <div className="flex shrink-0 items-center gap-3">
        <div className="hidden w-24 items-center gap-1.5 @2xl/player:flex @5xl/player:w-28">
          <button
            onClick={() => {
              const v = volume > 0 ? 0 : 1;
              setVolume(v);
              if (audioRef.current) audioRef.current.volume = v;
            }}
            aria-label={volume > 0 ? "Σίγαση" : "Ήχος"}
            className="text-cm-faint transition hover:text-cm-text cursor-pointer"
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
            className="w-full cursor-pointer accent-cm-cyan"
            aria-label="Ένταση ήχου"
          />
        </div>

        <div className={cn("flex-col items-center justify-center gap-[10px] text-xs", error ? "flex" : "hidden @7xl/player:flex")}>
      {/* equalizer — only while actually playing; CSS handles reduced-motion */}
      {playing && !error && (
        <div
          className={cn("hidden items-end gap-0.5 sm:flex", isDeck ? "h-7" : isTall ? "h-6" : "h-2")}
          aria-hidden
        >
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              className={cn("cm-eq-bar rounded-full bg-cm-cyan", isDeck ? "w-1" : "w-0.5")}
              style={{ height: "100%", animationDelay: `${i * 120}ms` }}
            />
          ))}
        </div>
      )}


          {error ? (
            <span role="alert" className="inline-flex items-center gap-1 font-mono text-[11px] text-cm-rose" title={error}>
              <TriangleAlert aria-hidden="true" className="h-3.5 w-3.5" />
              <span aria-hidden="true" className="hidden @lg/player:inline">μη διαθέσιμο</span>
              <span className="sr-only">{error}</span>
            </span>
          ) : (
            <div aria-busy={loading} className="relative flex items-center gap-1.5 rounded-md border border-cm-line/20 dark:border-white/10 bg-white/5 px-2 py-1 font-mono text-xs tabular-nums shadow-xs">
              {loading && <span role="status" aria-label="Φόρτωση ήχου" className="absolute -bottom-2 left-1/2 h-1 w-6 -translate-x-1/2 rounded-full bg-cm-cyan motion-safe:animate-pulse" />}
              <span style={{color: bpmColor(bpm)}} title={bpmDescription(current)} className="font-medium text-cm-cyan">
                {bpm != null ? `${bpm.toFixed(0)} BPM` : "— BPM"}
              </span>
              <span className="text-cm-faint/60">·</span>
              <span style={{ color: keyColor(current.key_text, current.key_analyzed) }} className="font-medium text-cm-chartreuse">
                {formatKey(current.key_text, current.key_analyzed, keyFormat)}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
