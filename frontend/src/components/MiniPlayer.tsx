import { bpmColor } from "../lib/bpmColor";
import { effectiveBpm, bpmDescription } from "../lib/tempo";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { activateAudio, releaseAudio, ownsPlaybackKeys, audioUrl, reportPlayback, usePlayer, useTwoDeck, type DeckId } from "../lib/player";
import { NEUTRAL_FX, cycleRange, deckGain, deckRate, faderRate, getMixer, rateBpmText, setDeckBend, setDeckRangePitch, trimDb, useDeckFx, useDeckGain, useMidiConnected } from "../lib/mixer";
import { barPhase, deckLevel, flashNote, flashSync, padsHaveCues, registerDeck } from "../lib/deckTelemetry";
import { api } from "../lib/api";
import { statusBankAction, tagBankAction, writeTagAction } from "../lib/tagKeys";
import { loadInfoOf, rateTransition, registerLoadInfo } from "../lib/transitionNote";
import { LOOP_DEFAULT_BEATS, planLoop, type LoopOp } from "../lib/loops";
import { planSync, registerSyncSource, syncSourceOf } from "../lib/deckSync";
import { createCueMachine } from "../lib/cueTransport";
import { padDelete, padPress, type PadIo } from "../lib/padActions";
import type { DeckCommand } from "../lib/midi";
import { cuePadIndex, hasOpenSurface, suppressPlaybackShortcut } from "../lib/keyboardGuard";
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
import { PitchStrip } from "./PitchStrip";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { usePlaybackProcessing } from "../lib/usePlaybackProcessing";
import { deckGraphLevel, disposePlayback, hasPlaybackGraph, playbackContext, resetLimiter, setPlaybackTone, setPlaybackTrim, setPlaybackVolume } from "../lib/playbackAudio";
import { elementMedia, type MediaLike } from "../lib/media";
import { type StretchDeck, HttpError, chooseEngine, isEngineUnavailable, stretchDeckFor } from "../lib/audio/stretchDeck";
import type { TrackCueKind } from "../lib/types";
import { playerDockHeight, PLAYER_DEFAULT_HEIGHT } from "../lib/playerLayout";
import { buildBeatGrid, gridBarPhase, useBeatGridDto } from "../lib/beatGrid";
import { useDownbeat } from "../lib/trackDownbeat";
import { acquireDetailWaveform } from "../lib/detailWaveform";
import { COMPENSATE_OUTPUT_LATENCY, displayPosition } from "../lib/deckScroll";
import { useDeckView } from "../lib/deckView";
import { DeckHeader } from "./DeckHeader";
import { DeckScrollWaveform } from "./DeckScrollWaveform";

let toneToastShown = false;
let pitchToastShown = false;
let reloadToastShown = false;
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
  // Single-deck mode ignores stored knobs (derived, never mutated), so nothing hidden applies or goes stale.
  const storedFx = useDeckFx(deck);
  const fx = twoDeck ? storedFx : NEUTRAL_FX;
  // Two-deck mode: the mixer owns this element's volume; otherwise the local popover does.
  const twoDeckRef = useRef(twoDeck);
  const gainRef = useRef(gain);
  twoDeckRef.current = twoDeck;
  gainRef.current = gain;
  const audioRef = useRef<HTMLAudioElement>(null);
  // The active source: the <audio> element, or (two-deck, chosen per load) the decoded-buffer engine.
  const mediaRef = useRef<MediaLike | null>(null);
  const [media, setMedia] = useState<MediaLike | null>(null);
  const engineRef = useRef<StretchDeck | null>(null);
  const unbindRef = useRef<(() => void) | null>(null);
  const handlersRef = useRef<Record<string, (e: Event) => void>>({});
  const processing = usePlaybackProcessing(mediaRef, current?.id ?? null, twoDeck, media);
  // These describe the source in this audio element, independently of library selection.
  const loadedTrackIdRef = useRef<number | null>(null);
  const loadedSourceUrlRef = useRef<string | null>(null);
  const metadataTrackIdRef = useRef<number | null>(null);
  const seekPendingRef = useRef(false);
  // First play of the current load (ms clock), for transition-note direction; resumes don't touch it, a new load clears it.
  const startedAtRef = useRef<number | null>(null);
  const loopBeatsRef = useRef(LOOP_DEFAULT_BEATS);
  // Jog scrub: pause while the wheel turns, then one seek (and resume) once it goes idle.
  const jogRef = useRef<{ target: number; resume: boolean; timer: ReturnType<typeof setTimeout> | null } | null>(null);
  const jogHeldRef = useRef(false); // a waveform drag holds the session open while the pointer is down
  const clearJog = useCallback(() => {
    if (jogRef.current?.timer != null) clearTimeout(jogRef.current.timer);
    jogRef.current = null;
    jogHeldRef.current = false;
  }, []);
  const cueState = useTrackCues(current?.id ?? null);
  const padLayout = useCuePadLayout(current?.id ?? null, cueState.cues, cueState.loaded && !cueState.loading && !cueState.error);

  // Two-deck panel: imported beat grid (or the BPM + entry-cue estimate), drawn by the portalled waveform.
  const entryCueS = cueState.cues.find(c => c.kind === "entry")?.position_ms;
  const gridDto = useBeatGridDto(current?.id ?? null);
  const userDownbeat = useDownbeat(current?.id ?? null).value;
  const grid = useMemo(() => buildBeatGrid(gridDto, bpm, entryCueS != null ? entryCueS / 1000 : null, userDownbeat), [gridDto, bpm, entryCueS, userDownbeat]);
  const gridRef = useRef(grid);
  gridRef.current = grid;
  const deckDrawRef = useRef<(() => void) | null>(null);
  const view = useDeckView(deck);
  // Prefetch the detail waveform once the deck settles (fast controller browsing must not queue server decodes);
  // a track change cancels the timer or releases (and aborts) the stale request.
  useEffect(() => {
    if (!twoDeck || !current) return;
    const { id, modified_time } = current;
    let held: ReturnType<typeof acquireDetailWaveform> | null = null;
    const timer = setTimeout(() => { held = acquireDetailWaveform(id, modified_time); }, 300);
    return () => { clearTimeout(timer); held?.release(); };
  }, [twoDeck, current?.id, current?.modified_time]);

  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const playheadRef = useRef<HTMLDivElement>(null);
  const waveDrawRef = useRef<((progress: number) => void) | null>(null);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const audibleVolumeRef = useRef(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [metadataReady, setMetadataReady] = useState(false);
  const [seeking, setSeeking] = useState(false);
  // Live view for the controller-feedback snapshot; the getter reads refs so registration doesn't churn.
  const telemetryRef = useRef({ current, cues: cueState.cues, slots: padLayout.slots, loading, seeking, fx });
  telemetryRef.current = { current, cues: cueState.cues, slots: padLayout.slots, loading, seeking, fx };
  const hasTrack = current != null;
  // Cue button state machine (see lib/cueTransport.ts); its I/O reads refs, so one instance serves every render.
  const cueOps = useRef({ play: () => {}, seek: (_seconds: number) => {}, identity: (): string => "" });
  cueOps.current = {
    play: () => { processing.prepare(); mediaRef.current?.play().catch(() => {}); },
    seek: seekTo,
    identity: () => `${token}:${loadedTrackIdRef.current}:${mediaRef.current === engineRef.current ? "engine" : "element"}`,
  };
  const cueMachine = useMemo(() => createCueMachine({
    position: () => mediaRef.current?.currentTime ?? 0,
    playing: () => mediaRef.current != null && !mediaRef.current.paused,
    play: () => cueOps.current.play(),
    pause: () => mediaRef.current?.pause(),
    seek: seconds => cueOps.current.seek(seconds),
    clearJog,
    entryCue: () => {
      const entry = telemetryRef.current.cues.find(c => c.kind === "entry");
      return entry ? entry.position_ms / 1000 : null;
    },
    identity: () => cueOps.current.identity(),
  }), [clearJog]);
  // Sync reads the other deck's tempo through this: bpm, and whether it is on the engine (an element deck is pinned at 1x).
  useEffect(() => registerSyncSource(deck, () => {
    const t = telemetryRef.current;
    const m = mediaRef.current;
    return t.current && m ? { bpm: effectiveBpm(t.current), engine: m === engineRef.current, fx: getMixer().fx[deck] } : null;
  }), [deck]);
  useEffect(() => registerLoadInfo(deck, () => {
    const t = telemetryRef.current.current;
    return t ? { trackId: t.id, startedAt: startedAtRef.current } : null;
  }), [deck]);
  // A preview must not outlive the controller that started it.
  const midiConnected = useMidiConnected();
  useEffect(() => { if (!midiConnected) cueMachine.cancel("disconnect"); }, [midiConnected, cueMachine]);
  useEffect(() => {
    if (!hasTrack) return;
    return registerDeck(deck, () => {
      const t = telemetryRef.current;
      const a = mediaRef.current;
      const track = t.current;
      if (!a || !track) throw new Error("no deck");
      const pads = padsHaveCues(t.slots, t.cues.map(c => c.id));
      // The element still holds the previous track until it switches; don't report its transport.
      const keylock = t.fx.keylock && a === engineRef.current; // the element can't key lock; the LED shows only what applies
      if (loadedTrackIdRef.current !== track.id) return { playing: false, bpm: effectiveBpm(track) ?? 0, positionMs: 0, durationMs: 0, pads, level: 0, barPhase: -1, rate: a.playbackRate, keylock, cueSet: false, rangePct: Math.round(t.fx.range * 100), loop: false };
      const playing = !a.paused;
      const duration = Number.isFinite(a.duration) ? a.duration : 0;
      return {
        playing, bpm: effectiveBpm(track) ?? 0,
        positionMs: a.currentTime * 1000, durationMs: duration * 1000,
        pads, rate: a.playbackRate, keylock, cueSet: cueMachine.hasCue(), rangePct: Math.round(t.fx.range * 100),
        loop: a === engineRef.current && engineRef.current.loop !== null,
        barPhase: gridBarPhase(gridRef.current, a.currentTime) >= 0 ? gridBarPhase(gridRef.current, a.currentTime)
          : barPhase(a.currentTime, (t.cues.find(c => c.kind === "entry")?.position_ms ?? 0) / 1000, effectiveBpm(track) ?? 0),
        level: deckGraphLevel(a) ?? deckLevel({
          playing, stalled: t.loading || t.seeking || seekPendingRef.current || a.seeking,
          positionSec: a.currentTime, durationSec: duration,
          envelope: cachedWaveform(track.id, track.modified_time), gain: deckGain(deck, getMixer()),
        }),
      };
    });
  }, [deck, hasTrack, current?.id, cueMachine]);
  function changeVolume(next: number) {
    if (!Number.isFinite(next)) return;
    const value = Math.max(0, Math.min(1, next));
    if (value > 0) audibleVolumeRef.current = value;
    setVolume(value);
    if (mediaRef.current) {
      setPlaybackVolume(mediaRef.current, value);
    }
  }
  // Makes `next` the active source: releases the outgoing one from the registry/keyboard ownership and moves
  // the event listeners synchronously, so events fired by an immediate load()/play() are not missed.
  function activate(next: MediaLike) {
    const prev = mediaRef.current;
    if (prev === next) return;
    unbindRef.current?.();
    if (prev) releaseAudio(prev);
    const types = Object.keys(handlersRef.current);
    const listeners = types.map(type => (e: Event) => handlersRef.current[type](e));
    types.forEach((type, i) => next.addEventListener(type, listeners[i]));
    unbindRef.current = () => types.forEach((type, i) => next.removeEventListener(type, listeners[i]));
    mediaRef.current = next;
    setMedia(next);
  }
  useEffect(() => {
    const element = audioRef.current;
    if (element) activate(elementMedia(element));
    return () => {
      clearJog(); setDeckBend(deck, 0, 0); cueMachine.cancel("replace");
      if (mediaRef.current) releaseAudio(mediaRef.current);
      if (element) disposePlayback(elementMedia(element));
      if (engineRef.current) { disposePlayback(engineRef.current); engineRef.current.unload(); engineRef.current = null; }
      unbindRef.current?.(); unbindRef.current = null;
      mediaRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearJog, deck, cueMachine]);

  // Element decks are pinned at rate 1: WebKit's MediaElementSource drops out on every playbackRate change
  // (bug 240405). Engine decks follow the fader/bend (50 ms steps while a bend is held) and key lock.
  useEffect(() => {
    const m = mediaRef.current;
    if (!m) return;
    if (m !== engineRef.current) { m.playbackRate = m.defaultPlaybackRate = 1; return; }
    const apply = () => { m.preservesPitch = fx.keylock; m.playbackRate = deckRate(fx, performance.now()); };
    apply();
    if (fx.bend.dir === 0) return;
    const timer = setInterval(apply, 50);
    return () => clearInterval(timer);
  }, [fx, media]);

  // EQ/filter. Values set before the graph exists are stored and applied when it is built; tell the user once.
  useEffect(() => {
    const audio = mediaRef.current;
    if (!audio || setPlaybackTone(audio, fx)) return;
    if (!toneToastShown && (fx.filter !== 0 || Object.values(fx.eq).some(v => v !== 0))) {
      toneToastShown = true;
      toast("Πάτησε αναπαραγωγή για ενεργοποίηση της επεξεργασίας ήχου.");
    }
  }, [fx, media]);

  // Trim joins auto-gain in the pre-EQ dB stage (single-deck mode uses the neutral fx, so it is 0 there).
  useEffect(() => {
    if (mediaRef.current) setPlaybackTrim(mediaRef.current, trimDb(fx.trim));
  }, [fx.trim, media]);

  useEffect(() => {
    const audio = mediaRef.current;
    if (audio) reportPlayback(audio, { trackId: current?.id ?? null, playing: !audio.paused && loadedTrackIdRef.current === current?.id, status: processing.status, primary, deck });
  }, [current?.id, playing, processing.status, primary, deck, media]);

  useEffect(() => {
    if (mediaRef.current) setPlaybackVolume(mediaRef.current, twoDeck ? gain : volume);
  }, [twoDeck, gain, volume, media]);

  // A deck already playing on the element when two-deck mode starts stays there at rate 1 until its next load.
  useEffect(() => {
    const m = mediaRef.current;
    if (!twoDeck || !current || !m || m === engineRef.current || m.paused || reloadToastShown || isEngineUnavailable()) return;
    reloadToastShown = true;
    toast("Φόρτωσε ξανά το track για pitch/key lock.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [twoDeck]);

  // Points `target` at the current track and starts it. The other source is unloaded: an element stops
  // fetching under preload="metadata", an engine drops its decoded buffers.
  function startSource(target: MediaLike, track: NonNullable<typeof current>, play: boolean) {
    const element = elementMedia(audioRef.current!);
    const other = target === element ? engineRef.current : element;
    if (other) other.unload();
    const switched = mediaRef.current !== target;
    activate(target);
    // The incoming source starts from its own loudness gain, not the outgoing one's.
    if (switched) processing.resetSource(target);
    target.src = audioUrl(track.id);
    loadedSourceUrlRef.current = target.src;
    setPlaybackVolume(target, twoDeckRef.current ? gainRef.current : volume);
    target.load();
    if (play) { processing.prepare(); target.play().catch(() => { if (target.paused) setPlaying(false); }); }
  }

  // Load (and autoplay) whenever the selected track or play-token changes.
  useEffect(() => {
    const element = audioRef.current;
    if (!element) return;
    clearJog();
    cueMachine.cancel(current ? "replace" : "eject");
    cueMachine.resetSession();
    startedAtRef.current = null;
    loopBeatsRef.current = LOOP_DEFAULT_BEATS;
    mediaRef.current?.pause();
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
      if (mediaRef.current) releaseAudio(mediaRef.current);
      elementMedia(element).unload();
      engineRef.current?.unload();
      setLoading(false);
      setPlaying(false);
      return;
    }

    const ext = (current.extension || "").toLowerCase();
    if (UNSUPPORTED.has(ext)) {
      elementMedia(element).unload();
      engineRef.current?.unload();
      setLoading(false);
      setPlaying(false);
      setError(`Δεν γίνεται preview για .${ext} στο browser. Άνοιξέ το εξωτερικά ή κάνε convert αργότερα.`);
      return;
    }

    setLoading(true);
    loadedTrackIdRef.current = current.id;
    // The engine is chosen per load, never swapped mid-track.
    const context = twoDeckRef.current ? playbackContext() : undefined;
    if (context && chooseEngine({ twoDeck: true, unavailable: isEngineUnavailable(), duration: current.duration, sampleRate: context.sampleRate })) {
      engineRef.current ??= stretchDeckFor(deck, context);
      startSource(engineRef.current, current, autoPlay);
    } else {
      if (twoDeckRef.current) announceNoPitch();
      startSource(elementMedia(element), current, autoPlay);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, token, autoPlay]);

  function announceNoPitch() {
    if (pitchToastShown) return;
    pitchToastShown = true;
    toast("Pitch/key lock μη διαθέσιμα για αυτό το track — παίζει στο αρχικό tempo.");
  }

  // A failed engine load (decode, size, worklet) retries the same track on the element at its original tempo.
  function fallBackToElement() {
    const element = audioRef.current;
    if (!element || !current) return;
    announceNoPitch();
    startSource(elementMedia(element), current, !(engineRef.current?.paused ?? true));
  }

  // Controller transport for this deck (see lib/midi.ts). Load protection lives in player.load().
  const deckCommandRef = useRef<(command: DeckCommand) => void>(() => {});
  deckCommandRef.current = ({ cmd, value }) => {
    if (cmd === "note") { noteTransition(value); return; } // concerns both decks, so it needs no track on this one
    const a = mediaRef.current;
    if (!a || !current) return;
    if (cmd === "toggle") {
      if (cueMachine.latch()) return; // Play during a Cue preview keeps it playing
      if (a.paused) { processing.prepare(); a.play().catch(() => {}); }
      else a.pause();
    } else if (cmd === "cue") {
      cueMachine.press(value === 1);
    } else if (cmd === "cue-release") {
      cueMachine.release();
    } else if (cmd === "sync") {
      syncDeck();
    } else if (cmd === "range") {
      cycleDeckRange();
    } else if (cmd === "pad-delete") {
      void padDelete(padIo(), value);
    } else if (cmd === "tag" || cmd === "status") {
      writeBank(cmd === "tag" ? tagBankAction(value) : statusBankAction(value));
    } else if (cmd.startsWith("loop-")) {
      loopCommand(cmd.slice(5) as LoopOp);
    } else if (cmd === "seek") {
      jogBy(value);
    } else {
      void padPress(padIo(), value);
    }
  };
  // Jog scrub: the controller wheel and the waveform drag both move the playhead through one session.
  function jogBy(value: number) {
    const a = mediaRef.current;
    if (!a || !current) return;
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
    session.timer = setTimeout(jogFinish, 150);
  }
  function jogFinish() {
    const done = jogRef.current;
    const a = mediaRef.current;
    if (!done || !a || jogHeldRef.current) return;
    if (done.timer != null) clearTimeout(done.timer);
    jogRef.current = null;
    seekTo(done.target);
    if (done.resume) { processing.prepare(); a.play().catch(() => {}); }
  }
  function jogHold(held: boolean) {
    jogHeldRef.current = held;
    if (!held) jogFinish();
  }
  // Pad I/O: reads (track, slots, cues) are live; writes (assign, create, delete) are bound to this render's track.
  function padIo(): PadIo {
    return {
      trackId: () => telemetryRef.current.current?.id ?? null,
      cues: () => telemetryRef.current.cues,
      slots: () => telemetryRef.current.slots,
      surfaceOpen: hasOpenSurface,
      seek: positionMs => seekTo(positionMs / 1000),
      capturePending: () => cueState.pendingKinds.has("cue"),
      capture: () => captureCue("cue"),
      assign: padLayout.assign,
      deleteCue: cueState.deleteCue,
      createCue: cueState.createCue,
      toast: {
        info: message => { toast(message); },
        error: message => { toast.error(message); },
        undo: (message, onUndo) => { toast(message, { duration: 6000, action: { label: "Αναίρεση", onClick: onUndo } }); },
      },
    };
  }
  // Tag/status bank pads write the track this deck holds, through the same key table as /tag.
  function writeBank(action: ReturnType<typeof tagBankAction>) {
    void writeTagAction(action, {
      track: () => { const t = telemetryRef.current.current; return t ? { id: t.id, title: t.title || t.file_name } : null; },
      update: (id, patch) => api.updateProfile(id, patch),
      toast: { success: message => { toast.success(message); }, error: message => { toast.error(message); } },
      emit: trackId => { window.dispatchEvent(new CustomEvent("cratemind:profile-updated", { detail: { trackId } })); },
    });
  }
  // FX select 1/2/3: rate the transition between the two decks' current loads (direction from who started first).
  function noteTransition(index: number) {
    void rateTransition(index, loadInfoOf("A"), loadInfoOf("B"), {
      create: body => api.createPairNote(body),
      toast: { success: message => { toast.success(message); }, error: message => { toast.error(message); }, info: message => { toast(message); } },
      flash: flashNote,
      emit: () => { window.dispatchEvent(new CustomEvent("cratemind:pair-note")); },
    });
  }
  // Loops live in the stretch engine; an element deck can't loop.
  function loopCommand(op: LoopOp) {
    const engine = engineRef.current;
    if (!engine || mediaRef.current !== engine || !hasCurrentSource(engine)) {
      if (mediaRef.current !== engine) toast("Φόρτωσε ξανά το track για loop");
      return;
    }
    const plan = planLoop(op, { position: engine.currentTime, duration: engine.duration, bpm: effectiveBpm(current), loop: engine.loop, beats: loopBeatsRef.current });
    if (!plan.ok) { toast(plan.reason === "no-bpm" ? "Loop: λείπει το BPM." : plan.reason === "limit" ? "Loop: όρια 1/8 – 32 beats." : "Loop: δεν χωράει στο track."); return; }
    if (plan.kind === "clear") engine.clearLoop();
    else if (plan.kind === "beats") loopBeatsRef.current = plan.beats;
    else if (engine.setLoop(plan.loop.start, plan.loop.end)) loopBeatsRef.current = plan.beats;
    else toast("Loop: δεν χωράει στο track.");
  }
  // Pitch features need the stretch engine; an element deck is pinned at rate 1.
  function pitchEngineReady(): boolean {
    if (twoDeckRef.current && mediaRef.current != null && mediaRef.current === engineRef.current) return true;
    toast("Φόρτωσε ξανά το track για pitch");
    return false;
  }
  function syncDeck() {
    if (!pitchEngineReady()) return;
    const own = syncSourceOf(deck);
    const ref = syncSourceOf(deck === "A" ? "B" : "A");
    if (!own || !ref) { toast("Sync: το άλλο deck είναι άδειο."); return; }
    const result = planSync(own, ref);
    if (!result.ok) { toast(result.reason === "no-bpm" ? "Sync: λείπει το BPM σε ένα από τα decks." : "Sync: το tempo είναι εκτός εύρους pitch."); return; }
    setDeckRangePitch(deck, result.plan.range, result.plan.pitch);
    flashSync(deck);
  }
  function cycleDeckRange() {
    if (!pitchEngineReady()) return;
    const plan = cycleRange(getMixer().fx[deck]);
    if (!plan) { toast("Το τρέχον tempo δεν χωράει σε άλλο εύρος pitch."); return; }
    setDeckRangePitch(deck, plan.range, plan.pitch);
  }
  useEffect(() => {
    function onDeck(e: Event) {
      const command = (e as CustomEvent<DeckCommand>).detail;
      if (command.deck === deck) deckCommandRef.current(command);
    }
    window.addEventListener("cratemind:deck", onDeck);
    return () => window.removeEventListener("cratemind:deck", onDeck);
  }, [deck]);

  // Smooth playhead: while playing, follow audio.currentTime per frame (DOM writes only, no React state).
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const a = mediaRef.current;
      if (a && hasCurrentSource(a) && a.duration > 0) {
        const p = Math.min(1, Math.max(0, a.currentTime / a.duration));
        if (playheadRef.current) playheadRef.current.style.transform = `translateX(${p * 100}%)`;
        waveDrawRef.current?.(p);
      }
      deckDrawRef.current?.();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, current?.id]);

  function hasCurrentSource(a: MediaLike): boolean {
    return current != null && loadedTrackIdRef.current === current.id
      && a.src === loadedSourceUrlRef.current && a.currentSrc === loadedSourceUrlRef.current
      && a.readyState >= 1 && !a.error;
  }

  function seekTo(seconds: number) {
    const a = mediaRef.current;
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
    const a = mediaRef.current;
    if (cueState.pendingKinds.has(kind)) { toast("Η αποθήκευση cue βρίσκεται ήδη σε εξέλιξη."); return; }
    // Read both identity and playhead synchronously before the first async operation.
    const trackId = loadedTrackIdRef.current;
    if (!a || trackId == null || trackId !== current?.id
      || metadataTrackIdRef.current !== trackId
      || a.src !== loadedSourceUrlRef.current || a.currentSrc !== loadedSourceUrlRef.current
      || a.readyState < 1 || a.error || error || a.seeking || seekPendingRef.current
      || !Number.isFinite(a.currentTime) || a.currentTime < 0) return;
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
      const a = mediaRef.current;
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
        if (cueMachine.latch()) return;
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
  }, [current, primary, captureCue, processing.prepare, padLayout.slots, cueState.cues, cueMachine]);

  // Events of the active source (element or engine), bound in activate(); the object is rebuilt each render.
  const handlers: Record<string, (e: Event) => void> = {
    play: e => {
      const m = e.currentTarget as MediaLike;
      // The play event can precede loadedmetadata/currentSrc selection.
      if (loadedTrackIdRef.current !== current?.id || m.src !== loadedSourceUrlRef.current) { m.pause(); return; }
      startedAtRef.current ??= performance.now();
      reportPlayback(m, { trackId: loadedTrackIdRef.current, playing: true, status: processing.status, primary, deck });
      activateAudio(m); setPlaying(true);
    },
    pause: () => setPlaying(false),
    waiting: () => setLoading(true),
    playing: () => setLoading(false),
    canplay: () => setLoading(false),
    loadedmetadata: e => {
      const m = e.currentTarget as MediaLike;
      if (!hasCurrentSource(m)) return;
      metadataTrackIdRef.current = loadedTrackIdRef.current;
      setMetadataReady(true);
      setDuration(Number.isFinite(m.duration) ? m.duration : 0);
    },
    seeking: e => {
      const m = e.currentTarget as MediaLike;
      if (!hasCurrentSource(m)) return;
      resetLimiter(m);
      seekPendingRef.current = true;
      setSeeking(true);
    },
    seeked: e => {
      const m = e.currentTarget as MediaLike;
      if (!hasCurrentSource(m)) return;
      seekPendingRef.current = false;
      setSeeking(false);
      setTime(m.currentTime);
    },
    timeupdate: e => {
      const m = e.currentTarget as MediaLike;
      if (hasCurrentSource(m)) setTime(m.currentTime);
    },
    ended: () => setPlaying(false),
    error: e => {
      if (e.currentTarget === engineRef.current && !(engineRef.current?.error instanceof HttpError) && current && loadedTrackIdRef.current === current.id) { fallBackToElement(); return; }
      metadataTrackIdRef.current = null;
      setMetadataReady(false);
      setLoading(false);
      setPlaying(false);
      if (current && !UNSUPPORTED.has((current.extension || "").toLowerCase())) {
        setError("Δεν φορτώθηκε audio — μη υποστηριζόμενο format ή μη διαθέσιμο αρχείο.");
      }
    },
  };
  handlersRef.current = handlers;

  // The <audio> element is always mounted so refs/effects stay stable.
  const audio = (
    <audio
      ref={audioRef}
      preload="metadata"
      onVolumeChange={(event) => {
        if (twoDeckRef.current || hasPlaybackGraph(elementMedia(event.currentTarget))) return;
        const value = event.currentTarget.muted ? 0 : event.currentTarget.volume;
        setVolume(value);
        if (value > 0) audibleVolumeRef.current = value;
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
  // Pitch and the rate-scaled BPM only apply while the engine plays this deck.
  const onEngine = twoDeck && media != null && media === engineRef.current;
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
                {bpm != null ? (onEngine ? rateBpmText(bpm, faderRate(fx)) : `${bpm.toFixed(0)} BPM`) : "— BPM"}
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

  const playButton = (
    <button data-playback-toggle type="button" onClick={toggle} disabled={!!error}
      title="Αναπαραγωγή / Παύση (Space)" aria-label={playing ? "Παύση" : "Αναπαραγωγή"}
      className="flex size-9 shrink-0 items-center justify-center rounded-full border border-cm-line/30 bg-white/10 text-cm-text outline-none transition hover:bg-cm-cyan/15 focus-visible:ring-2 focus-visible:ring-cm-cyan disabled:opacity-40 motion-safe:active:scale-95">
      {playing ? <Pause className="size-4" /> : <Play className="ml-0.5 size-4" />}
    </button>
  );
  const panel = twoDeck && view.slot && view.mode !== "hidden" && createPortal(
    <div className="absolute inset-0 flex flex-col bg-cm-bg-2/95">
      <div style={{ height: 52 }} className="shrink-0">
        <DeckHeader deck={deck} track={current} bpm={bpm}
          bpmText={bpm != null ? (onEngine ? rateBpmText(bpm, faderRate(fx)) : `${bpm.toFixed(0)} BPM`) : "— BPM"}
          keyFormat={keyFormat} time={time} duration={duration} progress={duration > 0 ? time / duration : 0}
          drawRef={waveDrawRef} playheadRef={playheadRef} />
      </div>
      {view.mode === "full" && (
        <DeckScrollWaveform className="min-h-0 flex-1" trackId={current.id} revision={current.modified_time} bpm={bpm ?? null}
          grid={grid} cues={cueState.cues} drawRef={deckDrawRef} onScrub={jogBy} onScrubHold={jogHold} onSeek={seekTo} durationS={current.duration}
          getPlayback={() => {
            const a = mediaRef.current;
            if (!a || !hasCurrentSource(a)) return null;
            const rate = a.playbackRate || 1;
            const position = jogRef.current?.target
              ?? displayPosition(a.currentTime, COMPENSATE_OUTPUT_LATENCY ? playbackContext()?.outputLatency ?? 0 : 0, rate);
            return { position, rate };
          }} />
      )}
    </div>, view.slot);

  function toggle() {
    const a = mediaRef.current;
    if (!a || cueMachine.latch()) return;
    if (a.paused) { processing.prepare(); a.play().catch(() => {}); }
    else a.pause();
  }

  return (
    <>
    {panel}
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
      {twoDeck && (
        // Keyboard seek for the panel's waveform: focusable and labelled, but visually hidden so it never covers a pointer surface.
        <input data-playback-shortcuts type="range" min={0} max={duration || 0} step={0.1} value={time}
          onChange={(e) => seekTo(Number(e.target.value))} className="sr-only" aria-label={`Μετακίνηση στο track — Deck ${deck}`} />
      )}
      <div className={cn("absolute top-1 z-30 flex items-center gap-1", (mirrored !== twoDeck) ? "right-2 flex-row-reverse" : "left-2")}>
        {twoDeck && <span className="font-mono text-[10px] font-semibold text-cm-cyan">{deck}</span>}
        <button type="button" onClick={() => eject(deck)} aria-label={`Αφαίρεση track από το Deck ${deck}`} title="Αφαίρεση track"
          className="flex size-5 items-center justify-center rounded text-cm-muted transition motion-safe:active:scale-95 duration-100 ease-out hover:bg-cm-cyan/10 hover:text-cm-cyan focus-visible:outline-2 focus-visible:outline-cm-cyan cursor-pointer">
          <Eject className="size-3.5" />
        </button>
      </div>

      <div data-player-layout className={cn("mx-auto flex h-full w-full max-w-[1800px] min-w-0 items-center gap-2 md:gap-3 lg:gap-4", mirrored && !twoDeck && "flex-row-reverse")}>
      {!twoDeck && <>
      <div className={cn("flex w-[116px] shrink-0 flex-col items-center gap-2 @max-4xl/player:w-[80px]", order.info)}>
        <div style={{ width: `${artSize}px`, height: `${artSize}px` }} className="relative max-w-full shrink-0 overflow-hidden rounded-xl border border-cm-line/20 shadow-lg">
          <Artwork seed={current.id} trackId={current.id} className="h-full w-full object-cover" />
          <button data-playback-toggle type="button" onClick={toggle} disabled={!!error}
            title="Αναπαραγωγή / Παύση (Space)" aria-label={playing ? "Παύση" : "Αναπαραγωγή"}
            className="group absolute inset-0 flex items-center justify-center bg-black/10 text-white outline-none transition hover:bg-black/25 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cm-cyan disabled:opacity-40">
            <span className="flex size-10 items-center justify-center rounded-full motion-safe:group-active:scale-95 transition-transform duration-100 ease-out border border-white/45 bg-white/15 shadow-lg backdrop-blur-md">
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
      </div>

      {/* Audio envelope scrubber: the canvas is pointer-events-none;
          the invisible range input on top does the real seeking — invariant preserved.
          Keep its reference proportions within the compact dock. */}
      <div data-player-waveform className={cn("relative h-full max-h-[130px] min-h-0 min-w-8 max-w-[800px] flex-[1_1_800px] self-center", order.wave)}>
        <TrackWaveform
          trackId={current.id}
          sourceRevision={current.modified_time}
          progress={duration > 0 ? time / duration : 0}
          drawRef={waveDrawRef}
          className="absolute inset-0"
        />
        <div ref={playheadRef} className="pointer-events-none absolute inset-y-1 left-0 z-10 w-full" style={{ transform: `translateX(${pct}%)` }}>
          <div className="h-full w-0.5 bg-cm-cyan shadow-[0_0_8px_var(--color-cm-cyan)]" />
        </div>
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
      </>}

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
      {twoDeck && <PitchStrip deck={deck} fx={fx} active={onEngine} className={mirrored ? "order-last" : "order-first"} />}
      <div className={cn(twoDeck ? "flex h-full min-h-0 min-w-[180px] flex-[0_1_300px] flex-col items-center justify-center gap-1 text-xs" : "contents", order.pads)}>
      <CuePads key={current.id} className={cn(twoDeck && "h-auto max-h-[128px] min-w-0 max-w-none flex-[1_1_0%] self-stretch")} trackId={current.id} state={cueState} slots={padLayout.slots} compact={twoDeck}
        canCapture={canCapture} canSeek={canSeek} onCapture={captureCue}
        onSeek={positionMs => seekTo(positionMs / 1000)} onAssign={padLayout.assign}
        onCreate={async slot => { const cue = await captureCue("cue"); if (cue) padLayout.assign(slot, cue.id); }} />
      {twoDeck && <div className="flex items-center justify-center gap-2">{playButton}{eq}{bpmKey}</div>}
      </div>
      </div>
    </div>
    </>
  );
}
