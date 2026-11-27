/**
 * The canvas side of «Η κυματομορφή ακολουθεί το EQ» (colour maths: `waveEq.ts`). A lane tile is alpha(x, y) × colour(x),
 * so a new EQ needs no new tile: one row of colours is drawn over the tile's own pixels with "source-atop", which
 * replaces the colour and keeps every pixel's alpha. Nothing here runs, and no tile carries anything extra, while the
 * setting is off.
 */
import type { StretchDeck } from "./audio/stretchDeck";
import type { DetailWaveform } from "./detailWaveform";
import { getMixer } from "./mixer";
import type { DeckId } from "./player";
import { eqKey, eqStripRGBA } from "./waveEq";
import type { WavePaletteId } from "./wavePalette";

/** What a tile remembers while the setting is on: where it starts, its density and the EQ its colours show. */
export interface TileEq { start: number; pps: number; key: number }

const STAGE = [0, 0, 0, 0];
/**
 * The EQ the deck's listener hears now, as an `eqKey`: the mixer's LOW / MID / HIGH and, on the engine, what a running
 * transition's stage adds. TRIM, FILTER and the faders play no part. Allocates nothing.
 */
export function laneEqKey(deck: DeckId, engine: StretchDeck | null): number {
  const eq = getMixer().fx[deck].eq;
  return eqKey(eq.lo, eq.mid, eq.hi, engine ? engine.automationEq(STAGE) : null);
}

// One strip for every tile and both lanes: it is filled and used within one call.
let strip: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; image: ImageData } | null = null;

/** Repaints a tile's colours for `key`, keeping its alpha. False when the canvas is not available. */
export function recolourTile(tile: HTMLCanvasElement, detail: DetailWaveform, eq: TileEq, palette: WavePaletteId, key: number): boolean {
  const ctx = tile.getContext("2d");
  if (!ctx) return false;
  if (!strip || strip.canvas.width !== tile.width) {
    const canvas = document.createElement("canvas");
    canvas.width = tile.width; canvas.height = 1;
    const stripCtx = canvas.getContext("2d");
    if (!stripCtx) return false;
    strip = { canvas, ctx: stripCtx, image: stripCtx.createImageData(tile.width, 1) };
  }
  eqStripRGBA(detail, eq.start, eq.pps, tile.width, palette, key, strip.image.data);
  strip.ctx.putImageData(strip.image, 0, 0);
  ctx.globalCompositeOperation = "source-atop";
  ctx.imageSmoothingEnabled = false;   // the one row is stretched down the tile: no blending at its edges
  ctx.drawImage(strip.canvas, 0, 0, tile.width, 1, 0, 0, tile.width, tile.height);
  ctx.globalCompositeOperation = "source-over";
  return true;
}
