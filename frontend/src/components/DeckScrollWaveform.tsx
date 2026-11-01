import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { acquireDetailWaveform, type DetailWaveform } from "../lib/detailWaveform";
import { beatsInRange, downbeatAfter, type BeatGrid } from "../lib/beatGrid";
import { useDownbeat } from "../lib/trackDownbeat";
import { clampZoom, evictLru, renderTileRGBA, tileBytes, tileDensity, tileDest, tileSeconds, tilesNeeded, viewPxPerSec, zoomByWheel, TILE_WIDTH_PX } from "../lib/deckScroll";
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
 * Scrolling 3-band waveform under a fixed centre playhead. It owns no clock: the host rAF calls `drawRef.current()`
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
  const [detail, setDetail] = useState<{ id: number; data: DetailWaveform | null } | null>(null);
  const tiles = useRef(new Map<string, Tile>());
  const size = useRef({ w: 0, h: 0, dpr: 1 });
  const live = useRef({ detail: null as DetailWaveform | null, grid, cues, bpm, zoomBars, trackId, getPlayback, effBpm: null as number | null });
  const loaded = detail?.id === trackId;
  const downbeat = useDownbeat(trackId);
  const effBpm = useMemo(() => grid ? 60 / (grid.kind === "straight" ? grid.period : medianPeriod(grid)) : null, [grid]);

  useEffect(() => {
    const held = acquireDetailWaveform(trackId, revision);
    let active = true;
    tiles.current.clear();
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
  live.current = { detail: detail?.id === trackId ? detail.data : null, grid, cues, bpm, zoomBars, trackId, getPlayback, effBpm };
  drawRef.current = draw;
  const latestDraw = useRef(draw);
  latestDraw.current = draw;
  // The host rAF keeps calling drawRef: drop this closure (and the tiles it pins) on unmount.
  useEffect(() => () => {
    tiles.current.clear();
    if (drawRef.current === latestDraw.current) drawRef.current = null;
  }, [drawRef]);

  function drawTiles(ctx: CanvasRenderingContext2D, data: DetailWaveform, position: number, pxView: number, cx: number, dpr: number, h: number, half: number) {
    const density = tileDensity(pxView * dpr); // device px per second the tiles are rastered at
    const tileSec = tileSeconds(density); // tileDest widths are the x-scale: tile px -> exact view density
    const { visible, keep } = tilesNeeded(position, half, tileSec, data.duration);
    const tileH = Math.max(2, Math.round(h * dpr));
    const keepKeys = new Set<string>();
    let rendered = 0;
    for (let i = keep[0]; i <= keep[1]; i++) {
      const key = `${density}:${tileH}:${i}`;
      keepKeys.add(key);
      let tile = tiles.current.get(key);
      if (tile) { tiles.current.delete(key); tiles.current.set(key, tile); } // LRU touch
      else if (rendered < 1 || (i >= visible[0] && i <= visible[1])) {
        // Visible tiles are rasterised now; neighbours one per frame so a zoom change cannot stall a frame.
        const c = document.createElement("canvas");
        c.width = TILE_WIDTH_PX; c.height = tileH;
        c.getContext("2d")?.putImageData(new ImageData(renderTileRGBA(data, i, density, TILE_WIDTH_PX, tileH), TILE_WIDTH_PX, tileH), 0, 0);
        tile = { canvas: c, bytes: tileBytes(TILE_WIDTH_PX, tileH) };
        tiles.current.set(key, tile);
        if (i < visible[0] || i > visible[1]) rendered++;
      }
      if (!tile || i < visible[0] || i > visible[1]) continue;
      const d = tileDest(i, tileSec, position, cx, pxView * dpr);
      if (d.w > 0) ctx.drawImage(tile.canvas, 0, 0, TILE_WIDTH_PX, tileH, d.x, 0, d.w, ctx.canvas.height);
    }
    for (const k of evictLru(tiles.current, keepKeys)) tiles.current.delete(k);
  }

  function drawBeats(ctx: CanvasRenderingContext2D, g: BeatGrid, t0: number, t1: number, position: number, pxView: number, w: number, dpr: number, h: number) {
    const dim = g.estimated && !g.overridden ? 0.7 : 1;
    ctx.font = `600 ${Math.round(11 * dpr)}px ui-monospace, monospace`;
    ctx.textBaseline = "top";
    for (const b of beatsInRange(g, t0, t1)) {
      const x = Math.round((w / 2 + (b.time - position) * pxView) * dpr);
      ctx.globalAlpha = (b.downbeat ? 0.95 : 0.5) * dim;
      ctx.fillStyle = b.downbeat ? DOWNBEAT : "#ffffff";
      const lw = Math.max(1, Math.round((b.downbeat ? 2 : 1) * dpr));
      ctx.fillRect(x - (lw >> 1), 0, lw, Math.round(h * dpr));
      if (b.bar != null) {
        ctx.globalAlpha = 1;
        ctx.shadowColor = "rgba(0,0,0,0.9)";
        ctx.shadowBlur = Math.round(3 * dpr);
        ctx.fillText(String(b.bar), x + Math.round(3 * dpr), Math.round(h * dpr) - Math.round(14 * dpr));
        ctx.shadowBlur = 0;
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
  const dbButton = "h-4 min-w-4 rounded bg-black/50 px-1 text-[10px] leading-none text-cm-muted hover:text-white disabled:opacity-40 disabled:hover:text-cm-muted";

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
      {(!loaded || !live.current.detail) && (
        <span role="status" aria-live="polite" className="pointer-events-none absolute left-2 top-1 text-[10px] text-cm-muted">
          {!loaded ? "Φόρτωση κυματομορφής…" : "Μη διαθέσιμη λεπτομερής κυματομορφή"}
        </span>
      )}
      <div className="absolute right-1 top-1 flex items-center gap-1" onPointerDown={e => e.stopPropagation()}>
        {grid?.estimated && !grid.overridden && <span className="pointer-events-none text-[10px] text-cm-muted">εκτίμηση</span>}
        {showDownbeat && (
          <>
            <span className="pointer-events-none text-[9px] font-semibold tracking-wide text-cm-muted">DOWNBEAT</span>
            <button type="button" className={dbButton} disabled={!downbeat.ready || !grid} aria-label="Ορισμός downbeat στη θέση αναπαραγωγής" title="Ορισμός downbeat στη θέση αναπαραγωγής" onClick={() => pressDownbeat("set")}>Set</button>
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
