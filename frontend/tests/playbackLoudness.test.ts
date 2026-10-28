import { afterEach, expect, test } from "bun:test";
import { fetchPlaybackLoudness } from "../src/lib/playbackLoudness";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("loudness fetch preserves the track ID and abort signal", async () => {
  const controller = new AbortController();
  globalThis.fetch = (async (url, init) => {
    expect(url).toBe("/api/tracks/17/playback-loudness");
    expect(init?.signal).toBe(controller.signal);
    return Response.json({ status: "ready", gain_db: -6, integrated_lufs: -12, true_peak_dbfs: -1, target_lufs: -18 });
  }) as typeof fetch;
  expect((await fetchPlaybackLoudness(17, controller.signal)).gain_db).toBe(-6);
});

test("aborting a busy request stops retrying an old selection", async () => {
  const controller = new AbortController();
  let calls = 0;
  globalThis.fetch = (async () => { calls++; controller.abort(); return new Response(null, { status: 503 }); }) as typeof fetch;
  await expect(fetchPlaybackLoudness(1, controller.signal)).rejects.toThrow("Aborted");
  expect(calls).toBe(1);
});

test("unsafe or malformed gain responses are rejected", async () => {
  for (const value of [{ status: "ready", gain_db: 30 }, { status: "ready", gain_db: "5" },
    { status: "silent", gain_db: 5 }, { status: "invalid", gain_db: 0 }]) {
    globalThis.fetch = (async () => Response.json(value)) as typeof fetch;
    await expect(fetchPlaybackLoudness(1, new AbortController().signal)).rejects.toThrow("Invalid loudness response");
  }
});
