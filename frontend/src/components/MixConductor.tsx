import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { deckTransportOf } from "../lib/mix/deckTransport";
import { announceMix, runConductor, type Conductor } from "../lib/mix/mixSession";
import { getMixer, setCrossfader, setDeckKeylock, setDeckPitch, setDeckRangePitch } from "../lib/mixer";
import { playbackContext } from "../lib/playbackAudio";
import { usePlayer } from "../lib/player";

/** Headless: drives the «Αναπαραγωγή ως μίξη» session (lib/mix/mixSession.ts) from the app shell, across routes. */
export default function MixConductor() {
  const { slots, load } = usePlayer();
  const slotsRef = useRef(slots);
  const loadRef = useRef(load);
  slotsRef.current = slots;
  loadRef.current = load;
  const conductor = useRef<Conductor | null>(null);

  useEffect(() => {
    const c = runConductor({
      now: () => playbackContext()?.currentTime ?? 0,
      transport: deckTransportOf,
      setTimer: (fn, ms) => { const id = window.setTimeout(fn, ms); return () => window.clearTimeout(id); },
      setDeckRangePitch,
      setDeckPitch,
      getMixer,
      setDeckKeylock,
      setCrossfader,
      slots: () => slotsRef.current,
      load: (deck, track, opts) => loadRef.current(deck, track, opts),
      toast: message => { toast(message); },
      announce: announceMix,
    });
    conductor.current = c;
    return () => { c.dispose(); conductor.current = null; };
  }, []);

  // A load or an eject on either deck is news for the session.
  useEffect(() => { conductor.current?.step(); }, [slots]);

  useEffect(() => (import.meta.env.DEV ? installMixCapture() : undefined), []);
  return null;
}

declare global {
  interface Window { __cratemindCaptureMix?: (seconds: number) => Promise<string> }
}

/**
 * Dev-only QA hook: records both decks' engine outputs (after the automation stage, before the mixer) for `seconds`
 * and returns a WAV blob URL, for the rendered-audio beat check.
 */
function installMixCapture(): () => void {
  window.__cratemindCaptureMix = async (seconds: number) => {
    const ctx = playbackContext();
    if (!ctx) throw new Error("no audio context");
    const dest = ctx.createMediaStreamDestination();
    const outputs = (["A", "B"] as const).map(d => deckTransportOf(d)?.engine?.output).filter((n): n is GainNode => n != null);
    outputs.forEach(n => n.connect(dest));
    const recorder = new MediaRecorder(dest.stream);
    const chunks: Blob[] = [];
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise(resolve => { recorder.onstop = resolve; });
    recorder.start();
    await new Promise(resolve => setTimeout(resolve, seconds * 1000));
    recorder.stop();
    await stopped;
    outputs.forEach(n => n.disconnect(dest));
    const audio = await ctx.decodeAudioData(await new Blob(chunks).arrayBuffer());
    return URL.createObjectURL(encodeWav(audio));
  };
  return () => { delete window.__cratemindCaptureMix; };
}

/** 16-bit PCM WAV. */
function encodeWav(audio: AudioBuffer): Blob {
  const channels = audio.numberOfChannels;
  const frames = audio.length;
  const view = new DataView(new ArrayBuffer(44 + frames * channels * 2));
  const text = (at: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); };
  text(0, "RIFF"); view.setUint32(4, 36 + frames * channels * 2, true); text(8, "WAVE");
  text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, audio.sampleRate, true); view.setUint32(28, audio.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, frames * channels * 2, true);
  const data = Array.from({ length: channels }, (_, c) => audio.getChannelData(c));
  let at = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const x = Math.max(-1, Math.min(1, data[c][i]));
      view.setInt16(at, x < 0 ? x * 0x8000 : x * 0x7fff, true);
      at += 2;
    }
  }
  return new Blob([view], { type: "audio/wav" });
}
