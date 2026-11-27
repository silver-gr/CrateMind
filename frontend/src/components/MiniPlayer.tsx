import { bpmColor } from "../lib/bpmColor";
import { effectiveBpm, bpmDescription } from "../lib/tempo";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { activateAudio, releaseAudio, ownsPlaybackKeys, audioUrl, reportPlayback, usePlayer, useTwoDeck, type DeckId } from "../lib/player";
import { useTrackDrop } from "../lib/trackDrag";
import { NEUTRAL_FX, cycleRange, deckGain, deckRate, faderRate, formatPitchPercent, getMixer, planRate, rateBpmText, setDeckBend, setDeckRangePitch, setSyncLock, trimDb, useDeckFx, useDeckGain, useMidiConnected, useSyncLock } from "../lib/mixer";
import { barPhase, deckLevel, flashNote, padsHaveCues, registerDeck } from "../lib/deckTelemetry";
import { api } from "../lib/api";
import { cuePadKeysEnabled, statusBankAction, tagBankAction, writeTagAction } from "../lib/tagKeys";
import { loadInfoOf, rateTransition, registerLoadInfo } from "../lib/transitionNote";
import { LOOP_DEFAULT_BEATS, planLoop, type LoopOp } from "../lib/loops";
import { foldNote, forgetOnBpmChange, gridFits, lockStep, loopKeepsBeats, newLock, ownCount, phaseShift, planSync, registerSyncSource, syncSourceOf, type LockState, type SyncFold } from "../lib/deckSync";
import { createDeckTransportGetter, deckTransportOf, registerDeckTransport, transportOwnerOf } from "../lib/mix/deckTransport";
import { getMixSession, subscribeMix } from "../lib/mix/mixSession";
import { createCueMachine } from "../lib/cueTransport";
import { padDelete, padKeep, padPress, type PadIo } from "../lib/padActions";
import { usePadGhosts } from "../lib/padGhosts";
import type { DeckCommand } from "../lib/midi";
import { cuePadIndex, hasOpenSurface, suppressPlaybackShortcut } from "../lib/keyboardGuard";
import { cn } from "../lib/cn";
import { Eject, Headphones, Pause, Play, TriangleAlert, Volume2, VolumeX } from "../lib/icons";
import { StatusBadge } from "./ui/StatusBadge";
import { Artwork } from "./ui/Artwork";
import { TrackWaveform, cachedWaveform } from "./ui/TrackWaveform";
import { CUE_KIND_LABELS, CueMarkers, formatCueTime } from "./PlayerCues";
import { ResizeHandle } from "./ui/ResizeHandle";
import { KeyLabel } from "./ui/KeyBadge";
import { getPref, usePref } from "../lib/prefs";
import { cueJump, loopOnBeats, quantizeGrid, snapToBeat } from "../lib/quantize";
import { keyColor, formatKey, fallbackKey } from "../lib/camelot";
import { CuePads } from "./CuePads";
import { useCuePadLayout } from "../lib/cuePads";
import { useTrackCues } from "../lib/trackCues";
import { Slider } from "./ui/slider";
import { PitchStrip } from "./PitchStrip";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { usePlaybackProcessing } from "../lib/usePlaybackProcessing";
import { deckGraphLevel, disposePlayback, hasPlaybackGraph, playbackContext, resetLimiter, setPlaybackTone, setPlaybackTrim, setPlaybackVolume } from "../lib/playbackAudio";
import { elementMedia, type MediaLike } from "../lib/media";
import { type StretchDeck, HttpError, JunkBeforeAudioError, chooseEngine, isEngineUnavailable, stretchDeckFor } from "../lib/audio/stretchDeck";
import type { TrackCueKind } from "../lib/types";
import { playerDockHeight, PLAYER_DEFAULT_HEIGHT } from "../lib/playerLayout";
import { buildBeatGrid, gridBarPhase, gridBpm, shiftByBeats, useBeatGridDto } from "../lib/beatGrid";
import { useDownbeat } from "../lib/trackDownbeat";
import { acquireDetailWaveform } from "../lib/detailWaveform";
import { COMPENSATE_OUTPUT_LATENCY, displayPosition } from "../lib/deckScroll";
import { useDeckView } from "../lib/deckView";
import { DeckElectricEdge } from "./DeckElectricEdge";
import { DeckHeader, DeckOverview, deckRule } from "./DeckHeader";
import { DeckRatingStrip } from "./DeckRatingStrip";
import { DeckFacts } from "./DeckFacts";
import { ActionContextMenu } from "./ui/context-menu";
import { pickDeck } from "../lib/menus/deckMenu";
import { useDeckMenu } from "../lib/menus/useDeckMenu";
import { lastSeconds, timeLeftText } from "../lib/deckFacts";
import { OverviewHover } from "./OverviewHover";
import { DeckScrollWaveform } from "./DeckScrollWaveform";
import { BpmOctaveButtons } from "./BpmOctaveButtons";

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
  const [deckRating] = usePref("deckRating");
  const { slots, eject, load } = usePlayer();
  // A track dragged from a list loads here, but never over a playing deck.
  const trackDrop = useTrackDrop((track) => {
    if (!load(deck, track, { play: false, ifIdle: true })) toast(`Το Deck ${deck} παίζει — δεν φορτώθηκε`);
  });
  const primary = deck === "A";
  const { track: current, token, autoPlay } = slots[deck];
  // Right-click on the deck's header, facts half and (one deck) info, overview and time; not on the scrolling lane or the pads.
  const deckMenu = useDeckMenu(deck, current);
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
  // What the facts row's «LOOP» chip shows: the next loop's length. Whether a loop runs is read from the engine; this state
  // only redraws the chip after a loop command on a paused deck.
  const [loopBeats, setLoopBeats] = useState(LOOP_DEFAULT_BEATS);
  const [, setLooping] = useState(false);
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
  // One tempo per deck: a stored steady grid's measured BPM when it agrees with the resolved BPM, else the resolved BPM.
  const deckBpm = gridBpm(grid, bpm) ?? bpm;
  const deckBpmRef = useRef(deckBpm);
  deckBpmRef.current = deckBpm;
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
  // Sync lock (lib/deckSync.ts): this deck follows the other one. `step`: the lock's own memory. `refTrack`/`ownTrack`:
  // the tracks it was made for. `pitch`: the fader value it last planned. `rate`: the engine rate it holds now (null: the
  // fader's). `tempo`: that rate without the trim and the other deck's bend. `snapUntil`/`hand`: see lockTick. `fold`:
  // the half/double count this lock chose for this deck's track (null: not chosen yet); `syncFold` shows it. `ownBpm`/
  // `refBpm`: the BPMs it was planned from (forgetOnBpmChange).
  const locked = useSyncLock() === deck;
  const lockRef = useRef<{ step: LockState; refTrack: number | null; ownTrack: number | null; pitch: number; rate: number | null; tempo: number | null; snapUntil: number; hand: boolean; fold: SyncFold | null; ownBpm: number | null; refBpm: number | null } | null>(null);
  const [syncFold, setSyncFold] = useState<SyncFold>(1);
  const [error, setError] = useState<string | null>(null);
  const [metadataReady, setMetadataReady] = useState(false);
  const [seeking, setSeeking] = useState(false);
  // Live view for the controller-feedback snapshot; the getter reads refs so registration doesn't churn.
  const telemetryRef = useRef({ current, cues: cueState.cues, slots: padLayout.slots, loading, seeking, fx });
  telemetryRef.current = { current, cues: cueState.cues, slots: padLayout.slots, loading, seeking, fx };
  // Suggested cues on empty pads («Προτεινόμενα cues από τη δομή», off by default: then always none).
  const padGhosts = usePadGhosts(current?.id ?? null, grid, duration, padLayout.slots, cueState.cues, cueState.loaded && !cueState.loading && !cueState.error);
  const padGhostsRef = useRef(padGhosts);
  padGhostsRef.current = padGhosts;
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
    return t.current && m ? { bpm: deckBpmRef.current, engine: m === engineRef.current, fx: getMixer().fx[deck] } : null;
  }), [deck]);
  useEffect(() => registerLoadInfo(deck, () => {
    const t = telemetryRef.current.current;
    return t ? { trackId: t.id, startedAt: startedAtRef.current } : null;
  }), [deck]);
  // Automated transitions (lib/mix) read and drive this deck through its refs, so one registration serves every load.
  useEffect(() => registerDeckTransport(deck, createDeckTransportGetter({
    engine: () => engineRef.current,
    media: () => mediaRef.current,
    loadedTrackId: () => loadedTrackIdRef.current,
    loadedSourceUrl: () => loadedSourceUrlRef.current,
    current: () => telemetryRef.current.current,
    grid: () => gridRef.current,
    cues: () => telemetryRef.current.cues,
    bpm: () => deckBpmRef.current,
    play: () => cueOps.current.play(),
    seek: seconds => cueOps.current.seek(seconds),
  })), [deck]);
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
        playing, bpm: deckBpmRef.current ?? 0,
        positionMs: a.currentTime * 1000, durationMs: duration * 1000,
        pads, rate: lockRef.current?.tempo ?? a.playbackRate, keylock, cueSet: cueMachine.hasCue(), rangePct: Math.round(t.fx.range * 100),
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
  // (bug 240405). Engine decks follow the fader/bend (50 ms steps while a bend is held) and key lock; a Sync lock
  // that is holding the beats sets the rate instead (lockTick), so this effect must not write the fader's over it.
  useEffect(() => {
    const m = mediaRef.current;
    if (!m) return;
    if (m !== engineRef.current) { m.playbackRate = m.defaultPlaybackRate = 1; return; }
    const apply = () => { m.preservesPitch = fx.keylock; m.playbackRate = (fx.bend.dir === 0 ? lockRef.current?.rate : null) ?? deckRate(fx, performance.now()); };
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
    setLoopBeats(LOOP_DEFAULT_BEATS); setLooping(false);
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
    if (transportOwnerOf(deck) && cmd !== "note" && cmd !== "cue-release") return;
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
    if (done.resume && lockRef.current) lockRef.current.hand = true; // a scrub while playing is the DJ placing the beats: Sync lock keeps them there
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
      suggestion: slot => padGhostsRef.current[slot] ?? null,
      surfaceOpen: hasOpenSurface,
      seek: positionMs => jumpToCue(positionMs / 1000),
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
      emit: (trackId, patch) => { window.dispatchEvent(new CustomEvent("cratemind:profile-updated", { detail: { trackId, patch } })); },
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
    const plan = planLoop(op, { position: engine.currentTime, duration: engine.duration, bpm: deckBpm, loop: engine.loop, beats: loopBeatsRef.current, grid: quantGrid() });
    if (!plan.ok) { toast(plan.reason === "no-bpm" ? "Loop: λείπει το BPM." : plan.reason === "limit" ? "Loop: όρια 1/8 – 32 beats." : "Loop: δεν χωράει στο track."); return; }
    if (plan.kind === "clear") engine.clearLoop();
    else if (plan.kind === "beats") loopBeatsRef.current = plan.beats;
    else if (engine.setLoop(plan.loop.start, plan.loop.end)) loopBeatsRef.current = plan.beats;
    else toast("Loop: δεν χωράει στο track.");
    setLoopBeats(loopBeatsRef.current); setLooping(engine.loop !== null);
  }
  // Pitch features need the stretch engine; an element deck is pinned at rate 1.
  function pitchEngineReady(): boolean {
    if (twoDeckRef.current && mediaRef.current != null && mediaRef.current === engineRef.current) return true;
    toast("Φόρτωσε ξανά το track για pitch");
    return false;
  }
  /** Sync toggles the lock: this deck takes the other deck's tempo and beats and keeps following it (lockTick). */
  function syncDeck() {
    if (getMixer().syncLock === deck) { setSyncLock(null); return; }
    if (!pitchEngineReady()) return;
    if (getMixSession().status !== "idle") { toast("Sync: δεν γίνεται όσο τρέχει αυτόματο mix."); return; }
    const other: DeckId = deck === "A" ? "B" : "A";
    const own = syncSourceOf(deck);
    const ref = syncSourceOf(other);
    if (!own || !ref) { toast("Sync: το άλλο deck είναι άδειο."); return; }
    const result = planSync(own, ref);
    if (!result.ok) { toast(result.reason === "no-bpm" ? "Sync: λείπει το BPM σε ένα από τα decks." : "Sync: το tempo είναι εκτός εύρους pitch."); return; }
    setDeckRangePitch(deck, result.plan.range, result.plan.pitch);
    lockRef.current = { step: newLock(), refTrack: deckTransportOf(other)?.trackId ?? null, ownTrack: deckTransportOf(deck)?.trackId ?? null,
      pitch: result.plan.pitch, rate: null, tempo: null, snapUntil: performance.now() + 1000, hand: false, fold: result.fold, ownBpm: own.bpm, refBpm: ref.bpm };
    setSyncFold(result.fold);
    setSyncLock(deck);
    lockTick();
  }
  /**
   * One step of the Sync lock, every 100 ms and on this deck's own starts and seeks. Lets go when the lock cannot go on;
   * keeps the fader on the other deck's tempo; and, while both decks play on the engine with grids that fit, holds the
   * beats together (lockStep decides how). `snapUntil`: this deck's own transport just moved it, so it lands on the
   * beat. `hand`: the DJ moved it by hand since the last hold (bend, scrub), so where it is now is what the lock keeps.
   */
  function lockTick() {
    const st = lockRef.current;
    if (!st || getMixer().syncLock !== deck) return;
    const other: DeckId = deck === "A" ? "B" : "A";
    const mine = deckTransportOf(deck), theirs = deckTransportOf(other);
    // A mix session plans its own starts and rates; another track on the other deck must not pull this one to its tempo.
    if (getMixSession().status !== "idle" || !twoDeckRef.current || !mine || mine.trackId === null || !theirs || theirs.trackId !== st.refTrack) { setSyncLock(null); return; }
    if (mine.trackId !== st.ownTrack) { // another track on this deck: the lock stays, what it knew about the old one goes
      st.ownTrack = mine.trackId; st.step = newLock(); st.rate = st.tempo = null; st.hand = false; st.fold = null;
    }
    const bothReady = mine.ready && theirs.ready;
    if (mine.ready && !mine.onEngine) { setSyncLock(null); return; } // an element deck is pinned at 1x
    const own = syncSourceOf(deck), ref = syncSourceOf(other);
    if (!own || !ref) return;
    forgetOnBpmChange(st, own, ref); // a ×½ / ×2 on either deck: plan the fold again
    const result = planSync(own, ref, st.fold);
    if (!result.ok) {
      if (!bothReady) return; // still loading: the BPM may not be known yet
      setSyncLock(null);
      toast(result.reason === "no-bpm" ? "Sync: λείπει το BPM σε ένα από τα decks." : "Sync: το tempo είναι εκτός εύρους pitch.");
      return;
    }
    if (st.fold === null) { st.fold = result.fold; setSyncFold(result.fold); }
    const fold = result.fold;
    const now = performance.now();
    let fx = getMixer().fx;
    if (fx[deck].range !== result.plan.range || Math.abs(fx[deck].pitch - result.plan.pitch) > 1e-4) {
      setDeckRangePitch(deck, result.plan.range, result.plan.pitch);
      fx = getMixer().fx;
    }
    st.pitch = fx[deck].pitch;
    const engine = mine.engine, clock = playbackContext();
    if (!bothReady || !engine || !mine.onEngine || !clock) return;
    // An element deck can be followed in tempo, not in beats.
    const refEngine = theirs.onEngine ? theirs.engine : null;
    // Both playheads are read at one audio-clock time: this deck's pending start or landing, else now.
    const at = engine.startsAt ?? clock.currentTime;
    const refStarts = refEngine?.startsAt ?? null;
    if (refStarts !== null && refStarts > at) return; // the other deck is mid-start: its position at `at` is not known yet
    const ownPos = engine.positionAt(at), refPos = refEngine ? refEngine.positionAt(at) : 0;
    const refRate = refEngine ? refEngine.playbackRate : 1;
    const refBend = refEngine ? refRate / faderRate(fx[other]) : 1;
    if (fx[deck].bend.dir !== 0) st.hand = true;
    const step = lockStep(st.step, {
      at,
      own: { grid: mine.grid, position: ownPos, rate: engine.playbackRate },
      ref: { grid: theirs.grid, position: refPos, rate: refRate },
      expected: faderRate(fx[deck]) * refBend,
      canHold: refEngine !== null && mine.playing && theirs.playing && fx[deck].bend.dir === 0
        // Quantize: a loop of whole beats (on either deck) keeps its beat phase, so the beats are held through it.
        && (engine.loop === null || (getPref("quantize") && mine.grid != null && loopKeepsBeats(mine.grid, engine.loop, fold)))
        && (refEngine.loop === null || (getPref("quantize") && theirs.grid != null && loopOnBeats(theirs.grid, refEngine.loop)))
        && gridFits(mine.grid, mine.bpm) && gridFits(theirs.grid, theirs.bpm) && ownPos < mine.duration - 0.05 && refPos < theirs.duration - 0.05,
      snap: now < st.snapUntil,
      hand: st.hand,
      fold,
      loop: engine.loop !== null,
    });
    st.step = step.state;
    st.rate = step.rate;
    st.tempo = step.base === null ? null : step.base / refBend;
    if (step.rate === null) { engine.playbackRate = deckRate(fx[deck], now); return; }
    st.snapUntil = 0; st.hand = false; // a step that held has used them
    engine.playbackRate = step.rate;
    if (!step.snap || !refEngine || !mine.grid) return;
    // The new rate is in the engine before the landing time is read, so tempo and position land together.
    const lands = engine.landsAt();
    const before = engine.positionAt(lands);
    const shift = phaseShift({ grid: mine.grid, position: before }, { grid: theirs.grid, position: refEngine.positionAt(lands) }, step.state.offset, fold);
    // Back past the start of the track is not possible: the same beat one later is.
    if (shift !== null && !engine.nudge(shift) && shift < 0) engine.nudge(shift + shiftByBeats(mine.grid, before + shift, 1 / ownCount(fold)));
    // What the lock remembers must be what the engine now does, or the next step reads this shift as a new jump.
    st.step = { ...st.step, at: lands, ownPos: engine.positionAt(lands), refPos: refEngine.positionAt(lands), ownRate: engine.playbackRate, refRate };
  }
  /** The lock is gone: keep playing at the tempo it was holding (written into the fader, so nothing steps), unless the
   * DJ's own fader move let it go. A mix session plans from the fader's rate, so it gets exactly that back. */
  function endLock() {
    const st = lockRef.current;
    lockRef.current = null;
    const engine = engineRef.current;
    if (!st || !engine || mediaRef.current !== engine) return;
    const fx = getMixer().fx[deck];
    if (getMixSession().status === "idle" && st.tempo !== null && fx.pitch === st.pitch && Math.abs(st.tempo / faderRate(fx) - 1) > 0.001) {
      const plan = planRate(fx, st.tempo);
      if (plan) setDeckRangePitch(deck, plan.range, plan.pitch);
    }
    engine.playbackRate = deckRate(getMixer().fx[deck], performance.now());
  }
  function cycleDeckRange() {
    if (!pitchEngineReady()) return;
    if (getMixer().syncLock === deck) { endLock(); setSyncLock(null); } // the DJ took the pitch back: first the held tempo goes into the fader
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
  // Sync lock: step it while this deck is the locked one, and at once when the deck's own transport moves it (a shift
  // issued inside the engine's lead replaces the pending start, so a start or a cue lands on the beat unheard).
  useEffect(() => {
    if (!locked) return;
    const m = mediaRef.current;
    const moved = () => { const st = lockRef.current; if (st && !st.hand) st.snapUntil = performance.now() + 1000; lockTick(); };
    m?.addEventListener("playing", moved);
    m?.addEventListener("seeked", moved);
    const timer = setInterval(lockTick, 100);
    // A mix session reads the deck's rate when it arms: let go the moment one starts, before its next step.
    const offMix = subscribeMix(() => { if (getMixSession().status !== "idle" && getMixer().syncLock === deck) { endLock(); setSyncLock(null); } });
    return () => {
      clearInterval(timer);
      offMix();
      m?.removeEventListener("playing", moved);
      m?.removeEventListener("seeked", moved);
      if (getMixer().syncLock !== deck) endLock();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked, media, deck]);
  useEffect(() => () => { if (getMixer().syncLock === deck) setSyncLock(null); }, [deck]);

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

  /** Quantize («Q», two decks): this deck's grid when the switch is on and Sync would trust the grid; else null. */
  function quantGrid() {
    return twoDeckRef.current && getPref("quantize") ? quantizeGrid(gridRef.current, deckBpmRef.current) : null;
  }
  /** A jump to a stored cue (pads, keys, controller). Quantize on a playing deck keeps the beat phase (lib/quantize.ts). */
  function jumpToCue(seconds: number) {
    const a = mediaRef.current, engine = engineRef.current, g = quantGrid();
    if (!a || a.paused || !g) { seekTo(seconds); return; }
    // The engine's seek takes effect a moment ahead: the phase to keep is the playhead's at that moment.
    seekTo(cueJump(g, engine && a === engine ? engine.positionAt(engine.landsAt()) : a.currentTime, seconds, a.duration));
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
    const g = quantGrid();
    const positionMs = Math.round(((g ? snapToBeat(g, a.currentTime, a.duration) : null) ?? a.currentTime) * 1000);
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
      if (padIndex !== null && !e.shiftKey && cuePadKeysEnabled()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (transportOwnerOf(deck)) return;
        if (e.repeat) return;
        const cue = cueState.cues.find(cue => cue.id === padLayout.slots[padIndex]);
        const ghost = cue ? null : padGhostsRef.current[padIndex];
        if (cue) jumpToCue(cue.position_ms / 1000);
        else if (ghost) jumpToCue(Math.round(ghost.time_s * 1000) / 1000); // a suggested cue: seek only, as a click
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
        if (transportOwnerOf(deck)) return;
        if (e.repeat || e.shiftKey) return;
        if (cueMachine.latch()) return;
        if (a.paused) { processing.prepare(); a.play().catch(() => {}); }
        else a.pause();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (transportOwnerOf(deck)) return;
        seekTo(Math.min(a.duration || 0, a.currentTime + (e.shiftKey ? 30 : 5)));
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (transportOwnerOf(deck)) return;
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
        setError(engineRef.current?.error instanceof JunkBeforeAudioError ? engineRef.current.error.message : "Δεν φορτώθηκε audio — μη υποστηριζόμενο format ή μη διαθέσιμο αρχείο.");
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
    "@container/player flex items-center justify-center gap-2 border-t border-cm-contrast/8 bg-cm-bg-2/35 dark:bg-cm-bg-2/50 py-2 backdrop-blur-xl";
  // Two decks: the inner top corner rounds off beside the mixer, and the deck badge sits in that wider inner gutter.
  const frame = !twoDeck ? "px-3 md:px-6"
    // The outer edges are inset alike (the pads start 25 px down, under the dock's collapse button in deck B's corner).
    : mirrored ? "rounded-tl-xl border-l pl-7 pr-4"
    : "rounded-tr-xl border-r pr-7 pl-4";

  const isTall = dockHeight >= 90;
  const isDeck = dockHeight >= 120;
  // Single deck with the fast rating on: the artwork gives up 32 px for the two meters under the title.
  const artSize = deckRating ? Math.min(96, Math.max(40, dockHeight - 90)) : Math.min(96, Math.max(54, dockHeight - 58));
  // Two decks: 150px at the default height; a shorter dock keeps room under it for the title and the artist.
  const coverSize = Math.min(150, Math.max(64, dockHeight - 60));

  // A track dragged over the deck: where it lands, or a warning when the deck is playing.
  const dropOverlay = trackDrop.over && (
    <div aria-hidden className={cn("pointer-events-none absolute inset-1 z-40 grid place-items-center rounded-xl border-2 border-dashed",
      playing ? "border-cm-rose/70 bg-cm-rose/10" : deck === "A" ? "border-cm-deck-a/70 bg-cm-deck-a/10" : "border-cm-deck-b/70 bg-cm-deck-b/10")}>
      <span className="glass-strong rounded-lg px-3 py-1.5 text-xs font-medium text-cm-text">
        {playing ? `Το Deck ${deck} παίζει — δεν θα φορτωθεί` : `Άφησε για φόρτωση στο Deck ${deck}`}
      </span>
    </div>
  );

  // Idle dock — always present so the cockpit feels alive and content never jumps.
  if (!current) {
    return (
      <div
        {...trackDrop.handlers}
        style={{ height: `${dockHeight}px` }}
        className={cn(dockBase, frame, "relative h-full", isTall ? "px-6" : "px-5")}
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
          {deck === "B" ? "Deck B άδειο — σύρε εδώ ένα track ή φόρτωσε (Load 2)." : "Σύρε εδώ ένα track ή διάλεξε track για ακρόαση."}
        </span>
        {dropOverlay}
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
  const deckBpmText = deckBpm != null ? (onEngine ? rateBpmText(deckBpm, faderRate(fx)) : `${deckBpm.toFixed(0)} BPM`) : "— BPM";
  const errorBadge = (
            <span role="alert" className="inline-flex items-center gap-1 font-mono text-[11px] text-cm-rose" title={error ?? undefined}>
              <TriangleAlert aria-hidden="true" className="h-3.5 w-3.5" />
              <span aria-hidden="true" className="hidden @lg/player:inline">μη διαθέσιμο</span>
              <span className="sr-only">{error}</span>
            </span>
  );
  // One deck only: two decks show BPM and key in the facts row and keep just the error or loading sign (`deckStatus`).
  const bpmKey = (
          error ? errorBadge : (
            <div aria-busy={loading} className="relative flex flex-wrap items-center justify-center gap-1 rounded-md border border-cm-contrast/10 bg-cm-contrast/5 px-2 py-1 font-mono text-xs tabular-nums shadow-xs">
              {loading && <span role="status" aria-label="Φόρτωση ήχου" className="absolute -bottom-2 left-1/2 h-1 w-6 -translate-x-1/2 rounded-full bg-cm-cyan motion-safe:animate-pulse" />}
              <span style={{color: bpmColor(bpm)}} title={bpmDescription(current)} className="font-medium text-cm-cyan">
                {deckBpmText}
              </span>
              <span className="text-cm-faint/60">·</span>
              <span style={{ color: keyColor(current.key_text, fallbackKey(current)) }} className="font-medium text-cm-chartreuse">
                <KeyLabel track={current} format={keyFormat} />
              </span>
              <BpmOctaveButtons track={current} compact />
            </div>
          )
  );
  const deckStatus = error ? errorBadge
    : loading ? <span role="status" aria-label="Φόρτωση ήχου" className="h-1 w-6 rounded-full bg-cm-cyan motion-safe:animate-pulse" /> : null;
  // Two-deck: the pads sit on the outer edge (the other columns set their own order).
  const order = !twoDeck ? { pads: "", wave: "", time: "", info: "" }
    : { pads: mirrored ? "order-4" : "order-1", wave: "", time: "", info: "" };

  const playButton = (
    <button data-playback-toggle type="button" onClick={toggle} disabled={!!error}
      title="Αναπαραγωγή / Παύση (Space)" aria-label={playing ? "Παύση" : "Αναπαραγωγή"}
      className={cn("flex size-10 shrink-0 items-center justify-center rounded-full border outline-none @max-[215px]/deckinfo:size-9 transition-[color,background-color,border-color,scale] duration-150 ease-out hover:bg-[color-mix(in_oklch,var(--deck)_15%,transparent)] focus-visible:ring-2 focus-visible:ring-cm-cyan disabled:opacity-40 motion-safe:active:scale-[0.96]",
        // Lit in the deck colour while playing, like a hardware transport button (only rendered with two decks).
        playing && !error ? (deck === "A" ? "border-cm-deck-a/50 bg-cm-deck-a/15 text-cm-deck-a" : "border-cm-deck-b/50 bg-cm-deck-b/15 text-cm-deck-b") : "border-cm-line/30 bg-cm-contrast/10 text-cm-text")}>
      {playing ? <Pause className="size-4" /> : <Play className="ml-0.5 size-4" />}
    </button>
  );
  // Sync sits with the transport, lit in the deck colour while this deck is locked to the other one (the controller's LED does the same).
  const syncNote = locked ? foldNote(syncFold) : null;
  const syncButton = (
    <button type="button" disabled={!onEngine} onClick={syncDeck} aria-label={`Sync Deck ${deck}${syncNote ? ` ${syncNote.label}` : ""}`} aria-pressed={locked}
      title={!onEngine ? "Φόρτωσε ξανά το track για Sync" : syncNote ? syncNote.title : "Sync: κλειδώνει tempo και beats στο άλλο deck. Ξαναπάτα για να το αφήσεις."}
      className={cn("flex h-8 shrink-0 items-center rounded-lg border px-2.5 font-mono text-[11px] font-semibold tracking-[0.06em] outline-none @max-[260px]/deckinfo:px-2 @max-[215px]/deckinfo:px-1.5 transition-[color,background-color,border-color,scale] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-cm-cyan disabled:opacity-40 motion-safe:enabled:active:scale-[0.96]",
        locked ? "border-[color-mix(in_oklch,var(--deck)_60%,transparent)] bg-[color-mix(in_oklch,var(--deck)_24%,transparent)] text-[var(--deck)]"
          : "border-cm-line/30 bg-cm-contrast/8 text-cm-text/85 enabled:hover:border-cm-line/50 enabled:hover:text-cm-text")}>
      SYNC{syncNote && <span className="ml-1">{syncNote.label}</span>}
    </button>
  );
  // Two-deck panel: this deck's scrolling lane goes into its lane of the shared screen.
  const lanePortal = twoDeck && view.wave && view.mode === "full" && createPortal(
    <DeckScrollWaveform className="absolute inset-0" edge={deck === "A" ? "top" : "bottom"} trackId={current.id} revision={current.modified_time} bpm={bpm ?? null}
      grid={grid} cues={cueState.cues} cueSlots={padLayout.slots} drawRef={deckDrawRef} onScrub={jogBy} onScrubHold={jogHold} onSeek={seekTo} durationS={current.duration}
      getPlayback={() => {
        const a = mediaRef.current;
        if (!a || !hasCurrentSource(a)) return null;
        const rate = a.playbackRate || 1;
        const position = jogRef.current?.target
          ?? displayPosition(a.currentTime, COMPENSATE_OUTPUT_LATENCY ? playbackContext()?.outputLatency ?? 0 : 0, rate);
        return { position, rate, cueing: a.paused || jogRef.current != null };
      }} />, view.wave);
  // This deck's half of the facts row under the lanes (numbers over its overview), into its own slot: a sibling of the lane's portal.
  // A seek out of a loop ends it inside the engine and a rescued deck gets its loop back there, so the chip asks the engine.
  const factsPortal = twoDeck && view.facts && createPortal(
    <DeckFacts deck={deck} mirrored={mirrored} track={current} time={time} duration={duration} grid={grid} keyFormat={keyFormat} compact={view.mode === "compact"} menu={deckMenu.menu}
      tempo={deckBpm != null ? deckBpm * (onEngine ? faderRate(fx) : 1) : null} pitch={onEngine ? formatPitchPercent(faderRate(fx)) : null}
      loop={{ beats: loopBeats, on: engineRef.current?.loop != null }}>
      <DeckOverview deck={deck} track={current} time={time} duration={duration} progress={duration > 0 ? time / duration : 0} className="h-[26px] w-full shrink-0"
        drawRef={waveDrawRef} playheadRef={playheadRef} canSeek={canSeek} onSeek={seekTo} onCueSeek={jumpToCue} cues={cueState.cues} cueSlots={padLayout.slots} grid={grid} />
    </DeckFacts>, view.facts);

  function toggle() {
    const a = mediaRef.current;
    if (!a || cueMachine.latch()) return;
    if (a.paused) { processing.prepare(); a.play().catch(() => {}); }
    else a.pause();
  }

  return (
    <>
    {lanePortal}
    {factsPortal}
    <div
      {...trackDrop.handlers}
      // --deck carries the deck colour to the pitch strip and its fader (inherited, static).
      style={{ height: `${dockHeight}px`, ...(twoDeck ? { "--deck": deck === "A" ? "var(--cm-deck-a)" : "var(--cm-deck-b)" } : {}) } as CSSProperties}
      className={cn(
        dockBase,
        frame,
        "relative h-full",
        // Two decks: the electric edge marks the playing deck (isolate keeps its glow behind the deck's content).
        twoDeck ? "isolate" : playing && !error && "border-cm-cyan/20",
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
      {twoDeck && <DeckElectricEdge deck={deck} active={playing && !error} />}
      {dropOverlay}
      {/* Two decks: the deck letter (lit while playing) above eject, in the inner gutter beside the mixer. One deck: eject alone, top corner. */}
      <div className={cn("absolute z-30 flex items-center gap-1", twoDeck ? cn("top-2 flex-col", mirrored ? "left-1" : "right-1") : cn("top-1", mirrored ? "right-2" : "left-2"))}>
        {twoDeck && (
          <span className={cn("flex size-5 items-center justify-center rounded-md font-mono text-[10px] font-semibold ring-1 ring-inset transition-colors duration-200",
            playing && !error ? (deck === "A" ? "bg-cm-deck-a/20 text-cm-deck-a ring-cm-deck-a/45" : "bg-cm-deck-b/20 text-cm-deck-b ring-cm-deck-b/45") : "bg-cm-line/5 text-cm-muted ring-cm-line/15")}>{deck}</span>
        )}
        <button type="button" onClick={() => eject(deck)} aria-label={`Αφαίρεση track από το Deck ${deck}`} title="Αφαίρεση track"
          className="flex size-5 items-center justify-center rounded-md text-cm-muted transition motion-safe:active:scale-95 duration-100 ease-out hover:bg-cm-cyan/10 hover:text-cm-cyan focus-visible:outline-2 focus-visible:outline-cm-cyan cursor-pointer">
          <Eject className="size-3.5" />
        </button>
      </div>

      <div data-player-layout className={cn("mx-auto flex h-full w-full max-w-[1800px] min-w-0", twoDeck ? "items-stretch gap-3" : "items-center gap-2 md:gap-3 lg:gap-4", mirrored && !twoDeck && "flex-row-reverse", twoDeck && (mirrored ? "justify-start" : "justify-end"))}>
      {!twoDeck && <>
      <ActionContextMenu pick={pickDeck} menu={deckMenu.menu}>
      <div className={cn("flex w-[116px] shrink-0 flex-col items-center gap-2 @max-4xl/player:w-[80px]", order.info)}>
        <div style={{ width: `${artSize}px`, height: `${artSize}px` }} className="relative max-w-full shrink-0 overflow-hidden rounded-xl border border-cm-line/20 shadow-lg">
          <Artwork seed={current.id} trackId={current.id} className="h-full w-full object-cover" />
          <button data-playback-toggle type="button" onClick={toggle} disabled={!!error}
            title="Αναπαραγωγή / Παύση (Space)" aria-label={playing ? "Παύση" : "Αναπαραγωγή"}
            className="group absolute inset-0 flex items-center justify-center bg-black/10 text-white outline-none transition hover:bg-black/25 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cm-cyan disabled:opacity-40">
            <span className="flex size-10 items-center justify-center rounded-full motion-safe:group-active:scale-95 transition-transform duration-100 ease-out border border-white/45 bg-cm-contrast/15 shadow-lg backdrop-blur-md">
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
        <DeckRatingStrip deck={deck} withStatus={false} className="w-full" />
      </div>
      </ActionContextMenu>

      {/* Audio envelope scrubber: the canvas is pointer-events-none;
          the invisible range input on top does the real seeking — invariant preserved.
          Keep its reference proportions within the compact dock. */}
      <ActionContextMenu pick={pickDeck} menu={deckMenu.menu}>
      <div data-player-waveform className={cn("relative h-full max-h-[130px] min-h-0 min-w-8 max-w-[800px] flex-[1_1_800px] self-center", order.wave)}>
        <TrackWaveform
          spectral
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
          onSeek={(positionMs) => jumpToCue(positionMs / 1000)}
        />
        <input
          data-playback-shortcuts
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={time}
          onChange={(e) => seekTo(Number(e.target.value))}
          onMouseDown={(e) => { if (e.ctrlKey) e.preventDefault(); }}
          className="cm-overview-seek absolute inset-0 z-20 h-full w-full cursor-pointer opacity-0"
          aria-label="Μετακίνηση στο track"
        />
        <OverviewHover grid={grid} time={time} duration={duration} trackId={current.id} canSeek={canSeek} />
      </div>
      </ActionContextMenu>

      {/* The time left leads (rose in the last 30 s); elapsed / total under it. */}
      <ActionContextMenu pick={pickDeck} menu={deckMenu.menu}>
      <div role="group" aria-label="Χρόνος αναπαραγωγής" className={cn("relative min-h-0 w-20 shrink-0 self-stretch font-mono text-[10px] tabular-nums", order.time)}>
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 whitespace-nowrap text-center">
          <span className="sr-only">Υπόλοιπο χρόνου </span><span className={cn("block text-base font-bold leading-none", lastSeconds(duration, time) ? "text-cm-rose" : "text-cm-text")}>{timeLeftText(duration, time)}</span>
          <div className="mt-1.5 text-cm-muted">
            <span className="sr-only">Τρέχων χρόνος </span>{fmt(time)}<span aria-hidden> / </span><span className="sr-only"> Συνολική διάρκεια </span>{fmt(duration)}
          </div>
        </div>
      </div>
      </ActionContextMenu>
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
      {/* Two-deck, outer edge -> mixer: pads, info column (time left, elapsed, play, Sync, FX), cover with title and artist, pitch fader. All share the dock's top and bottom edges. BPM, key and the overview are in the facts row under the lanes. */}
      {twoDeck && <DeckHeader deck={deck} mirrored={mirrored} playing={playing && !error} track={current}
        time={time} duration={duration} coverSize={coverSize}
        transport={<>{playButton}{syncButton}</>} status={deckStatus} rating={<DeckRatingStrip deck={deck} mirrored={mirrored} />} menu={deckMenu.menu} />}
      {twoDeck && <PitchStrip deck={deck} fx={fx} active={onEngine} className={cn(mirrored ? "order-1" : "order-4", deckRule(mirrored ? "right" : "left"))} />}
      {/* The pads take the width the other columns leave (120-380 px), inset 25px from the dock's top and bottom; their block keeps a pad no taller than 1.5x its width. */}
      <div className={cn(twoDeck ? "flex h-full min-h-0 min-w-[120px] max-w-[380px] flex-[1_1_0%] items-center py-[25px]" : "contents", twoDeck && deckRule(mirrored ? "left" : "right"), order.pads)}>
      <CuePads key={current.id} className={cn(twoDeck && "aspect-[4/3] h-auto max-h-full min-w-0 max-w-none flex-[1_1_0%]")} trackId={current.id} state={cueState} slots={padLayout.slots} compact={twoDeck}
        canCapture={canCapture} canSeek={canSeek} onCapture={captureCue}
        onSeek={positionMs => jumpToCue(positionMs / 1000)} onAssign={padLayout.assign}
        onCreate={async slot => { const cue = await captureCue("cue"); if (cue) padLayout.assign(slot, cue.id); }}
        ghosts={padGhosts} onKeep={slot => padKeep(padIo(), slot)}
        padKeys={() => !!mediaRef.current && ownsPlaybackKeys(mediaRef.current, primary) && cuePadKeysEnabled() && !transportOwnerOf(deck)} />
      </div>
      </div>
    </div>
    {deckMenu.dialogs}
    </>
  );
}
