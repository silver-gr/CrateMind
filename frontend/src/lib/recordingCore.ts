// Pure helpers for the set recorder (lib/recorder.ts), kept apart so tests need no audio or API modules.

/** One buffer from the queued blocks, in order. */
export function joinBlocks(blocks: Float32Array[]): Float32Array<ArrayBuffer> {
  let length = 0;
  for (const block of blocks) length += block.length;
  const out = new Float32Array(length);
  let at = 0;
  for (const block of blocks) {
    out.set(block, at);
    at += block.length;
  }
  return out;
}

/** The leading blocks up to about `maxSamples` (at least one block) for one POST, and the rest. */
export function takeBatch(queue: Float32Array[], maxSamples: number): [Float32Array[], Float32Array[]] {
  let take = 0, samples = 0;
  while (take < queue.length && (take === 0 || samples + queue[take].length <= maxSamples)) samples += queue[take++].length;
  return [queue.slice(0, take), queue.slice(take)];
}

/** 0:07, 12:34, 1:02:03 */
export function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60;
  return `${h ? `${h}:${String(m).padStart(2, "0")}` : m}:${String(s).padStart(2, "0")}`;
}

/**
 * Final: a 4xx (the backend stopped at its size or disk limit, lost the session, or refused the chunk).
 * Retried: network errors, timeouts, 5xx, and 409 dataset_busy (maintenance holds the library for a moment).
 */
export function isFatal(error: unknown): boolean {
  if ((error as { code?: unknown } | null)?.code === "dataset_busy") return false;
  const status = Number(/^(\d{3}):/.exec(error instanceof Error ? error.message : "")?.[1]);
  return status >= 400 && status < 500;
}
