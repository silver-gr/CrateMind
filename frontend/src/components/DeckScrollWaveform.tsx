import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { acquireDetailWaveform, type DetailWaveform } from "../lib/detailWaveform";
import { beatsInRange, downbeatAfter, type BeatGrid } from "../lib/beatGrid";
import { useDownbeat } from "../lib/trackDownbeat";
import { clampZoom, evictLru, renderDensityTileRGBA, tileBytes, tileDensity, tileDest, tileSeconds, tilesNeeded, viewPxPerSec, zoomByWheel, TILE_WIDTH_PX, TILE_BYTE_CEILING } from "../lib/deckScroll";
import { DensityTileQueue, DENSITY_MIN_PPS, DENSITY_MAX_PPS, DENSITY_MAX_HEIGHT, type DensityRequest } from "../lib/waveformDensity";
import { usePref, setPref } from "../lib/prefs";
import type { TrackCue } from "../lib/types";
import { cn } from "../lib/cn";

export interface DeckPlayback { position: number; rate: number }

const CUE_COLORS: Record<string, string> = { entry: "#34d399", exit: "#fb7185", cue: "#22d3ee" };
const PLAYHEAD = "#ef4444";
const DOWNBEAT = "#facc15";
const DRAG_PX = 4;

interface Tile { canvas: HTMLCanvasElement; bytes: number }

/**
 * Scrolling signed-PCM density waveform under a fixed centre playhead. It owns no clock: the host rAF calls `drawRef.current()`
 * each frame, and the position is read from the media (`getPlayback`) at that moment. No React state per frame.
 */
export function DeckScrollWaveform({ trackId, revision, bpm, grid, cues, getPlayback, drawRef, onScrub, onScrubHold, onSeek, durationS, className }: {
  trackId: number;
  revision?: number | null;
  /** Tempo used to size the bar window when there is no grid. */
  bpm: number | null;
  grid: BeatGrid | null;
  cues: TrackCue[];
  getPlayback: () => DeckPlayback | null;
  drawRef: MutableRefObject<(() => void) | null>;
  /** Drag: move the playhead by this many source seconds (the host's jog session). */
  onScrub: (deltaSec: number) => void;
  /** True while a drag is in progress, so the jog session is not finished (and playback resumed) mid-drag. */
  onScrubHold: (held: boolean) => void;
  onSeek: (seconds: number) => void;
  /** Track duration from the library (the bound the backend checks a stored downbeat against). */
  durationS?: number | null;
  className?: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [zoomBars] = usePref("waveformZoomBars");
  const [palette] = usePref("waveformPalette");
  useEffect(() => { tiles.current.clear(); densityQueue.current?.reset(); }, [palette]);
  const [detail, setDetail] = useState<{ id: number; data: DetailWaveform | null } | null>(null);
  const tiles = useRef(new Map<string, Tile>());
  const densityQueue = useRef<DensityTileQueue | null>(null);
  const [densityStatus, setDensityStatus] = useState<"loading" | "error" | null>(null);
  const densityStatusRef = useRef<typeof densityStatus>(null);
  const size = useRef({ w: 0, h: 0, dpr: 1 });
  const live = useRef({ detail: null as DetailWaveform | null, grid, cues, bpm, zoomBars, trackId, palette, getPlayback, effBpm: null as number | null });
  const loaded = detail?.id === trackId;
  const downbeat = useDownbeat(trackId);
  const effBpm = useMemo(() => grid ? 60 / (grid.kind === "straight" ? grid.period : medianPeriod(grid)) : null, [grid]);

  useEffect(() => {
    const held = acquireDetailWaveform(trackId, revision);
    let active = true;
    tiles.current.clear();
    densityQueue.current?.reset();
    setDetail(null);
    // Clear right before the new detail lands so a frame between the clear and the response cannot cache tiles of the old data.
    held.promise.then(data => { if (active) { tiles.current.clear(); setDetail({ id: trackId, data }); } }).catch(() => { if (active) { tiles.current.clear(); setDetail({ id: trackId, data: null }); } });
    return () => { active = false; held.release(); };
  }, [trackId, revision]);

  function draw() {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    const { w, h, dpr } = size.current;
    if (w < 2 || h < 2) return;
    const L = live.current;
    const play = L.getPlayback();
    ctx.clearRect(0, 0, el.width, el.height);
    if (!play) return;
    const pxView = viewPxPerSec(w, clampZoom(L.zoomBars), L.effBpm ?? L.bpm ?? 120);
    const half = w / 2 / pxView;
    const cx = Math.round(w / 2 * dpr);
    const t0 = play.position - half, t1 = play.position + half;
    if (L.detail) drawTiles(ctx, L.detail, play.position, pxView, cx, dpr, h, half);
    if (L.grid) drawBeats(ctx, L.grid, t0, t1, play.position, pxView, w, dpr, h);
    for (const cue of L.cues) {
      const t = cue.position_ms / 1000;
      if (t < t0 || t > t1) continue;
      const x = Math.round((w / 2 + (t - play.position) * pxView) * dpr);
      ctx.fillStyle = CUE_COLORS[cue.kind] ?? CUE_COLORS.cue;
      ctx.fillRect(x - Math.round(dpr), 0, Math.max(2, Math.round(2 * dpr)), el.height);
      ctx.fillRect(x, 0, Math.round(8 * dpr), Math.round(6 * dpr));
    }
    ctx.fillStyle = PLAYHEAD;
    ctx.fillRect(cx - Math.round(dpr), 0, Math.max(2, Math.round(2 * dpr)), el.height);
  }
  live.current = { detail: detail?.id === trackId ? detail.data : null, grid, cues, bpm, zoomBars, trackId, palette, getPlayback, effBpm };
  drawRef.current = draw;
  const latestDraw = useRef(draw);
  latestDraw.current = draw;
  if (!densityQueue.current) densityQueue.current = new DensityTileQueue({
    onTile: (request, density) => {
      const L = live.current;
      if (!L.detail || L.trackId !== request.trackId || L.detail.digestHex !== request.detailDigest
        || !request.key.startsWith(`${L.trackId}:${L.detail.digestHex}:${L.palette}:`)) return;
      const c = document.createElement("canvas");
      c.width = density.width; c.height = density.height;
      const context = c.getContext("2d");
      if (!context) throw new Error("density canvas unavailable");
      context.putImageData(new ImageData(renderDensityTileRGBA(L.detail, density, L.palette), density.width, density.height), 0, 0);
      tiles.current.set(request.key, { canvas: c, bytes: tileBytes(density.width, density.height) });
      // Only canvases are retained; the alpha response becomes collectible here.
    },
    onChange: () => latestDraw.current(),
  });
  // The host rAF keeps calling drawRef: drop this closure (and the tiles it pins) on unmount.
  useEffect(() => () => {
    tiles.current.clear();
    densityQueue.current?.reset();
    if (drawRef.current === latestDraw.current) drawRef.current = null;
  }, [drawRef]);

  function drawTiles(ctx: CanvasRenderingContext2D, data: DetailWaveform, position: number, pxView: number, cx: number, dpr: number, h: number, half: number) {
    // Cap raster dimensions and reserve LRU room for visible tiles plus neighbours.
    let rasterDpr = Math.max(.5, Math.min(8, dpr, DENSITY_MAX_HEIGHT / h));
    let density = 0, tileH = 0;
    for (;;) {
      density = Math.max(DENSITY_MIN_PPS, Math.min(DENSITY_MAX_PPS, tileDensity(pxView * rasterDpr)));
      tileH = Math.max(2, Math.min(DENSITY_MAX_HEIGHT, Math.round(h * rasterDpr)));
      const estimatedTiles = Math.ceil(2 * half * density / TILE_WIDTH_PX) + 4;
      if (estimatedTiles * tileBytes(TILE_WIDTH_PX, tileH) <= TILE_BYTE_CEILING || rasterDpr <= .5) break;
      rasterDpr = Math.max(.5, rasterDpr * .8);
    }
    const tileSec = tileSeconds(density);
    const { visible, keep } = tilesNeeded(position, half, tileSec, data.duration);
    const keepKeys = new Set<string>(), requests: DensityRequest[] = [], missingVisible: string[] = [];
    const track = live.current.trackId, selectedPalette = live.current.palette;
    const keyFor = (i: number) => `${track}:${data.digestHex}:${selectedPalette}:${density}:${tileH}:${rasterDpr}:${i}`;
    const centreTile = Math.floor(position / tileSec);
    const order = Array.from({ length: keep[1] - keep[0] + 1 }, (_, i) => keep[0] + i).sort((a, b) => {
      const av = a >= visible[0] && a <= visible[1], bv = b >= visible[0] && b <= visible[1];
      return Number(bv) - Number(av) || Math.abs(a - centreTile) - Math.abs(b - centreTile);
    });
    for (const i of order) {
      const key = keyFor(i); keepKeys.add(key);
      const isVisible = i >= visible[0] && i <= visible[1];
      const tile = tiles.current.get(key);
      if (tile) {
        tiles.current.delete(key); tiles.current.set(key, tile);
        if (isVisible) {
          const d = tileDest(i, tileSec, position, cx, pxView * dpr);
          if (d.w > 0) ctx.drawImage(tile.canvas, 0, 0, TILE_WIDTH_PX, tileH, d.x, 0, d.w, ctx.canvas.height);
        }
      } else {
        requests.push({ key, trackId: track, detailDigest: data.digestHex, visible: isVisible, tileIndex: i, pixelsPerSecond: density, height: tileH, dpr: rasterDpr });
        if (isVisible) missingVisible.push(key);
      }
    }
    for (const key of evictLru(tiles.current, keepKeys)) tiles.current.delete(key);
    densityQueue.current?.update(requests);
    const status = missingVisible.length ? (missingVisible.some(key => densityQueue.current?.failed(key)) ? "error" : "loading") : null;
    if (status !== densityStatusRef.current) { densityStatusRef.current = status; setDensityStatus(status); }
  }

  function drawBeats(ctx: CanvasRenderingContext2D, g: BeatGrid, t0: number, t1: number, position: number, pxView: number, w: number, dpr: number, h: number) {
    const dim = g.estimated && !g.overridden ? 0.7 : 1;
    ctx.font = `600 ${Math.round(11 * dpr)}px ui-monospace, monospace`;
    ctx.textBaseline = "top";
    const H = Math.round(h * dpr);
    const halo = Math.max(1, Math.round(dpr)); // a dark edge each side keeps light lines readable on light waveform colours
    for (const b of beatsInRange(g, t0, t1)) {
      const x = Math.round((w / 2 + (b.time - position) * pxView) * dpr);
      const lw = Math.max(1, Math.round((b.downbeat ? 2 : 1) * dpr));
      ctx.globalAlpha = (b.downbeat ? 0.75 : 0.55) * dim;
      ctx.fillStyle = "#000000";
      ctx.fillRect(x - (lw >> 1) - halo, 0, lw + 2 * halo, H);
      ctx.globalAlpha = (b.downbeat ? 1 : 0.8) * dim;
      ctx.fillStyle = b.downbeat ? DOWNBEAT : "#ffffff";
      ctx.fillRect(x - (lw >> 1), 0, lw, H);
      if (b.bar != null) {
        const label = String(b.bar);
        const pad = Math.round(3 * dpr);
        const tx = x + Math.round(4 * dpr);
        const ty = H - Math.round(15 * dpr);
        ctx.globalAlpha = 0.8;
        ctx.fillStyle = "#000000";
        ctx.fillRect(tx - pad, ty - Math.round(1 * dpr), ctx.measureText(label).width + 2 * pad, Math.round(13 * dpr));
        ctx.globalAlpha = 1;
        ctx.fillStyle = DOWNBEAT;
        ctx.fillText(label, tx, ty);
      }
    }
    ctx.globalAlpha = 1;
  }

  useEffect(() => {
    const el = wrap.current;
    const c = canvas.current;
    if (!el || !c) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      size.current = { w: r.width, h: r.height, dpr };
      c.width = Math.max(1, Math.round(r.width * dpr));
      c.height = Math.max(1, Math.round(r.height * dpr));
      tiles.current.clear();
      densityQueue.current?.reset();
      draw();
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Repaint when something other than the clock changed (paused deck, new grid / cues / zoom / data).
  useEffect(() => { draw(); });

  // Wheel / trackpad pinch (ctrl+wheel) zoom, non-passive so the page does not scroll.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      setPref("waveformZoomBars", zoomByWheel(live.current.zoomBars, e.ctrlKey ? d * 3 : d));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // One pointer surface: a click seeks to the pointed time, a drag scrubs through the host's jog session.
  const drag = useRef<{ x: number; moved: boolean; start: number } | null>(null);
  function secondsPerPx() {
    const L = live.current;
    return 1 / viewPxPerSec(size.current.w, clampZoom(L.zoomBars), L.effBpm ?? L.bpm ?? 120);
  }

  function pressDownbeat(op: "set" | "prev" | "next") {
    const L = live.current;
    const play = L.getPlayback();
    if (!play || !L.grid) return;
    const v = downbeatAfter(L.grid, play.position, op, durationS ?? L.detail?.duration);
    if (Number.isFinite(v)) void downbeat.set(v);
  }
  const showDownbeat = grid != null || downbeat.value != null;
  // Fixed light text: the overlay sits on a dark backing in both themes.
  const dbButton = "h-4 min-w-4 rounded bg-white/10 px-1 text-[10px] leading-none text-white/80 hover:text-white disabled:opacity-40 disabled:hover:text-white/80";

  return (
    <div ref={wrap} data-deck-scroll-waveform className={cn("relative touch-none select-none overflow-hidden bg-black/30", className)}
      onPointerDown={e => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, moved: false, start: e.clientX };
      }}
      onPointerMove={e => {
        const d = drag.current;
        if (!d) return;
        if (!d.moved && Math.abs(e.clientX - d.start) < DRAG_PX) return;
        if (!d.moved) onScrubHold(true);
        d.moved = true;
        onScrub(-(e.clientX - d.x) * secondsPerPx());
        d.x = e.clientX;
      }}
      onPointerUp={e => {
        const d = drag.current;
        drag.current = null;
        if (d?.moved) onScrubHold(false);
        if (!d || d.moved) return;
        const play = live.current.getPlayback();
        if (!play) return;
        const rect = e.currentTarget.getBoundingClientRect();
        onSeek(Math.max(0, play.position + (e.clientX - rect.left - rect.width / 2) * secondsPerPx()));
      }}
      onPointerCancel={() => { if (drag.current?.moved) onScrubHold(false); drag.current = null; }}
    >
      <canvas ref={canvas} className="absolute inset-0 h-full w-full" aria-hidden="true" />
      {(!loaded || !live.current.detail || densityStatus) && (
        <span role="status" aria-live="polite" className="pointer-events-none absolute left-2 top-1 text-[10px] text-cm-muted">
          {!loaded || (live.current.detail && densityStatus === "loading") ? "Φόρτωση κυματομορφής…" : "Μη διαθέσιμη λεπτομερής κυματομορφή"}
        </span>
      )}
      <div className="absolute right-1 top-1 flex items-center gap-1 rounded bg-black/70 px-1 py-0.5" onPointerDown={e => e.stopPropagation()}>
        {grid?.estimated && !grid.overridden && <span className="pointer-events-none text-[10px] text-white/70">εκτίμηση</span>}
        {grid && !grid.estimated && <span className="pointer-events-none text-[10px] font-semibold text-cyan-300" title="Beatgrid από djay">djay</span>}
        {showDownbeat && (
          <>
            <span className="pointer-events-none text-[9px] font-semibold tracking-wide text-white/70">DOWNBEAT</span>
            <button type="button" className={dbButton} disabled={!downbeat.ready || !grid} aria-label="Ορισμός downbeat στη θέση αναπαραγωγής" title="Ορισμός downbeat στη θέση αναπαραγωγής" onClick={() => pressDownbeat("set")}>Ορισμός</button>
            <button type="button" className={dbButton} disabled={!downbeat.ready || !grid} aria-label="Downbeat ένα beat νωρίτερα" title="Downbeat ένα beat νωρίτερα" onClick={() => pressDownbeat("prev")}>◀</button>
            <button type="button" className={dbButton} disabled={!downbeat.ready || !grid} aria-label="Downbeat ένα beat αργότερα" title="Downbeat ένα beat αργότερα" onClick={() => pressDownbeat("next")}>▶</button>
            {downbeat.value != null && (
              <button type="button" className={dbButton} aria-label="Επαναφορά downbeat" title="Επαναφορά downbeat" onClick={() => void downbeat.reset()}>↺</button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function medianPeriod(g: Extract<BeatGrid, { kind: "list" }>): number {
  const gaps: number[] = [];
  for (let i = 1; i < g.times.length; i++) gaps.push(g.times[i] - g.times[i - 1]);
  gaps.sort((a, b) => a - b);
  return gaps[gaps.length >> 1] || 0.5;
}
