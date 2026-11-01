import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { usePref } from "./prefs";
import { fetchPlaybackLoudness, type PlaybackLoudness } from "./playbackLoudness";
import { configurePlayback, hasPlaybackGraph, playbackProcessingStatus, preparePlayback, resetLimiter } from "./playbackAudio";

export function usePlaybackProcessing(audioRef: RefObject<HTMLAudioElement | null>, trackId: number | null, twoDeck = false) {
  const [autoGain] = usePref("autoGain");
  const [limiterEnabled] = usePref("audioLimiter");
  const [measurement, setMeasurement] = useState<{ trackId: number; result: PlaybackLoudness } | null>(null);
  const [pending, setPending] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [engine, setEngine] = useState({ active: false, limiterReady: false, limiterUnavailable: false });
  const revision = useRef(0);
  const result = measurement?.trackId === trackId ? measurement.result : null;
  const gainDb = autoGain && result?.status === "ready" ? result.gain_db : 0;

  useEffect(() => {
    setUnavailable(false);
    if (!autoGain || trackId === null) { setPending(false); return; }
    const controller = new AbortController();
    let current = true;
    const timeout = setTimeout(() => controller.abort(), 210_000);
    setPending(true);
    void fetchPlaybackLoudness(trackId, controller.signal).then(result => {
      if (current) setMeasurement({ trackId, result });
    }).catch(() => {
      if (current) { setMeasurement(null); setUnavailable(true); }
    }).finally(() => {
      clearTimeout(timeout);
      if (current) setPending(false);
    });
    return () => { current = false; clearTimeout(timeout); controller.abort(); };
  }, [autoGain, trackId]);

  const prepare = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || (!autoGain && !limiterEnabled && !twoDeck && !hasPlaybackGraph(audio))) return;
    const version = ++revision.current;
    // Store the desired config synchronously before gesture-scoped context resume.
    void configurePlayback(audio, { gainDb, limiterEnabled });
    void preparePlayback(audio).then(() => {
      if (version === revision.current) setEngine(playbackProcessingStatus(audio));
    });
  }, [audioRef, autoGain, limiterEnabled, twoDeck, gainDb]);

  useEffect(() => {
    prepare();
    return () => { ++revision.current; };
  }, [prepare, trackId]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const refresh = () => setEngine(playbackProcessingStatus(audio));
    audio.addEventListener("cratemind-processing-change", refresh);
    return () => audio.removeEventListener("cratemind-processing-change", refresh);
  }, [audioRef]);

  function resetSource() {
    const audio = audioRef.current;
    if (!audio) return;
    resetLimiter(audio);
    // A prior track's positive gain must not leak into a newly selected source.
    void configurePlayback(audio, { gainDb, limiterEnabled, immediate: true });
  }

  const parts: string[] = [];
  if (autoGain) {
    if (pending) parts.push("Auto Gain: μέτρηση έντασης…");
    else if (unavailable || result?.status === "unavailable") parts.push("Auto Gain: μη διαθέσιμο για αυτό το track");
    else if (result?.status === "silent") parts.push("Auto Gain: σιωπηλό αρχείο, χωρίς ενίσχυση");
    else if (result && engine.active) parts.push(`Auto Gain: ${gainDb > 0 ? "+" : ""}${gainDb.toFixed(1)} dB`);
  }
  if (limiterEnabled) parts.push(engine.limiterReady ? "Limiter ενεργό" : engine.limiterUnavailable
    ? "Limiter μη διαθέσιμο · η ακρόαση συνεχίζεται χωρίς limiter" : "Limiter: προετοιμασία…");
  if ((autoGain || limiterEnabled) && !engine.active && !pending) parts.push("Πάτησε αναπαραγωγή για ενεργοποίηση ήχου");
  return { prepare, resetSource, enabled: autoGain || limiterEnabled, status: parts.join(" · ") };
}
