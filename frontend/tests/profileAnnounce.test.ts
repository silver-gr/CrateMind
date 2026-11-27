import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { api } from "../src/lib/api";
import { patchTrackProfile } from "../src/lib/fastRating";
import { PROFILE_UPDATED, announceProfile, type ProfileUpdatedDetail } from "../src/lib/profileUpdates";
import { queueRowFields } from "../src/lib/queuePaging";
import type { BatchEditRequest, Profile, Track } from "../src/lib/types";

// player.tsx pulls in playbackAudio, whose worklet URL import only resolves under Vite (as in deckSlots.test.ts).
mock.module("../src/lib/audio/peak-limiter.worklet.js?worker&url", () => ({ default: "/test/peak-limiter.worklet.js" }));
const { emptySlots, patchSlotsTrack } = await import("../src/lib/player");

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const track = (id: number, over: Partial<Track> = {}): Track => ({
  id, file_name: `t${id}.mp3`, absolute_path: `/fixture/t${id}.mp3`, extension: ".mp3", title: `T${id}`, play_count: 0, missing: false,
  personal_status: "testing", energy: 6, darkness: 3, valence: null, ...over,
});

// Deck A holds track 7 and Deck B track 8; the listener is the player's own (lib/player.tsx onProfileUpdated).
let slots = emptySlots();
let events: ProfileUpdatedDetail[] = [];
const savedWindow = globalThis.window;
const savedFetch = globalThis.fetch;
beforeEach(() => {
  slots = { ...emptySlots(), A: { track: track(7), token: 1, autoPlay: false }, B: { track: track(8), token: 2, autoPlay: false } };
  events = [];
  const target = new EventTarget();
  target.addEventListener(PROFILE_UPDATED, e => {
    const detail = (e as CustomEvent<ProfileUpdatedDetail>).detail;
    events.push(detail);
    if (detail?.patch) slots = patchSlotsTrack(slots, detail.trackId, t => patchTrackProfile(t, detail.patch!));
  });
  globalThis.window = target as never;
});
afterEach(() => { globalThis.window = savedWindow; globalThis.fetch = savedFetch; });

/** A fake backend: the bulk write (a real one names its scope's tracks, as bulk_edit.run_batch does) and every request seen. */
function backend(matched: number[] = [], fail = false) {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (fail) return new Response(JSON.stringify({ detail: "Δεν ζητήθηκε καμία αλλαγή." }), { status: 422 });
    const body = JSON.parse(String(init!.body)) as BatchEditRequest;
    const ids = body.track_ids ?? matched;
    if (body.dry_run) return Response.json({ updated: 0, matched: ids.length, replaced: 0, dry_run: true });
    return Response.json({ updated: ids.length, matched: ids.length, replaced: 0, dry_run: false, track_ids: ids });
  }) as typeof fetch;
  return calls;
}

describe("the track editor's save", () => {
  test("the Library announces the stored profile's list fields once its read is back", () => {
    const library = source("pages/Library.tsx");
    expect(library).toMatch(/api\.getTrack\(id\)\.then\(detail => \{\s*announceProfile\(id, queueRowFields\(detail\.profile\)\);/);
  });

  test("that announcement reaches the loaded deck's track; the other deck is untouched", () => {
    const stored = { track_id: 7, personal_status: "approved", energy: 9, darkness: 2, notes: "x" } as Profile;
    announceProfile(7, queueRowFields(stored));
    expect(slots.A.track).toMatchObject({ personal_status: "approved", energy: 9, darkness: 2, valence: null });
    expect("notes" in slots.A.track!).toBe(false);
    expect(slots.A.token).toBe(1); // no reload, playback goes on
    expect(slots.B.track).toEqual(track(8));
  });
});

describe("the track menu's status change", () => {
  test("the default write announces the status it wrote, after the server has it", () => {
    const menu = source("lib/menus/useTrackMenu.tsx");
    expect(menu).toMatch(/api\.updateProfile\(track\.id, \{ personal_status: status \}\)\.then\(\(\) => \{\s*announceProfile\(track\.id, \{ personal_status: status \}\);/);
  });

  test("that announcement reaches the loaded deck's track only", () => {
    announceProfile(8, { personal_status: "weapon" });
    expect(slots.B.track?.personal_status).toBe("weapon");
    expect(slots.B.track?.energy).toBe(6);
    expect(slots.A.track).toEqual(track(7));
  });
});

describe("a bulk edit", () => {
  test("of the checked tracks announces every one of them with the fields written", async () => {
    const calls = backend();
    await api.batchEdit({ track_ids: [7, 12, 30], profile: { energy: 4 }, dry_run: false });
    expect(calls.map(c => c.method)).toEqual(["POST"]); // the ids are known: no read
    expect(events).toEqual([7, 12, 30].map(trackId => ({ trackId, patch: { energy: 4 } })));
    expect(slots.A.track?.energy).toBe(4);
    expect(slots.B.track).toEqual(track(8));
  });

  test("of a query announces each track the write's result names, with no read of its own", async () => {
    const calls = backend([8, 21]);
    await api.batchEdit({ query: "energy:5", profile: { darkness: 9, personal_status: "approved" }, dry_run: false });
    expect(calls.map(c => c.method)).toEqual(["POST"]);
    expect(events.map(e => e.trackId)).toEqual([8, 21]);
    expect(slots.B.track).toMatchObject({ darkness: 9, personal_status: "approved", energy: 6 });
    expect(slots.A.track).toEqual(track(7));
  });

  test("the whole library («Όλα» with no query) is announced from the result too", async () => {
    const calls = backend([7, 8]);
    await api.batchEdit({ query: "", profile: { energy: 2 }, dry_run: false });
    expect(calls.map(c => c.method)).toEqual(["POST"]);
    expect(events.map(e => e.trackId)).toEqual([7, 8]);
  });

  test("a dry run, a tags-only edit and a refused write announce nothing", async () => {
    const calls = backend([7]);
    await api.batchEdit({ query: "", profile: { energy: 2 }, dry_run: true });
    await api.batchEdit({ track_ids: [7], add_tag_ids: [3], dry_run: false });
    expect(calls.map(c => c.method)).toEqual(["POST", "POST"]);
    backend([], true);
    await expect(api.batchEdit({ track_ids: [7], profile: { energy: 1 }, dry_run: false })).rejects.toThrow("422");
    expect(events).toEqual([]);
    expect(slots.A.track).toEqual(track(7));
  });
});
