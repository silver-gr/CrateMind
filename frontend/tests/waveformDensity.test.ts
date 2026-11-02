import { describe, expect, test } from 'bun:test';
import { DensityTileQueue, parseDensityTile, type DensityRequest, type DensityTile } from '../src/lib/waveformDensity';
import { renderDensityTileRGBA } from '../src/lib/deckScroll';
import type { DetailWaveform } from '../src/lib/detailWaveform';

const request = (key = 'a'): DensityRequest => ({ key, trackId: 1, detailDigest: '00'.repeat(16), visible: true, tileIndex: 0, pixelsPerSecond: 128, height: 8, dpr: 2 });
function packet(req = request()): ArrayBuffer {
  const bytes = new Uint8Array(56 + 2048 * req.height), view = new DataView(bytes.buffer);
  bytes.set([67, 77, 68, 78]); view.setUint16(4, 1, true);
  view.setUint32(8, 2048, true); view.setUint32(12, req.height, true);
  view.setFloat64(16, req.tileIndex * 2048 / req.pixelsPerSecond, true);
  view.setFloat64(24, req.pixelsPerSecond, true); view.setFloat64(32, req.dpr, true);
  bytes[56] = 91; bytes[56 + 2048 + 1] = 207;
  return bytes.buffer;
}
const tile = (req = request()) => parseDensityTile(packet(req), req);
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe('density wire format', () => {
  test('reads row-major alpha without copying or mirroring it', () => {
    const data = packet(), result = parseDensityTile(data, request());
    expect(result.alpha.buffer).toBe(data);
    expect(result.alpha[0]).toBe(91); expect(result.alpha[2049]).toBe(207);
    expect(result.alpha[7 * 2048]).toBe(0);
  });
  test('rejects corrupt, truncated and stale-geometry responses', () => {
    const bad = (change: (view: DataView) => void) => { const data = packet(); change(new DataView(data)); return data; };
    expect(() => parseDensityTile(packet().slice(0, 55), request())).toThrow('size');
    expect(() => parseDensityTile(packet().slice(0, -1), request())).toThrow('length');
    expect(() => parseDensityTile(bad(v => v.setUint16(4, 2, true)), request())).toThrow('header');
    expect(() => parseDensityTile(bad(v => v.setFloat64(24, NaN, true)), request())).toThrow('geometry');
    expect(() => parseDensityTile(packet(), { ...request(), tileIndex: 1 })).toThrow('geometry');
    expect(() => parseDensityTile(packet(), { ...request(), dpr: 1 })).toThrow('geometry');
  });
});

describe('density compositing', () => {
  const w: DetailWaveform = { version: 2, sampleRate: 1000, hop: 1000, win: 1000, frames: 16, duration: 16, digestHex: '',
    rms: new Uint8Array(16).fill(50), peak: new Uint8Array(16).fill(200), red: new Uint8Array(16).fill(180), green: new Uint8Array(16).fill(20), blue: new Uint8Array(16).fill(40) };
  test('keeps signed density and straight RGB, with no RMS core or alpha premultiplication', () => {
    const density = tile(), rgba = renderDensityTileRGBA(w, density, 'frequency');
    expect(Array.from(rgba.slice(0, 4))).toEqual([180, 20, 40, 91]);
    expect(Array.from(rgba.slice(2049 * 4, 2049 * 4 + 4))).toEqual([180, 20, 40, 207]);
    expect(rgba[(7 * 2048) * 4 + 3]).toBe(0);
    const changedEnvelope = { ...w, rms: new Uint8Array(16).fill(255), peak: new Uint8Array(16).fill(255) };
    expect(renderDensityTileRGBA(changedEnvelope, density, 'frequency')).toEqual(rgba);
  });
  test('palettes change RGB but preserve every density alpha value', () => {
    const density = tile();
    const a = renderDensityTileRGBA(w, density, 'frequency'), b = renderDensityTileRGBA(w, density, 'theme');
    expect(Array.from(a.slice(0, 3))).not.toEqual(Array.from(b.slice(0, 3)));
    for (let i = 0; i < density.alpha.length; i++) expect(b[i * 4 + 3]).toBe(density.alpha[i]);
  });
});

describe('density request lifecycle', () => {
  test('fetches one tile at a time in visible-first order and notifies paused consumers', async () => {
    const calls: string[] = [], deliveries: string[] = [], resolves: ((tile: DensityTile) => void)[] = [];
    let paints = 0;
    const queue = new DensityTileQueue({ fetch: req => { calls.push(req.key); return new Promise(resolve => resolves.push(resolve)); }, onTile: req => deliveries.push(req.key), onChange: () => paints++ });
    queue.update([request('visible'), request('neighbour')]);
    expect(calls).toEqual(['visible']);
    resolves[0](tile()); await settle();
    expect(deliveries).toEqual(['visible']); expect(paints).toBe(1);
    expect(calls).toEqual(['visible', 'neighbour']);
    queue.reset();
  });
  test('obsolete requests are aborted and late successes cannot overwrite the current view', async () => {
    const flights: { req: DensityRequest; signal: AbortSignal; resolve: (tile: DensityTile) => void }[] = [], deliveries: string[] = [];
    const queue = new DensityTileQueue({ fetch: (req, signal) => new Promise(resolve => flights.push({ req, signal, resolve })), onTile: req => deliveries.push(req.key), onChange: () => {} });
    queue.update([request('old')]); queue.update([request('new')]);
    expect(flights[0].signal.aborted).toBe(true);
    flights[0].resolve(tile()); await settle(); expect(deliveries).toEqual([]);
    flights[1].resolve(tile()); await settle(); expect(deliveries).toEqual(['new']);
    queue.reset();
  });
  test('busy failures back off across animation frames and stop after five attempts', async () => {
    let now = 0, calls = 0;
    const scheduled = new Set<{ at: number; fn: () => void }>();
    const queue = new DensityTileQueue({ fetch: async () => { calls++; throw new Error('503: busy'); }, onTile: () => {}, onChange: () => {}, now: () => now,
      schedule: (fn, ms) => { const entry = { at: now + ms, fn }; scheduled.add(entry); return () => { scheduled.delete(entry); }; } });
    queue.update([request()]); await settle();
    for (let i = 0; i < 60; i++) queue.update([request()]);
    expect(calls).toBe(1); expect(queue.failed('a')).toBe(true); expect(scheduled.size).toBe(1);
    for (let i = 0; i < 4; i++) { const entry = [...scheduled][0]; now = entry.at; scheduled.delete(entry); entry.fn(); await settle(); }
    expect(calls).toBe(5); expect(scheduled.size).toBe(0);
    queue.update([request()]); await settle(); expect(calls).toBe(5);
    queue.reset(); expect(scheduled.size).toBe(0);
  });
  test('reset prevents callbacks and aborts work on unmount', async () => {
    let signal!: AbortSignal, resolve!: (tile: DensityTile) => void, deliveries = 0;
    const queue = new DensityTileQueue({ fetch: (_, s) => { signal = s; return new Promise(r => resolve = r); }, onTile: () => deliveries++, onChange: () => deliveries++ });
    queue.update([request()]); queue.reset(); expect(signal.aborted).toBe(true);
    resolve(tile()); await settle(); expect(deliveries).toBe(0);
  });
  test('new visible work preempts a neighbour that remains in the keep range', () => {
    const flights: { key: string; signal: AbortSignal }[] = [];
    const queue = new DensityTileQueue({ fetch: (req, signal) => { flights.push({ key: req.key, signal }); return new Promise(() => {}); }, onTile: () => {}, onChange: () => {} });
    const neighbour = { ...request('neighbour'), visible: false };
    queue.update([neighbour]);
    queue.update([request('visible'), neighbour]);
    expect(flights[0].signal.aborted).toBe(true);
    expect(flights.map(flight => flight.key)).toEqual(['neighbour', 'visible']);
    queue.update([request('another-visible'), request('visible')]);
    expect(flights[1].signal.aborted).toBe(false);
    expect(flights).toHaveLength(2);
    queue.reset();
  });
});
