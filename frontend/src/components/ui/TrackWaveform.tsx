import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { type WaveformProps } from "./Waveform";
import { AudioWaveform, type AudioEnvelope } from "./AudioWaveform";
import type { MutableRefObject } from "react";

const cache = new Map<string, AudioEnvelope>();
const pending = new Map<string, Promise<AudioEnvelope>>();

const waveformKey = (id: number, sourceRevision?: number | null) => `v2:${id}:${sourceRevision ?? 0}`;
/** Synchronous lookup of an already-loaded envelope (same key/revision as the component). */
export const cachedWaveform = (id: number, sourceRevision?: number | null) => cache.get(waveformKey(id, sourceRevision));

function loadPeaks(id: number, key: string): Promise<AudioEnvelope> {
  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);
  const existing = pending.get(key);
  if (existing) return existing;
  const request = api.getWaveform(id).then(data => {
    if (data.peaks.length) {
      if (cache.size >= 32) cache.delete(cache.keys().next().value!);
      cache.set(key, data);
    }
    return data;
  }).finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}

/** Track audio only: never substitute generated bars for unloaded audio. */
export function TrackWaveform({ trackId, sourceRevision, className, ...props }: Omit<WaveformProps, "seed" | "peaks"> & { trackId: number; sourceRevision?: number | null; drawRef?: MutableRefObject<((progress: number) => void) | null> }) {
  const cacheKey = waveformKey(trackId, sourceRevision);
  const [result, setResult] = useState<{ id: string; peaks: AudioEnvelope } | null>(null);
  const peaks = cache.get(cacheKey) ?? (result?.id === cacheKey ? result.peaks : undefined);
  useEffect(() => {
    let active = true;
    loadPeaks(trackId, cacheKey)
      .then(peaks => { if (active) setResult({ id: cacheKey, peaks }); })
      .catch(() => { if (active) setResult({ id: cacheKey, peaks: { peaks: [] } }); });
    return () => { active = false; };
  }, [trackId, cacheKey]);

  if (peaks?.peaks.length) return <AudioWaveform {...props} data={peaks} className={className} />;

  return (
    <div role="status" aria-live="polite" aria-busy={peaks === undefined}
      className={cn("pointer-events-none flex h-full w-full items-center justify-center gap-2 text-xs text-cm-muted", className)}>
      {peaks === undefined && <span aria-hidden="true" className="h-4 w-4 shrink-0 rounded-full border-2 border-cm-line/20 border-t-cm-cyan motion-safe:animate-spin" />}
      <span>{peaks === undefined ? "Φόρτωση κυματομορφής…" : "Μη διαθέσιμη κυματομορφή"}</span>
    </div>
  );
}
