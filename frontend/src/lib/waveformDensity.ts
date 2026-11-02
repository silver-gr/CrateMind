import { api } from "./api";

export const DENSITY_WIDTH = 2048;
export const DENSITY_MIN_PPS = 16;
export const DENSITY_MAX_PPS = 8192;
export const DENSITY_MAX_HEIGHT = 1024;
const HEADER = 56;

export interface DensityGeometry {
  tileIndex: number;
  pixelsPerSecond: number;
  height: number;
  dpr: number;
}

export interface DensityTile {
  width: number;
  height: number;
  startSeconds: number;
  pixelsPerSecond: number;
  dpr: number;
  digestHex: string;
  alpha: Uint8Array;
}

export interface DensityRequest extends DensityGeometry {
  key: string;
  trackId: number;
  detailDigest: string;
  visible: boolean;
}

export function parseDensityTile(buffer: ArrayBuffer, expected: DensityGeometry): DensityTile {
  if (buffer.byteLength < HEADER || buffer.byteLength > HEADER + DENSITY_WIDTH * DENSITY_MAX_HEIGHT) throw new Error("density: bad size");
  const view = new DataView(buffer), bytes = new Uint8Array(buffer);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== "CMDN" || view.getUint16(4, true) !== 1 || view.getUint16(6, true) !== 0) throw new Error("density: unsupported header");
  const width = view.getUint32(8, true), height = view.getUint32(12, true);
  const startSeconds = view.getFloat64(16, true), pixelsPerSecond = view.getFloat64(24, true), dpr = view.getFloat64(32, true);
  if (width !== DENSITY_WIDTH || height < 2 || height > DENSITY_MAX_HEIGHT || buffer.byteLength !== HEADER + width * height) throw new Error("density: length mismatch");
  if (![startSeconds, pixelsPerSecond, dpr].every(Number.isFinite)
    || startSeconds < 0 || pixelsPerSecond < DENSITY_MIN_PPS || pixelsPerSecond > DENSITY_MAX_PPS || dpr < .5 || dpr > 8
    || height !== expected.height || pixelsPerSecond !== expected.pixelsPerSecond || dpr !== expected.dpr
    || Math.abs(startSeconds - expected.tileIndex * DENSITY_WIDTH / expected.pixelsPerSecond) > 1e-8) throw new Error("density: geometry mismatch");
  return { width, height, startSeconds, pixelsPerSecond, dpr,
    digestHex: Array.from(bytes.subarray(40, 56), b => b.toString(16).padStart(2, "0")).join(""), alpha: bytes.subarray(HEADER) };
}

async function fetchTile(request: DensityRequest, signal: AbortSignal): Promise<DensityTile> {
  const result = await api.getWaveformDensity(request.trackId, request, signal);
  if (result.status !== 200) throw new Error("density: missing response");
  return parseDensityTile(result.data, request);
}

interface Failure { attempts: number; retryAt: number }
interface Flight { request: DensityRequest; controller: AbortController }

/** One outstanding request per deck, ordered visible-first by the caller. No work in rAF beyond update(). */
export class DensityTileQueue {
  private wanted = new Map<string, DensityRequest>();
  private failures = new Map<string, Failure>();
  private active: Flight | null = null;
  private cancelRetry: (() => void) | undefined;
  private readonly fetch: typeof fetchTile;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;

  constructor(private readonly options: {
    onTile: (request: DensityRequest, tile: DensityTile) => void;
    onChange: () => void;
    fetch?: typeof fetchTile;
    now?: () => number;
    schedule?: (fn: () => void, ms: number) => () => void;
  }) {
    this.fetch = options.fetch ?? fetchTile;
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? ((fn, ms) => { const id = setTimeout(fn, ms); return () => clearTimeout(id); });
  }

  update(requests: DensityRequest[]): void {
    this.wanted = new Map(requests.map(request => [request.key, request]));
    for (const key of this.failures.keys()) if (!this.wanted.has(key)) this.failures.delete(key);
    const visiblePending = requests.some(request => request.visible && (this.failures.get(request.key)?.attempts ?? 0) < 5);
    if (this.active && (!this.wanted.has(this.active.request.key)
      || (visiblePending && !this.wanted.get(this.active.request.key)?.visible))) {
      this.active.controller.abort();
      this.active = null;
    }
    this.pump();
  }

  failed(key: string): boolean { return this.failures.has(key); }

  reset(): void {
    this.wanted.clear(); this.failures.clear();
    this.cancelRetry?.(); this.cancelRetry = undefined;
    this.active?.controller.abort(); this.active = null;
  }

  private pump(): void {
    this.cancelRetry?.(); this.cancelRetry = undefined;
    if (this.active) return;
    let earliest = Infinity;
    const visible = [...this.wanted.values()].filter(request => request.visible && (this.failures.get(request.key)?.attempts ?? 0) < 5);
    for (const request of visible.length ? visible : this.wanted.values()) {
      const failure = this.failures.get(request.key);
      if (failure && failure.retryAt > this.now()) { earliest = Math.min(earliest, failure.retryAt); continue; }
      const flight: Flight = { request, controller: new AbortController() };
      this.active = flight;
      void this.fetch(request, flight.controller.signal).then(tile => {
        if (this.active !== flight || !this.wanted.has(request.key)) return;
        this.wanted.delete(request.key); this.failures.delete(request.key);
        this.options.onTile(request, tile);
      }).catch(() => {
        if (this.active !== flight || flight.controller.signal.aborted) return;
        const attempts = (this.failures.get(request.key)?.attempts ?? 0) + 1;
        this.failures.set(request.key, { attempts, retryAt: attempts >= 5 ? Infinity : this.now() + Math.min(5000, 250 * 2 ** (attempts - 1)) });
      }).finally(() => {
        if (this.active !== flight) return;
        this.active = null;
        this.options.onChange();
        this.pump();
      });
      return;
    }
    if (Number.isFinite(earliest)) this.cancelRetry = this.schedule(() => { this.cancelRetry = undefined; this.pump(); this.options.onChange(); }, Math.max(0, earliest - this.now()));
  }
}
