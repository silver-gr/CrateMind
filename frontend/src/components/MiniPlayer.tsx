import { bpmColor } from "../lib/bpmColor";
import { effectiveBpm, bpmDescription } from "../lib/tempo";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { activateAudio, releaseAudio, ownsPlaybackKeys, audioUrl, reportPlayback, usePlayer, useTwoDeck, type DeckId } from "../lib/player";
import { deckGain, getMixer, useDeckGain } from "../lib/mixer";
import { deckLevel, padsHaveCues, registerDeck } from "../lib/deckTelemetry";
import type { DeckCommand } from "../lib/midi";
import { cuePadIndex, suppressPlaybackShortcut } from "../lib/keyboardGuard";
import { cn } from "../lib/cn";
import { Eject, Headphones, Pause, Play, TriangleAlert, Volume2, VolumeX } from "../lib/icons";
import { StatusBadge } from "./ui/StatusBadge";
import { Artwork } from "./ui/Artwork";
import { TrackWaveform, cachedWaveform } from "./ui/TrackWaveform";
import { CUE_KIND_LABELS, CueMarkers, formatCueTime } from "./PlayerCues";
import { ResizeHandle } from "./ui/ResizeHandle";
import { usePref } from "../lib/prefs";
import { keyColor, formatKey } from "../lib/camelot";
import { CuePads } from "./CuePads";
import { useCuePadLayout } from "../lib/cuePads";
import { useTrackCues } from "../lib/trackCues";
import { Slider } from "./ui/slider";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { usePlaybackProcessing } from "../lib/usePlaybackProcessing";
import { disposePlayback, hasPlaybackGraph, resetLimiter, setPlaybackVolume } from "../lib/playbackAudio";
import type { TrackCueKind } from "../lib/types";
import { playerDockHeight, PLAYER_DEFAULT_HEIGHT } from "../lib/playerLayout";

const UNSUPPORTED = new Set(["aiff", "aif"]);

function fmt(t: number): string {
  if (!isFinite(t) || t < 0) return "0:00";
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export interface MiniPlayerProps {
  /** Which deck slot this player shows; Deck A is the primary (keyboard default) deck. */
  deck?: DeckId;
  /** Lay out transport/pads on the outer edge for the right-hand deck. */
  mirrored?: boolean;
  height?: number;
  isDragging?: boolean;
  handleProps?: {
    onPointerDown: (e: React.PointerEvent) => void;
    onDoubleClick: () => void;
  };
}

export default function MiniPlayer({
  deck = "A",
  mirrored = false,
  height = PLAYER_DEFAULT_HEIGHT,
  isDragging = false,
  handleProps,
}: MiniPlayerProps = {}) {
  const twoDeck = useTwoDeck();
  const dockHeight = playerDockHeight(height, twoDeck);
  const [keyFormat] = usePref("keyFormat");
  const { slots, eject } = usePlayer();
  const primary = deck === "A";
  const { track: current, token, autoPlay } = slots[deck];
  const bpm = effectiveBpm(current);
  const gain = useDeckGain(deck);
  // Two-deck mode: the mixer owns this element's volume; otherwise the local popover does.
  const twoDeckRef = useRef(twoDeck);
  const gainRef = useRef(gain);
  twoDeckRef.current = twoDeck;
  gainRef.current = gain;
  const audioRef = useRef<HTMLAudioElement>(null);
  const processing = usePlaybackProcessing(audioRef, current?.id ?? null);
  // These describe the source in this audio element, independently of library selection.
  const loadedTrackIdRef = useRef<number | null>(null);
  const loadedSourceUrlRef = useRef<string | null>(null);
  const metadataTrackIdRef = useRef<number | null>(null);
  const seekPendingRef = useRef(false);
  // Jog scrub: pause while the wheel turns, then one seek (and resume) once it goes idle.
  const jogRef = useRef<{ target: number; resume: boolean; timer: ReturnType<typeof setTimeout> | null } | null>(null);
  const clearJog = useCallback(() => {
    if (jogRef.current?.timer != null) clearTimeout(jogRef.current.timer);
    jogRef.current = null;
  }, []);
  const cueState = useTrackCues(current?.id ?? null);
  const padLayout = useCuePadLayout(current?.id ?? null, cueState.cues, cueState.loaded && !cueState.loading && !cueState.error);

  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const audibleVolumeRef = useRef(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [metadataReady, setMetadataReady] = useState(false);
  const [seeking, setSeeking] = useState(false);
  // Live view for the controller-feedback snapshot; the getter reads refs so registration doesn't churn.
  const telemetryRef = useRef({ current, cues: cueState.cues, slots: padLayout.slots, loading, seeking });
  telemetryRef.current = { current, cues: cueState.cues, slots: padLayout.slots, loading, seeking };
  const hasTrack = current != null;
  useEffect(() => {
    if (!hasTrack) return;
    return registerDeck(deck, () => {
      const t = telemetryRef.current;
      const a = audioRef.current;
      const track = t.current;
      if (!a || !track) throw new Error("no deck");
      const pads = padsHaveCues(t.slots, t.cues.map(c => c.id));
      // The element still holds the previous track until it switches; don't report its transport.
      if (loadedTrackIdRef.current !== track.id) return { playing: false, bpm: effectiveBpm(track) ?? 0, positionMs: 0, durationMs: 0, pads, level: 0 };
      const playing = !a.paused;
      const duration = Number.isFinite(a.duration) ? a.duration : 0;
      return {
        playing, bpm: effectiveBpm(track) ?? 0,
        positionMs: a.currentTime * 1000, durationMs: duration * 1000,
        pads,
        level: deckLevel({
          playing, stalled: t.loading || t.seeking || seekPendingRef.current || a.seeking,
          positionSec: a.currentTime, durationSec: duration,
          envelope: cachedWaveform(track.id, track.modified_time), gain: deckGain(deck, getMixer()),
        }),
      };
    });
  }, [deck, hasTrack, current?.id]);
  function changeVolume(next: number) {
    if (!Number.isFinite(next)) return;
    const value = Math.max(0, Math.min(1, next));
    if (value > 0) audibleVolumeRef.current = value;
    setVolume(value);
    if (audioRef.current) {
      setPlaybackVolume(audioRef.current, value);
    }
  }
  useEffect(() => {
    const audio = audioRef.current;
    return () => { clearJog(); if (audio) { releaseAudio(audio); disposePlayback(audio); } };
  }, [clearJog]);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) reportPlayback(audio, { trackId: current?.id ?? null, playing: !audio.paused && loadedTrackIdRef.current === current?.id, status: processing.status, primary, deck });
  }, [current?.id, playing, processing.status, primary, deck]);

  useEffect(() => {
    if (audioRef.current) setPlaybackVolume(audioRef.current, twoDeck ? gain : volume);
  }, [twoDeck, gain, volume]);

  // Load (and autoplay) whenever the selected track or play-token changes.
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    clearJog();
    a.pause();
    processing.resetSource();
    loadedTrackIdRef.current = null;
    loadedSourceUrlRef.current = null;
    metadataTrackIdRef.current = null;
    seekPendingRef.current = false;
    setMetadataReady(false);
    setSeeking(false);
    setError(null);
    setPlaying(false);
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
    setPlaybackVolume(a, twoDeckRef.current ? gainRef.current : volume);
    a.load();
    if (autoPlay) { processing.prepare(); a.play().catch(() => { if (a.paused) setPlaying(false); }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, token, autoPlay]);

  // Controller transport for this deck (see lib/midi.ts). Load protection lives in player.load().
  const deckCommandRef = useRef<(command: DeckCommand) => void>(() => {});
  deckCommandRef.current = ({ cmd, value }) => {
    const a = audioRef.current;
    if (!a || !current) return;
    if (cmd === "toggle") {
      if (a.paused) { processing.prepare(); a.play().catch(() => {}); }
      else a.pause();
    } else if (cmd === "seek") {
      // Overlapping seeks into unbuffered audio while playing lose movement: scrub paused, seek once when idle.
      let session = jogRef.current;
      if (!session) {
        session = jogRef.current = { target: a.currentTime, resume: !a.paused, timer: null };
        if (session.resume) a.pause();
      }
      const max = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : Infinity;
      session.target = Math.max(0, Math.min(max, session.target + value));
      setTime(session.target);
      if (session.timer != null) clearTimeout(session.timer);
      const done = session;
      session.timer = setTimeout(() => {
        if (jogRef.current !== done) return;
        jogRef.current = null;
        seekTo(done.target);
        if (done.resume) { processing.prepare(); a.play().catch(() => {}); }
      }, 150);
    } else {
      const cue = cueState.cues.find(cue => cue.id === padLayout.slots[value]);
      if (cue) seekTo(cue.position_ms / 1000);
    }
  };
  useEffect(() => {
    function onDeck(e: Event) {
      const command = (e as CustomEvent<DeckCommand>).detail;
      if (command.deck === deck) deckCommandRef.current(command);
    }
    window.addEventListener("cratemind:deck", onDeck);
    return () => window.removeEventListener("cratemind:deck", onDeck);
  }, [deck]);

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

  const captureCue = useCallback(async (kind: TrackCueKind) => {
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
    try {
      const cue = await cueState.createCue({ position_ms: snapshot.positionMs, kind });
      toast.success(`${CUE_KIND_LABELS[kind]} αποθηκεύτηκε`, { id: notification, description, duration: 1800 });
      return cue;
    } catch (cause: unknown) {
      toast.error(`Το ${CUE_KIND_LABELS[kind]} δεν αποθηκεύτηκε`, {
        id: notification,
        description: cause instanceof Error ? cause.message : "Δοκίμασε ξανά.",
      });
    }
  }, [current, error, cueState.createCue, cueState.pendingKinds]);

  // Physical I/O/C do not collide with the queue's tagging/rating bindings.
  // Only the audio owning playback keys responds; buttons target their own deck.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || suppressPlaybackShortcut(e.target, e.code) || e.ctrlKey || e.metaKey || e.altKey || (e.code === "Space" && e.shiftKey)) return;
      const a = audioRef.current;
      if (!a || !current || !ownsPlaybackKeys(a, primary)) return;
      const padIndex = cuePadIndex(e.code);
      if (padIndex !== null && !e.shiftKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.repeat) return;
        const cue = cueState.cues.find(cue => cue.id === padLayout.slots[padIndex]);
        if (cue) seekTo(cue.position_ms / 1000);
        return; // Empty pad keyboard activation never creates or rates anything.
      }
      const kind = ({ KeyI: "entry", KeyO: "exit", KeyC: "cue" } as const)[e.code as "KeyI" | "KeyO" | "KeyC"];
      if (kind) {
        if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
        e.preventDefault();
        captureCue(kind);
      } else if (e.code === "Space") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.repeat || e.shiftKey) return;
        if (a.paused) { processing.prepare(); a.play().catch(() => {}); }
        else a.pause();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        seekTo(Math.min(a.duration || 0, a.currentTime + (e.shiftKey ? 30 : 5)));
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        seekTo(Math.max(0, a.currentTime - (e.shiftKey ? 30 : 5)));
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [current, primary, captureCue, processing.prepare, padLayout.slots, cueState.cues]);

  // The <audio> element is always mounted so refs/effects stay stable.
  const audio = (
    <audio
      ref={audioRef}
      preload="metadata"
      onPlay={(e) => {
        // The play event can precede loadedmetadata/currentSrc selection.
        if (loadedTrackIdRef.current !== current?.id || e.currentTarget.src !== loadedSourceUrlRef.current) { e.currentTarget.pause(); return; }
        reportPlayback(e.currentTarget, { trackId: loadedTrackIdRef.current, playing: true, status: processing.status, primary, deck });
        activateAudio(e.currentTarget); setPlaying(true);
      }}
      onPause={() => setPlaying(false)}
      onVolumeChange={(event) => {
        if (twoDeckRef.current || hasPlaybackGraph(event.currentTarget)) return;
        const value = event.currentTarget.muted ? 0 : event.currentTarget.volume;
        setVolume(value);
        if (value > 0) audibleVolumeRef.current = value;
      }}
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
        resetLimiter(e.currentTarget);
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
    "@container/player flex items-center justify-center gap-2 border-t border-cm-line/20 dark:border-white/8 bg-cm-bg-2/65 dark:bg-cm-bg-2/50 px-3 md:px-6 py-2 backdrop-blur-xl";

  const isTall = dockHeight >= 90;
  const isDeck = dockHeight >= 120;
  const artSize = Math.min(96, Math.max(54, dockHeight - 58));

  // Idle dock — always present so the cockpit feels alive and content never jumps.
  if (!current) {
    return (
      <div
        style={{ height: `${dockHeight}px` }}
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
          {deck === "B" ? "Deck B άδειο — φόρτωσε track (Load 2)." : "Διάλεξε track για ακρόαση."}
        </span>
      </div>
    );
  }

  const label = current.title || current.file_name;
  const pct = duration > 0 ? (time / duration) * 100 : 0;
  const canSeek = metadataReady && metadataTrackIdRef.current === current.id && !error;
  const canCapture = canSeek && !seeking;

  const eq = (
      playing && !error && (
        <div
          className={cn("flex items-end gap-0.5", isDeck ? "h-7" : isTall ? "h-6" : "h-2")}
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
      )
  );
  const bpmKey = (
          error ? (
            <span role="alert" className="inline-flex items-center gap-1 font-mono text-[11px] text-cm-rose" title={error}>
              <TriangleAlert aria-hidden="true" className="h-3.5 w-3.5" />
              <span aria-hidden="true" className="hidden @lg/player:inline">μη διαθέσιμο</span>
              <span className="sr-only">{error}</span>
            </span>
          ) : (
            <div aria-busy={loading} className="relative flex flex-wrap justify-center items-center gap-1 rounded-md border border-cm-line/20 dark:border-white/10 bg-white/5 px-2 py-1 font-mono text-xs tabular-nums shadow-xs">
              {loading && <span role="status" aria-label="Φόρτωση ήχου" className="absolute -bottom-2 left-1/2 h-1 w-6 -translate-x-1/2 rounded-full bg-cm-cyan motion-safe:animate-pulse" />}
              <span style={{color: bpmColor(bpm)}} title={bpmDescription(current)} className="font-medium text-cm-cyan">
                {bpm != null ? `${bpm.toFixed(0)} BPM` : "— BPM"}
              </span>
              <span className="text-cm-faint/60">·</span>
              <span style={{ color: keyColor(current.key_text, current.key_analyzed) }} className="font-medium text-cm-chartreuse">
                {formatKey(current.key_text, current.key_analyzed, keyFormat)}
              </span>
            </div>
          )
  );
  // Two-deck: outer edge -> inward is pads | waveform | time | info (mirrored for deck B).
  const order = !twoDeck ? { pads: "", wave: "", time: "", info: "" }
    : mirrored ? { pads: "order-3", wave: "order-2", time: "order-1", info: "order-0" }
    : { pads: "order-0", wave: "order-1", time: "order-2", info: "order-3" };

  function toggle() {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) { processing.prepare(); a.play().catch(() => {}); }
    else a.pause();
  }

  return (
    <div
      style={{ height: `${dockHeight}px` }}
      className={cn(
        dockBase,
        "relative h-full",
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
      <div className={cn("absolute top-1 z-30 flex items-center gap-1", (mirrored !== twoDeck) ? "right-2 flex-row-reverse" : "left-2")}>
        {twoDeck && <span className="font-mono text-[10px] font-semibold text-cm-cyan">{deck}</span>}
        <button type="button" onClick={() => eject(deck)} aria-label={`Αφαίρεση track από το Deck ${deck}`} title="Αφαίρεση track"
          className="flex size-5 items-center justify-center rounded text-cm-muted transition hover:bg-cm-cyan/10 hover:text-cm-cyan focus-visible:outline-2 focus-visible:outline-cm-cyan cursor-pointer">
          <Eject className="size-3.5" />
        </button>
      </div>

      <div data-player-layout className={cn("mx-auto flex h-full w-full max-w-[1800px] min-w-0 items-center gap-2 md:gap-3 lg:gap-4", mirrored && !twoDeck && "flex-row-reverse")}>
      <div className={cn("flex w-[116px] shrink-0 flex-col items-center gap-2 @max-4xl/player:w-[80px]", order.info)}>
        <div style={{ width: `${artSize}px`, height: `${artSize}px` }} className="relative max-w-full shrink-0 overflow-hidden rounded-xl border border-cm-line/20 shadow-lg">
          <Artwork seed={current.id} trackId={current.id} className="h-full w-full object-cover" />
          <button data-playback-toggle type="button" onClick={toggle} disabled={!!error}
            title="Αναπαραγωγή / Παύση (Space)" aria-label={playing ? "Παύση" : "Αναπαραγωγή"}
            className="absolute inset-0 flex items-center justify-center bg-black/10 text-white outline-none transition hover:bg-black/25 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cm-cyan disabled:opacity-40">
            <span className="flex size-10 items-center justify-center rounded-full border border-white/45 bg-white/15 shadow-lg backdrop-blur-md">
              {playing ? <Pause className="size-4" /> : <Play className="ml-0.5 size-4" />}
            </span>
          </button>
        </div>
        <div className="w-full min-w-0 text-center">
          <div className="truncate text-xs font-semibold text-cm-text" title={current.artist ? `${current.artist} — ${label}` : label}>{label}</div>
          <div className="flex items-center justify-center gap-1 truncate text-[10px] text-cm-muted">
            {current.artist && <span className="truncate">{current.artist}</span>}
            <StatusBadge status={current.personal_status} className="scale-75" />
          </div>
        </div>
        {twoDeck && <div className="flex items-center justify-center gap-2 text-xs">{eq}{bpmKey}</div>}
      </div>

      {/* Audio envelope scrubber: the canvas is pointer-events-none;
          the invisible range input on top does the real seeking — invariant preserved.
          Keep its reference proportions within the compact dock. */}
      <div data-player-waveform className={cn("relative h-full max-h-[130px] min-h-0 min-w-8 max-w-[800px] flex-[1_1_800px] self-center", order.wave)}>
        <TrackWaveform
          trackId={current.id}
          sourceRevision={current.modified_time}
          progress={duration > 0 ? time / duration : 0}
          className="absolute inset-0"
        />
        <div
          className="pointer-events-none absolute inset-y-1 z-10 w-0.5 bg-cm-cyan shadow-[0_0_8px_var(--color-cm-cyan)]"
          style={{ left: `${pct}%` }}
        />
        <CueMarkers
          cues={cueState.cues}
          slots={padLayout.slots}
          duration={duration}
          canSeek={canSeek}
          onSeek={(positionMs) => seekTo(positionMs / 1000)}
        />
        <input
          data-playback-shortcuts
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

      <div role="group" aria-label="Χρόνος αναπαραγωγής" className={cn("relative min-h-0 w-12 shrink-0 self-stretch font-mono text-[10px] tabular-nums", order.time)}>
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 text-center">
          <span className="sr-only">Τρέχων χρόνος </span><span className="font-medium text-cm-text">{fmt(time)}</span>
          <div aria-hidden className="my-1 h-px bg-cm-border-hi" />
          <span className="sr-only">Συνολική διάρκεια </span><span className="text-cm-muted">{fmt(duration)}</span>
        </div>
      </div>

      {/* Volume and BPM/key badges adapt to this deck's available width. */}
      {!twoDeck && <div className="flex w-[108px] shrink-0 flex-col-reverse items-center gap-3 @max-4xl/player:w-[86px]">
        {!twoDeck && <Popover>
          <PopoverTrigger asChild>
            <button data-playback-shortcuts type="button" aria-label="Έλεγχος έντασης" title={`Ένταση ${Math.round(volume * 100)}%`}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-cm-muted transition hover:bg-cm-cyan/10 hover:text-cm-cyan focus-visible:outline-2 focus-visible:outline-cm-cyan cursor-pointer">
              {volume > 0 ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
            </button>
          </PopoverTrigger>
          <PopoverContent side="top" align="center" aria-label="Ένταση ήχου" className="flex w-14 flex-col items-center gap-2 rounded-lg p-3">
            <Slider orientation="vertical" min={0} max={1} step={0.01} value={[volume]}
              onValueChange={([value]) => changeVolume(value)}
              className="cursor-pointer data-[orientation=vertical]:h-28 data-[orientation=vertical]:min-h-0 [&_[data-slot=slider-track]]:bg-cm-border-hi [&_[data-slot=slider-range]]:bg-cm-cyan [&_[data-slot=slider-thumb]]:size-3 [&_[data-slot=slider-thumb]]:border-cm-cyan [&_[data-slot=slider-thumb]]:bg-cm-cyan"
              aria-label="Ένταση ήχου" aria-valuetext={`${Math.round(volume * 100)}%`} />
            <button type="button" onClick={() => changeVolume(volume > 0 ? 0 : audibleVolumeRef.current)}
              aria-label={volume > 0 ? "Σίγαση" : "Επαναφορά ήχου"}
              className="flex h-6 w-6 items-center justify-center rounded text-cm-muted hover:bg-cm-cyan/10 hover:text-cm-cyan focus-visible:outline-2 focus-visible:outline-cm-cyan">
              {volume > 0 ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
            </button>
          </PopoverContent>
        </Popover>}

        <div className="flex flex-col items-center justify-center gap-[10px] text-xs">
          {eq}
          {bpmKey}
        </div>
      </div>}
      <CuePads key={current.id} className={cn(twoDeck && "min-w-[180px] flex-[0_1_300px]", order.pads)} trackId={current.id} state={cueState} slots={padLayout.slots}
        canCapture={canCapture} canSeek={canSeek} onCapture={captureCue}
        onSeek={positionMs => seekTo(positionMs / 1000)} onAssign={padLayout.assign}
        onCreate={async slot => { const cue = await captureCue("cue"); if (cue) padLayout.assign(slot, cue.id); }} />
      </div>
    </div>
  );
}
