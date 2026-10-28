export interface PlaybackLoudness {
  status: "ready" | "silent" | "unavailable";
  gain_db: number;
  integrated_lufs: number | null;
  true_peak_dbfs: number | null;
  target_lufs: number;
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

export async function fetchPlaybackLoudness(trackId: number, signal: AbortSignal): Promise<PlaybackLoudness> {
  for (let attempt = 0; attempt < 90; attempt++) {
    const response = await fetch(`/api/tracks/${trackId}/playback-loudness`, { signal });
    if (response.status === 503) { await wait(2000, signal); continue; }
    if (!response.ok) throw new Error("Loudness unavailable");
    const value = await response.json();
    if (!["ready", "silent", "unavailable"].includes(value.status) ||
      typeof value.gain_db !== "number" || !Number.isFinite(value.gain_db) || value.gain_db > 12 ||
      (value.status !== "ready" && value.gain_db !== 0)) throw new Error("Invalid loudness response");
    return value;
  }
  throw new Error("Loudness measurement busy");
}
