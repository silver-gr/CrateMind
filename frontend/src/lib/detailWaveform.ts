import { api } from "./api";

/** CMWD v2: linear RMS/peak on a shared scale, plus independently analysed frequency RGB. */
export interface DetailWaveform {
  version: number;
  sampleRate: number;
  hop: number;
  win: number;
  frames: number;
  duration: number;
  digestHex: string;
  rms: Uint8Array;
  peak: Uint8Array;
  red: Uint8Array;
  green: Uint8Array;
  blue: Uint8Array;
}

const HEADER = 48;
const MAX_BYTES = 64 * 1024 * 1024;

export function parseDetailWaveform(buf: ArrayBuffer): DetailWaveform {
  if (buf.byteLength < HEADER || buf.byteLength > MAX_BYTES) throw new Error("detail waveform: bad size");
  const v = new DataView(buf);
  const bytes = new Uint8Array(buf);
  if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== "CMWD") throw new Error("detail waveform: bad magic");
  const version = v.getUint16(4, true);
  if (version !== 2) throw new Error(`detail waveform: unsupported version ${version}`);
  const frames = v.getUint32(20, true);
  if (buf.byteLength !== HEADER + 5 * frames) throw new Error("detail waveform: length mismatch");
  const sampleRate = v.getUint32(8, true), hop = v.getUint32(12, true), win = v.getUint32(16, true);
  const duration = v.getFloat64(24, true);
  if (!frames || !sampleRate || !hop || !win || !Number.isFinite(duration) || duration <= 0) {
    throw new Error("detail waveform: invalid timing");
  }
  const band = (i: number) => bytes.subarray(HEADER + i * frames, HEADER + (i + 1) * frames);
  return {
    version,
    sampleRate, hop, win,
    frames,
    duration,
    digestHex: Array.from(bytes.subarray(32, 48), b => b.toString(16).padStart(2, "0")).join(""),
    rms: band(0), peak: band(1), red: band(2), green: band(3), blue: band(4),
  };
}

/** Centre time of frame `i`, in seconds. */
export const frameTime = (w: Pick<DetailWaveform, "sampleRate" | "hop" | "win">, i: number) => (i * w.hop + w.win / 2) / w.sampleRate;

// --- client cache: LRU keyed by track id, validated by modified_time and the ETag (304 reuses the buffer) ---

interface Entry { revision: number; etag: string | null; data: DetailWaveform }
interface Flight { promise: Promise<DetailWaveform>; controller: AbortController; refs: number }

const CACHE_LIMIT = 16;
const cache = new Map<number, Entry>();
const flights = new Map<string, Flight>();

function remember(id: number, entry: Entry) {
  cache.delete(id);
  cache.set(id, entry);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

async function fetchDetail(id: number, revision: number, signal: AbortSignal): Promise<DetailWaveform> {
  const hit = cache.get(id);
  if (hit && hit.revision === revision) { remember(id, hit); return hit.data; }
  const result = await api.getWaveformDetail(id, { etag: hit?.etag ?? null, signal });
  if (result.status === 304 && hit) { remember(id, { ...hit, revision }); return hit.data; }
  if (result.status !== 200) throw new Error("detail waveform: unexpected 304");
  const data = parseDetailWaveform(result.data);
  remember(id, { revision, etag: result.etag, data });
  return data;
}

/**
 * Starts (or joins) the load of a track's detail waveform. Every caller holds a reference; the request is
 * aborted once the last holder releases it before it finished (stale prefetch after a track change).
 */
export function acquireDetailWaveform(id: number, revision: number | null | undefined): { promise: Promise<DetailWaveform>; release: () => void } {
  const rev = revision ?? 0;
  const key = `${id}:${rev}`;
  let flight = flights.get(key);
  if (!flight) {
    const controller = new AbortController();
    const created: Flight = { controller, refs: 0, promise: fetchDetail(id, rev, controller.signal).finally(() => { if (flights.get(key) === created) flights.delete(key); }) };
    created.promise.catch(() => {});
    flights.set(key, created);
    flight = created;
  }
  flight.refs += 1;
  const held = flight;
  let released = false;
  return {
    promise: held.promise,
    release: () => {
      if (released) return;
      released = true;
      held.refs -= 1;
      if (held.refs <= 0 && flights.get(key) === held) { flights.delete(key); held.controller.abort(); }
    },
  };
}
