import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MutableRefObject, type PointerEvent } from "react";
import { animate, useReducedMotion } from "motion/react";
import { cn } from "../../lib/cn";
import { usePref } from "../../lib/prefs";
import { useTheme } from "../../lib/theme";
import { barSeconds, timeAfterBars } from "../../lib/beatGrid";
import { acquireDetailWaveform, type DetailWaveform } from "../../lib/detailWaveform";
import { waveformColor } from "../../lib/deckScroll";
import { gridStyle, GRID_BAR_COLOR, GRID_BEAT_COLOR } from "../../lib/gridStyle";
import type { CurveSet, Lane } from "../../lib/transitions/curves";
import type { LoopBeats } from "../../lib/transitions/types";
import {
  audioToSource, audioToX, barsLabel, curveLevel, curvePolyline, DRAG_THRESHOLD_PX, hitTestWindow, laneBeats, laneColumns,
  playheadXs, rubberband, snapWindow, sourceToAudio, stepBars, stepBeat, viewGeometry, VIEW_MAX_BARS, VIEW_MIN_BARS,
  WAVEFORM_COPY, windowAudioS, windowDescription, xToAudio, type LaneMap, type LaneSpec, type ViewGeometry, type WindowHit, type WindowState,
} from "../../lib/transitions/dualWaveform";

export type { LaneSpec } from "../../lib/transitions/dualWaveform";

export interface TransitionWaveformProps {
  /** Outgoing lane. Its `anchorS` is the axis origin and must equal `window.outStartS` once a change is applied. */
  out: LaneSpec;
  /** Incoming lane; `anchorS` is the incoming start (inStartS) and `rate` is rateIn ?? 1. */
  in: LaneSpec;
  window: { outStartS: number; bars: number };
  /** Centre of the view in audio seconds (0 = window start) and the zoom the view opens at. */
  view: { centerAudioS: number; bars: number };
  curves: CurveSet | null;
  loopBeats: LoopBeats | null;
  /** Source positions of both decks during a preview (null when idle); read on every `drawRef` frame. */
  playhead: () => { outS: number; inS: number } | null;
  /** Set to this canvas's draw function; the parent's rAF calls it to move the playheads. */
  drawRef: MutableRefObject<(() => void) | null>;
  /**
   * A committed window change (drag release, keyboard). Controlled: the parent applies it, moving `out.anchorS` to
   * `outStartS` and `in.anchorS` to `inStartS` (when given). The same handler also receives an `onViewChange` that
   * keeps the waveforms where they were on screen while the axis origin moves with the window.
   */
  onWindowChange(next: { outStartS: number; bars: number; inStartS?: number }): void;
  onViewChange(centerAudioS: number): void;
  /** Click (no drag): seek the outgoing deck to this source second. */
  onSeek?(outS: number): void;
  className?: string;
}

type DragMode = "body" | "in" | "start" | "end" | "click";
interface Drag { mode: DragMode; pointerId: number; startX: number; origin: WindowState; moved: boolean }
interface LaneCache { key: string; canvas: HTMLCanvasElement | null }

const LANE_GAP = 6; // CSS px between the outgoing (top) and incoming (bottom) lanes
const BADGE_H = 22; // room under the lanes for the «N bars» badge
const HANDLE_W = 8;
const HANDLE_H = 28;
const PLAYHEAD = "#ef4444";

/** A track's detail waveform (null while loading or when it failed: the lane then shows only its grid). */
function useDetail(trackId: number, revision: number | null | undefined): DetailWaveform | null {
  const key = `${trackId}:${revision ?? 0}`;
  const [state, setState] = useState<{ key: string; data: DetailWaveform | null } | null>(null);
  useEffect(() => {
    const held = acquireDetailWaveform(trackId, revision);
    let active = true;
    held.promise.then(data => { if (active) setState({ key, data }); }).catch(() => { if (active) setState({ key, data: null }); });
    return () => { active = false; held.release(); };
  }, [trackId, revision, key]);
  return state?.key === key ? state.data : null;
}

/** Two stacked zoomed waveforms (outgoing above, incoming below) on one audio axis, with the bar grid, the draggable
 *  N-bar window, the loop region, the automation curves and the preview playheads. */
export function TransitionWaveform(props: TransitionWaveformProps) {
  const { out, in: inn, window: win, view, drawRef, className } = props;
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const badge = useRef<HTMLDivElement>(null);
  const describedBy = useId();
  const [palette] = usePref("waveformPalette");
  const [strongGrid] = usePref("waveformStrongGrid");
  const [prefReduce] = usePref("reduceMotion");
  const osReduce = useReducedMotion();
  const [theme] = useTheme();
  const [zoom, setZoom] = useState(() => clampZoom(view.bars));
  useEffect(() => { setZoom(clampZoom(view.bars)); }, [view.bars]);
  const outDetail = useDetail(out.trackId, out.revision);
  const inDetail = useDetail(inn.trackId, inn.revision);

  const size = useRef({ w: 0, h: 0, dpr: 1 });
  const caches = useRef<{ out: LaneCache; in: LaneCache }>({ out: { key: "", canvas: null }, in: { key: "", canvas: null } });
  /** The window as drawn while a drag or the spring-back runs; null = the props. */
  const pending = useRef<WindowState | null>(null);
  const drag = useRef<Drag | null>(null);
  const anim = useRef<{ stop: () => void } | null>(null);
  /** Reduced motion: the snap is shown as a short opacity pulse of the bracket instead of a spring. */
  const pulse = useRef<{ stop: () => void } | null>(null);
  const hover = useRef<WindowHit>(null);
  const bracketAlpha = useRef(1);
  const colors = useRef(new Map<string, string>());
  useEffect(() => { colors.current.clear(); }, [theme]);

  const live = useRef({ props, zoom, outDetail, inDetail, palette, strongGrid, theme, reduce: !!osReduce || prefReduce });
  live.current = { props, zoom, outDetail, inDetail, palette, strongGrid, theme, reduce: !!osReduce || prefReduce };

  function color(name: string): string {
    let v = colors.current.get(name);
    if (v === undefined) {
      v = getComputedStyle(wrap.current ?? document.documentElement).getPropertyValue(name).trim() || "#ffffff";
      colors.current.set(name, v);
    }
    return v;
  }

  function shown(): WindowState {
    const P = live.current.props;
    return pending.current ?? { outStartS: P.window.outStartS, bars: P.window.bars, inStartS: P.in.anchorS };
  }

  /** Lane transforms for a window state: the outgoing lane keeps the props' origin, the incoming lane rides on the window start. */
  function maps(ws: WindowState) {
    const P = live.current.props;
    const outMap: LaneMap = { anchorS: P.out.anchorS, rate: P.out.rate };
    const winStart = sourceToAudio(outMap, ws.outStartS);
    const winEnd = winStart + windowAudioS(P.out.grid, ws.outStartS, ws.bars, P.out.rate);
    const inRate = P.in.rate > 0 ? P.in.rate : 1;
    const inMap: LaneMap = { anchorS: ws.inStartS - winStart * inRate, rate: inRate };
    return { outMap, inMap, winStart, winEnd };
  }

  function geom(): ViewGeometry {
    const P = live.current.props;
    const barAudio = barSeconds(P.out.grid, P.out.anchorS) / (P.out.rate > 0 ? P.out.rate : 1);
    return viewGeometry({ centerAudioS: P.view.centerAudioS, bars: live.current.zoom }, barAudio, size.current.w);
  }

  function lanes() {
    const lanesH = Math.max(2, size.current.h - BADGE_H);
    const mid = lanesH / 2;
    return { out: { top: 0, bottom: mid - LANE_GAP / 2 }, in: { top: mid + LANE_GAP / 2, bottom: lanesH }, bottom: lanesH };
  }

  /** The lane's waveform columns and grid, rendered once per (view, transform, size, palette, theme) into an offscreen canvas. */
  function laneBitmap(which: "out" | "in", spec: LaneSpec, map: LaneMap, detail: DetailWaveform | null, g: ViewGeometry, top: number, bottom: number) {
    const { w, dpr } = size.current;
    const L = live.current;
    const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round((bottom - top) * dpr));
    const key = [spec.trackId, spec.revision ?? 0, detail ? detail.digestHex || 1 : 0, W, H, L.palette, L.strongGrid, L.theme, g.centerAudioS, g.pxPerSec, map.anchorS, map.rate, spec.duration].join("|");
    const cache = caches.current[which];
    if (cache.key === key && cache.canvas) return cache.canvas;
    const c = cache.canvas ?? document.createElement("canvas");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d");
    cache.key = key; cache.canvas = c;
    if (!ctx) return c;
    ctx.clearRect(0, 0, W, H);
    // The track's own extent: outside it the lane stays dark.
    const xs = audioToX(g, sourceToAudio(map, 0)) * dpr, xe = audioToX(g, sourceToAudio(map, spec.duration)) * dpr;
    ctx.fillStyle = "#ffffff";
    ctx.globalAlpha = 0.04;
    ctx.fillRect(Math.max(0, xs), 0, Math.min(W, xe) - Math.max(0, xs), H);
    ctx.globalAlpha = 1;
    if (detail) {
      const t0 = audioToSource(map, xToAudio(g, 0)), t1 = audioToSource(map, xToAudio(g, w));
      const cols = laneColumns(detail, t0, t1, W);
      const half = H / 2, scale = (half - dpr) / 255;
      for (let x = 0; x < cols.length; x++) {
        const [rms, peak, r, gg, b] = cols[x];
        if (!peak) continue;
        const [cr, cg, cb] = waveformColor(r, gg, b, L.palette);
        ctx.fillStyle = `rgb(${cr | 0},${cg | 0},${cb | 0})`;
        const ph = Math.max(1, peak * scale), rh = Math.max(1, rms * scale);
        ctx.globalAlpha = 0.45;
        ctx.fillRect(x, half - ph, 1, 2 * ph);
        ctx.globalAlpha = 1;
        ctx.fillRect(x, half - rh, 1, 2 * rh);
      }
    }
    drawGrid(ctx, spec, map, g, W, H, which === "out" ? "top" : "bottom");
    return c;
  }

  function drawGrid(ctx: CanvasRenderingContext2D, spec: LaneSpec, map: LaneMap, g: ViewGeometry, W: number, H: number, labelAt: "top" | "bottom") {
    const { w, dpr } = size.current;
    const grid = spec.grid;
    const dim = grid.estimated && !grid.overridden ? 0.7 : 1;
    const style = gridStyle(live.current.strongGrid);
    const ls = style.label;
    const barColor = color(GRID_BAR_COLOR);
    const halo = Math.max(1, Math.round(dpr));
    ctx.font = `${ls.weight} ${Math.round(ls.size * dpr)}px ui-monospace, monospace`;
    ctx.textBaseline = "top";
    for (const b of laneBeats({ grid, ...map }, xToAudio(g, 0), xToAudio(g, w))) {
      if (b.time < 0 || b.time > spec.duration) continue;
      const x = Math.round(audioToX(g, b.audio) * dpr);
      const line = b.downbeat ? style.bar : style.beat;
      const lw = Math.max(1, Math.round(line.width * dpr));
      ctx.globalAlpha = line.halo * dim;
      ctx.fillStyle = "#000000";
      ctx.fillRect(x - (lw >> 1) - halo, 0, lw + 2 * halo, H);
      ctx.globalAlpha = line.alpha * dim;
      ctx.fillStyle = b.downbeat ? barColor : GRID_BEAT_COLOR;
      ctx.fillRect(x - (lw >> 1), 0, lw, H);
      if (b.bar != null) {
        const label = String(b.bar);
        const pad = Math.round(2 * dpr);
        const tx = x + Math.round(3 * dpr);
        const ty = labelAt === "top" ? Math.round(2 * dpr) : H - Math.round((ls.size + 4) * dpr);
        ctx.globalAlpha = ls.box;
        ctx.fillStyle = "#000000";
        ctx.fillRect(tx - pad, ty - Math.round(dpr), ctx.measureText(label).width + 2 * pad, Math.round((ls.size + 2) * dpr));
        ctx.globalAlpha = ls.alpha;
        ctx.fillStyle = barColor;
        ctx.fillText(label, tx, ty);
      }
    }
    ctx.globalAlpha = 1;
  }

  function strokeCurve(ctx: CanvasRenderingContext2D, pts: number[], stroke: string, alpha: number, dashed: boolean) {
    const { dpr } = size.current;
    if (pts.length < 4) return;
    ctx.beginPath();
    ctx.moveTo(pts[0] * dpr, pts[1] * dpr);
    for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i] * dpr, pts[i + 1] * dpr);
    ctx.setLineDash(dashed ? [4 * dpr, 3 * dpr] : []);
    ctx.lineJoin = "round";
    ctx.globalAlpha = 0.55 * alpha;
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 4 * dpr;
    ctx.stroke();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2 * dpr;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  function drawCurves(ctx: CanvasRenderingContext2D, curves: CurveSet, x0: number, x1: number) {
    const ly = lanes();
    const any = (pick: (l: Lane) => Float32Array) => [curves.out, curves.in].some(l => pick(l).some(v => v !== 0));
    const eqActive = any(l => l.eqLo) || any(l => l.eqMid) || any(l => l.eqHi);
    const multiBand = any(l => l.eqMid) || any(l => l.eqHi);
    const filterActive = any(l => l.filter);
    const families: { kind: "volume" | "eq" | "filter"; pick: (l: Lane) => Float32Array; color: string; active: boolean; dashed: boolean }[] = [
      { kind: "filter", pick: l => l.filter, color: color("--cm-magenta"), active: filterActive, dashed: false },
      { kind: "eq", pick: l => l.eqLo, color: color("--cm-amber"), active: eqActive, dashed: false },
      ...(multiBand ? [
        { kind: "eq" as const, pick: (l: Lane) => l.eqMid, color: color("--cm-amber"), active: true, dashed: true },
        { kind: "eq" as const, pick: (l: Lane) => l.eqHi, color: color("--cm-amber"), active: true, dashed: true },
      ] : []),
      { kind: "volume", pick: l => l.volume, color: color("--cm-blue"), active: true, dashed: false },
    ];
    // Inactive families first (35 %), active ones on top.
    for (const pass of [false, true]) {
      for (const f of families) {
        if (f.active !== pass) continue;
        for (const [lane, band] of [[curves.out, ly.out], [curves.in, ly.in]] as const) {
          const levels = Array.from(f.pick(lane), v => curveLevel(f.kind, v));
          strokeCurve(ctx, curvePolyline(levels, x0, x1, band.top + 5, band.bottom - 5), f.color, f.active ? 1 : 0.35, f.dashed);
        }
      }
    }
  }

  function draw() {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    const { w, h, dpr } = size.current;
    if (w < 2 || h < 2) return;
    const L = live.current, P = L.props;
    const ws = shown();
    const { outMap, inMap, winStart, winEnd } = maps(ws);
    const g = geom();
    const ly = lanes();
    ctx.clearRect(0, 0, el.width, el.height);
    const ob = laneBitmap("out", P.out, outMap, L.outDetail, g, ly.out.top, ly.out.bottom);
    const ib = laneBitmap("in", P.in, inMap, L.inDetail, g, ly.in.top, ly.in.bottom);
    if (ob) ctx.drawImage(ob, 0, Math.round(ly.out.top * dpr));
    if (ib) ctx.drawImage(ib, 0, Math.round(ly.in.top * dpr));

    const x0 = audioToX(g, winStart), x1 = audioToX(g, winEnd);
    const bottom = ly.bottom * dpr;
    ctx.fillStyle = "#ffffff";
    ctx.globalAlpha = 0.07 * bracketAlpha.current;
    ctx.fillRect(x0 * dpr, 0, (x1 - x0) * dpr, bottom);
    ctx.globalAlpha = 1;

    if (P.loopBeats) {
      const loopEnd = timeAfterBars(P.out.grid, ws.outStartS, P.loopBeats / 4);
      const lx1 = audioToX(g, sourceToAudio(outMap, loopEnd));
      ctx.fillStyle = color("--cm-amber");
      ctx.globalAlpha = 0.18;
      ctx.fillRect(x0 * dpr, ly.out.top * dpr, (Math.min(lx1, x1) - x0) * dpr, (ly.out.bottom - ly.out.top) * dpr);
      ctx.globalAlpha = 1;
    }

    if (P.curves) drawCurves(ctx, P.curves, x0, x1);

    // Window bracket: two edges with [ ] ticks and an 8 px grip each; the hovered (or dragged) edge brightens.
    const active = drag.current?.mode ?? hover.current;
    for (const [edge, x, dir] of [["start", x0, 1], ["end", x1, -1]] as const) {
      const bright = active === edge || active === "body";
      const a = (bright ? 1 : 0.7) * bracketAlpha.current;
      const px = Math.round(x * dpr), lw = Math.max(2, Math.round(2 * dpr)), tick = Math.round(8 * dpr);
      ctx.globalAlpha = 0.6 * a;
      ctx.fillStyle = "#000000";
      ctx.fillRect(px - lw / 2 - dpr, 0, lw + 2 * dpr, bottom);
      ctx.globalAlpha = a;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(px - lw / 2, 0, lw, bottom);
      ctx.fillRect(dir > 0 ? px - lw / 2 : px + lw / 2 - tick, 0, tick, lw);
      ctx.fillRect(dir > 0 ? px - lw / 2 : px + lw / 2 - tick, bottom - lw, tick, lw);
      const gy = (ly.out.bottom + ly.in.top) / 2 - HANDLE_H / 2;
      ctx.beginPath();
      ctx.roundRect((x - HANDLE_W / 2) * dpr, gy * dpr, HANDLE_W * dpr, HANDLE_H * dpr, 3 * dpr);
      ctx.fill();
      ctx.globalAlpha = 0.5 * a;
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = dpr;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    const play = P.playhead();
    if (play) {
      const p = playheadXs(g, outMap, inMap, play);
      ctx.fillStyle = PLAYHEAD;
      const lw = Math.max(2, Math.round(2 * dpr));
      for (const [x, band] of [[p.out, ly.out], [p.in, ly.in]] as const) {
        if (x < -2 || x > w + 2) continue;
        ctx.fillRect(Math.round(x * dpr) - lw / 2, band.top * dpr, lw, (band.bottom - band.top) * dpr);
      }
    }

    const bd = badge.current;
    if (bd) {
      const text = barsLabel(ws.bars);
      if (bd.textContent !== text) bd.textContent = text;
      const cx = Math.min(Math.max((x0 + x1) / 2, bd.offsetWidth / 2), w - bd.offsetWidth / 2);
      bd.style.transform = `translateX(${Math.round(cx - bd.offsetWidth / 2)}px)`;
      bd.style.opacity = x1 < 0 || x0 > w ? "0" : String(bracketAlpha.current);
    }
  }

  const drawLatest = useRef(draw);
  drawLatest.current = draw;
  const stableDraw = useCallback(() => drawLatest.current(), []);

  useEffect(() => {
    drawRef.current = stableDraw;
    return () => { if (drawRef.current === stableDraw) drawRef.current = null; };
  }, [drawRef, stableDraw]);

  // Controlled: once no drag or spring is running, the props are the truth again (a committed change has arrived, or was refused).
  useLayoutEffect(() => {
    if (!drag.current && !anim.current) pending.current = null;
    stableDraw();
  });

  useEffect(() => {
    const el = wrap.current, c = canvas.current;
    if (!el || !c) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      size.current = { w: r.width, h: r.height, dpr };
      c.width = Math.max(1, Math.round(r.width * dpr));
      c.height = Math.max(1, Math.round(r.height * dpr));
      stableDraw();
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [stableDraw]);

  useEffect(() => () => { anim.current?.stop(); pulse.current?.stop(); }, []);

  /** Hand a settled window to the parent; the waveforms stay put on screen while the axis origin follows the window,
   *  unless the window would end up partly off screen: then the view re-centres on it. */
  function commit(ws: WindowState) {
    const P = live.current.props;
    const { outMap } = maps(ws);
    let center = P.view.centerAudioS - sourceToAudio(outMap, ws.outStartS);
    const g = geom();
    const half = g.width / 2 / g.pxPerSec;
    const len = windowAudioS(P.out.grid, ws.outStartS, ws.bars, P.out.rate);
    if (center - half > 0 || center + half < len) center = len <= 2 * half ? len / 2 : half * 0.9;
    pending.current = ws;
    const changed = Math.abs(ws.outStartS - P.window.outStartS) > 1e-9 || ws.bars !== P.window.bars || Math.abs(ws.inStartS - P.in.anchorS) > 1e-9;
    if (changed) P.onWindowChange({ outStartS: ws.outStartS, bars: ws.bars, inStartS: ws.inStartS });
    if (Math.abs(center - P.view.centerAudioS) > 1e-9) P.onViewChange(center);
    if (!changed) pending.current = null;
    stableDraw();
  }

  /** Spring the drawn window to its snapped target (opacity pulse only under reduced motion), then commit. */
  function settle(target: WindowState) {
    const from = pending.current ?? target;
    const same = Math.abs(from.outStartS - target.outStartS) < 1e-6 && Math.abs(from.inStartS - target.inStartS) < 1e-6;
    if (same || live.current.reduce) {
      commit(target);
      if (!same) {
        pulse.current?.stop();
        pulse.current = animate(0.4, 1, { duration: 0.15, ease: "easeOut", onUpdate: v => { bracketAlpha.current = v; stableDraw(); } });
      }
      return;
    }
    const controls = animate(0, 1, {
      type: "spring", bounce: 0, duration: 0.3,
      onUpdate: p => {
        pending.current = { outStartS: from.outStartS + (target.outStartS - from.outStartS) * p, inStartS: from.inStartS + (target.inStartS - from.inStartS) * p, bars: target.bars };
        stableDraw();
      },
      onComplete: () => { anim.current = null; commit(target); },
    });
    anim.current = controls;
  }

  const localX = (e: { clientX: number }) => e.clientX - (wrap.current?.getBoundingClientRect().left ?? 0);

  function hitAt(x: number): WindowHit {
    const { winStart, winEnd } = maps(shown());
    const g = geom();
    return hitTestWindow(x, audioToX(g, winStart), audioToX(g, winEnd));
  }

  function setCursor(hit: WindowHit, dragging: boolean) {
    const el = wrap.current;
    if (!el) return;
    el.style.cursor = hit === "start" || hit === "end" ? "ew-resize" : hit === "body" ? (dragging ? "grabbing" : "grab") : props.onSeek ? "pointer" : "default";
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || !e.isPrimary) return;
    // Interrupt a running spring from its presented value: the new drag starts where the window is drawn.
    if (anim.current) { anim.current.stop(); anim.current = null; }
    const x = localX(e);
    const hit = hitAt(x);
    const mode: DragMode = hit === "start" || hit === "end" ? hit : hit === "body" ? (e.altKey ? "in" : "body") : "click";
    drag.current = { mode, pointerId: e.pointerId, startX: x, origin: shown(), moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus({ preventScroll: true });
    setCursor(hit, true);
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const x = localX(e);
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) {
      if (d) return;
      const hit = hitAt(x);
      if (hit !== hover.current) { hover.current = hit; setCursor(hit, false); stableDraw(); }
      return;
    }
    const dx = x - d.startX;
    if (!d.moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
    d.moved = true;
    if (d.mode === "click") return;
    const P = live.current.props;
    const g = geom();
    const dA = dx / g.pxPerSec;
    const o = d.origin;
    const bounds = { out: { grid: P.out.grid, duration: P.out.duration, rate: P.out.rate }, in: { grid: P.in.grid, duration: P.in.duration, rate: P.in.rate } };
    if (d.mode === "body") {
      const span = timeAfterBars(P.out.grid, o.outStartS, o.bars) - o.outStartS;
      const raw = o.outStartS + dA * P.out.rate;
      pending.current = { ...o, outStartS: banded(raw, 0, P.out.duration - span, P.out.rate, g) };
    } else if (d.mode === "in") {
      const inRate = P.in.rate > 0 ? P.in.rate : 1;
      const span = windowAudioS(P.out.grid, o.outStartS, o.bars, P.out.rate) * inRate;
      const raw = o.inStartS - dA * inRate; // dragging the incoming lane right starts it earlier in its track
      pending.current = { ...o, inStartS: banded(raw, 0, P.in.duration - span, inRate, g) };
    } else {
      const { outMap } = maps(o);
      const atS = audioToSource(outMap, xToAudio(g, x));
      const bar = barSeconds(P.out.grid, o.outStartS);
      if (d.mode === "end") {
        const bars = Math.round((atS - o.outStartS) / bar);
        pending.current = snapWindow({ ...o, bars: Math.max(1, bars) }, bounds.out, bounds.in, "beat");
      } else {
        // The start edge moves in whole bars and keeps the end where it is (snapWindow keeps it inside the track).
        const end = timeAfterBars(P.out.grid, o.outStartS, o.bars);
        const bars = Math.max(1, Math.min(32, Math.round((end - atS) / bar)));
        pending.current = snapWindow({ ...o, outStartS: timeAfterBars(P.out.grid, end, -bars), bars }, bounds.out, bounds.in, "beat");
      }
    }
    stableDraw();
  }

  /** A source position past [lo, hi] follows the pointer with rubber-band resistance (in screen px). */
  function banded(raw: number, lo: number, hi: number, rate: number, g: ViewGeometry): number {
    const pxPerSource = g.pxPerSec / rate;
    if (raw < lo) return lo + rubberband((raw - lo) * pxPerSource, g.width) / pxPerSource;
    if (raw > hi) return hi + rubberband((raw - hi) * pxPerSource, g.width) / pxPerSource;
    return raw;
  }

  function endDrag(e: PointerEvent<HTMLDivElement>, cancelled: boolean) {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    const P = live.current.props;
    const x = localX(e);
    setCursor(hitAt(x), false);
    if (!d.moved || d.mode === "click") {
      if (!cancelled && !d.moved && d.mode !== "start" && d.mode !== "end" && P.onSeek) {
        const { outMap } = maps(shown());
        P.onSeek(Math.min(P.out.duration, Math.max(0, audioToSource(outMap, xToAudio(geom(), x)))));
      }
      stableDraw();
      return;
    }
    const cur = pending.current ?? d.origin;
    const bounds = [{ grid: P.out.grid, duration: P.out.duration, rate: P.out.rate }, { grid: P.in.grid, duration: P.in.duration, rate: P.in.rate }] as const;
    if (d.mode === "body") settle(snapWindow(cur, bounds[0], bounds[1], "bar"));
    else if (d.mode === "in") settle(snapWindow(cur, bounds[0], bounds[1], "beat"));
    else commit(cur);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (drag.current) return;
    const P = live.current.props;
    const ws = shown();
    let next: WindowState | null = null;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const dir = e.key === "ArrowRight" ? 1 : -1;
      if (e.altKey) next = { ...ws, inStartS: stepBeat(P.in.grid, ws.inStartS, dir === 1 ? -1 : 1) }; // → moves the incoming lane right, like the drag
      else if (e.shiftKey) next = { ...ws, outStartS: timeAfterBars(P.out.grid, ws.outStartS, dir) };
      else next = { ...ws, outStartS: stepBeat(P.out.grid, ws.outStartS, dir) };
    } else if ((e.key === "[" || e.key === "]") && !e.metaKey && !e.ctrlKey) {
      next = { ...ws, bars: stepBars(ws.bars, e.key === "]" ? 1 : -1) };
    }
    if (!next) return;
    e.preventDefault();
    e.stopPropagation();
    if (anim.current) { anim.current.stop(); anim.current = null; }
    commit(snapWindow(next, { grid: P.out.grid, duration: P.out.duration, rate: P.out.rate }, { grid: P.in.grid, duration: P.in.duration, rate: P.in.rate }, "beat"));
  }

  // Wheel pans, Shift+wheel (or a pinch) zooms 2..32 bars around the centre. Non-passive so the dialog does not scroll.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.shiftKey || e.ctrlKey) {
        const delta = e.deltaY || e.deltaX;
        setZoom(z => clampZoom(z * Math.exp(delta * 0.002)));
        return;
      }
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!d) return;
      const P = live.current.props;
      P.onViewChange(P.view.centerAudioS + d / geom().pxPerSec);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={wrap}
      role="group"
      tabIndex={0}
      aria-label={WAVEFORM_COPY.label}
      aria-describedby={describedBy}
      aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Alt+ArrowLeft Alt+ArrowRight [ ]"
      data-transition-waveform
      className={cn(
        "relative min-h-40 touch-none select-none overflow-hidden rounded-lg bg-black/80 ring-1 ring-white/10 outline-none dark:bg-black/40",
        "focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={e => endDrag(e, false)}
      onPointerCancel={e => endDrag(e, true)}
      onPointerLeave={() => { if (!drag.current && hover.current) { hover.current = null; stableDraw(); } }}
      onKeyDown={onKeyDown}
    >
      <canvas ref={canvas} className="absolute inset-0 h-full w-full" aria-hidden="true" />
      <div
        ref={badge}
        aria-hidden="true"
        className="pointer-events-none absolute bottom-0.5 left-0 rounded-md bg-black/70 px-1.5 py-0.5 font-mono text-[11px] leading-none text-white/90 tabular-nums ring-1 ring-white/15"
      >
        {barsLabel(win.bars)}
      </div>
      <span id={describedBy} className="sr-only">
        {windowDescription(out.grid, win.outStartS, win.bars)}. {WAVEFORM_COPY.hint}
      </span>
    </div>
  );
}

function clampZoom(bars: number): number {
  return Number.isFinite(bars) ? Math.min(VIEW_MAX_BARS, Math.max(VIEW_MIN_BARS, bars)) : 8;
}
