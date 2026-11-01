import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { acquireDetailWaveform, frameTime, parseDetailWaveform } from '../src/lib/detailWaveform';

const dir = '../../backend/tests/fixtures/waveform_detail/';
const bin = readFileSync(fileURLToPath(new URL(dir + 'golden.bin', import.meta.url)));
const golden = JSON.parse(readFileSync(fileURLToPath(new URL(dir + 'golden.json', import.meta.url)), 'utf8'));
const buffer = () => bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer;

describe('CMWD parser (shared golden fixture)', () => {
  test('decodes golden.bin to golden.json', () => {
    const w = parseDetailWaveform(buffer());
    expect({
      version: w.version, sample_rate: w.sampleRate, hop: w.hop, win: w.win, frames: w.frames, duration: w.duration,
      digest_hex: w.digestHex, byte_length: bin.byteLength,
      full: Array.from(w.full), low: Array.from(w.low), mid: Array.from(w.mid), high: Array.from(w.high),
    }).toEqual(golden);
  });
  test('frame i is centred at (i*hop + win/2)/sample_rate', () => {
    const w = parseDetailWaveform(buffer());
    expect(frameTime(w, 2)).toBeCloseTo((2 * 294 + 512) / 44100);
  });
  test('rejects bad magic, version and length', () => {
    const bad = (mutate: (b: Uint8Array) => void) => { const b = new Uint8Array(buffer()); mutate(b); return b.buffer as ArrayBuffer; };
    expect(() => parseDetailWaveform(bad(b => { b[0] = 0; }))).toThrow('magic');
    expect(() => parseDetailWaveform(bad(b => { b[4] = 2; }))).toThrow('version');
    expect(() => parseDetailWaveform(buffer().slice(0, 70))).toThrow('length');
    expect(() => parseDetailWaveform(new ArrayBuffer(10))).toThrow('size');
  });
});

describe('client cache', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const respond = (calls: Request[] | { url: string; inm: string | null }[], status: number) => (async (url: unknown, init?: RequestInit) => {
    (calls as { url: string; inm: string | null }[]).push({ url: String(url), inm: new Headers(init?.headers).get('If-None-Match') });
    return status === 304 ? new Response(null, { status: 304 }) : new Response(buffer(), { status: 200, headers: { ETag: '"sig"' } });
  }) as typeof fetch;

  test('same revision hits memory; a new revision revalidates with the ETag and a 304 reuses the buffer', async () => {
    const calls: { url: string; inm: string | null }[] = [];
    globalThis.fetch = respond(calls, 200);
    const first = await acquireDetailWaveform(901, 1).promise;
    expect(calls).toEqual([{ url: '/api/tracks/901/waveform/detail', inm: null }]);
    expect(await acquireDetailWaveform(901, 1).promise).toBe(first);
    expect(calls.length).toBe(1);
    globalThis.fetch = respond(calls, 304);
    expect(await acquireDetailWaveform(901, 2).promise).toBe(first);
    expect(calls[1].inm).toBe('"sig"');
  });
  test('releasing the last holder aborts a stale request', async () => {
    let aborted = false;
    globalThis.fetch = ((_: unknown, init?: RequestInit) => new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('x', 'AbortError')); });
    })) as typeof fetch;
    const a = acquireDetailWaveform(902, 1);
    const b = acquireDetailWaveform(902, 1);
    a.release();
    expect(aborted).toBe(false);
    b.release();
    expect(aborted).toBe(true);
    await expect(b.promise).rejects.toThrow();
  });
});
