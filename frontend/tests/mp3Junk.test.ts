import { afterEach, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JUNK_BEFORE_AUDIO_MESSAGE, junkBeforeAudio } from "../src/lib/audio/mp3Junk";
import { HttpError, JunkBeforeAudioError } from "../src/lib/audio/stretchDeck";
import { installLocation, settle, setup, teardown } from "./stretchDeckFakes";

beforeAll(installLocation);
afterEach(teardown);

const id3 = (size = 64) => [0x49, 0x44, 0x33, 3, 0, 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f, ...new Array(size).fill(0)];
/** MPEG-1 Layer III, 128 kbps, 44.1 kHz: 417-byte frames. */
const frames = (n = 2) => Array.from({ length: n }, () => [0xff, 0xfb, 0x90, 0x00, ...new Array(413).fill(0)]).flat();
const bytes = (...parts: number[][]) => new Uint8Array(parts.flat());
const junk = (n: number) => Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0x7f);   // never a frame sync

test("a file whose audio follows its tag directly has no junk", () => {
  expect(junkBeforeAudio(bytes(id3(), frames()))).toBe(false);
  expect(junkBeforeAudio(bytes(id3(), id3(32), frames()))).toBe(false);    // two tags back to back
  expect(junkBeforeAudio(bytes(frames()))).toBe(false);                    // no tag at all
});

test("leftover bytes between the tag and the audio are found", () => {
  expect(junkBeforeAudio(bytes(id3(), junk(30_000), frames()))).toBe(true);
});

test("a file that is not MPEG audio after its tag is not called junk", () => {
  expect(junkBeforeAudio(bytes(id3(), junk(5000)))).toBe(false);
  expect(junkBeforeAudio(bytes(id3(), [0x66, 0x4c, 0x61, 0x43], junk(500)))).toBe(false);   // fLaC
});

test("the deck explains a file it cannot decode because of junk, and does not hand it to the element", async () => {
  const { ctx, deck } = setup();
  const file = bytes(id3(), junk(20_000), frames());
  globalThis.fetch = (async () => ({ ok: true, status: 200, arrayBuffer: async () => file.slice().buffer })) as unknown as typeof fetch;
  ctx.hold = true;
  deck.src = "/api/tracks/1833/audio";
  deck.load();
  await settle();
  ctx.held.shift()!.reject(new DOMException("Decoding failed", "EncodingError"));
  await settle();
  expect(deck.error).toBeInstanceOf(JunkBeforeAudioError);
  expect(deck.error).toBeInstanceOf(HttpError);              // MiniPlayer retries everything else on the element
  expect((deck.error as Error).message).toBe(JUNK_BEFORE_AUDIO_MESSAGE);
});

test("any other decode failure keeps its own error", async () => {
  const { ctx, deck } = setup();
  ctx.hold = true;
  deck.src = "/api/tracks/1/audio";
  deck.load();
  await settle();
  ctx.held.shift()!.reject(new Error("decode failed"));
  await settle();
  expect(deck.error).not.toBeInstanceOf(HttpError);
});

test("the player shows the junk explanation instead of the generic load error", () => {
  const player = readFileSync(new URL("../src/components/MiniPlayer.tsx", import.meta.url), "utf8");
  expect(player).toContain("engineRef.current?.error instanceof JunkBeforeAudioError ? engineRef.current.error.message :");
});
