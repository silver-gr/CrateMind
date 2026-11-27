import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { Segmented, segmentedValueAt } from "../src/components/ui/Segmented";
import { blocksTrackDrag } from "../src/components/SetTimeline";
import {
  lacksProfileFields, patchRowsProfile, patchTrackProfile, ratingAction, ratingAxes, ratingTitle, statusAction, statusChoices,
} from "../src/lib/fastRating";
import { DEFAULT_PREFS } from "../src/lib/prefs";
import { writeTagAction, type TagWriteIo } from "../src/lib/tagKeys";
import type { SetTrackRow, Track } from "../src/lib/types";

// player.tsx pulls in playbackAudio, whose worklet URL import only resolves under Vite (as in deckSlots.test.ts).
mock.module("../src/lib/audio/peak-limiter.worklet.js?worker&url", () => ({ default: "/test/peak-limiter.worklet.js" }));
const { emptySlots, patchSlotsTrack } = await import("../src/lib/player");

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const track = (over: Partial<Track> = {}): Track => ({
  id: 7, file_name: "song.mp3", absolute_path: "/fixture/song.mp3", extension: ".mp3", title: "Song", play_count: 0, missing: false,
  personal_status: "testing", energy: 6, darkness: 3, valence: null, ...over,
});

describe("Segmented reads the pointer's x over the whole meter", () => {
  test("5%, 55% and 99% of the width give 1, 6 and 10", () => {
    expect(segmentedValueAt(5, 100, 10)).toBe(1);
    expect(segmentedValueAt(55, 100, 10)).toBe(6);
    expect(segmentedValueAt(99, 100, 10)).toBe(10);
  });

  test("the gaps and the edges count; a meter with no width gives nothing", () => {
    expect(segmentedValueAt(0, 80, 10)).toBe(1);
    expect(segmentedValueAt(80, 80, 10)).toBe(10);
    expect(segmentedValueAt(-3, 80, 10)).toBe(1);
    expect(segmentedValueAt(84, 80, 10)).toBe(10);
    expect(segmentedValueAt(40, 0, 10)).toBeNull();
  });

  test("the press is read by the row, so the space above and below the dots counts; without onChange it is display only", () => {
    const live = renderToStaticMarkup(createElement(Segmented, { value: 4, onChange: () => {}, className: "h-3", ariaLabel: "Ενέργεια" }));
    expect(live).toMatch(/^<div role="meter"[^>]*class="[^"]*h-3/);
    expect(live.match(/<button/g)).toHaveLength(10); // keyboard users still reach each value
    const still = renderToStaticMarkup(createElement(Segmented, { value: 4, ariaLabel: "Ενέργεια" }));
    expect(still).not.toContain("<button");
    expect(still).not.toContain("cursor-pointer");
    // The row's handler is the pointer path; a dot's own click only answers the keyboard (detail 0).
    const code = source("components/ui/Segmented.tsx");
    expect(code).toContain("segmentedValueAt(event.clientX - rect.left, rect.width, max)");
    expect(code).toContain("onClick={event => { if (event.detail === 0) onChange(i + 1); }}");
  });
});

describe("deck strip actions", () => {
  test("energy and darkness (valence in therapy), each click the digit key's action", () => {
    expect(ratingAxes("dj")).toEqual(["energy", "darkness"]);
    expect(ratingAxes("therapy")).toEqual(["energy", "valence"]);
    expect(ratingAction("energy", 8, "dj")).toEqual({ patch: { energy: 8 }, label: "ενέργεια 8", optimistic: false });
    expect(ratingAction("darkness", 10, "dj")?.patch).toEqual({ darkness: 10 });
    expect(ratingAction("valence", 3, "therapy")?.patch).toEqual({ valence: 3 });
    expect([ratingAction("energy", 0), ratingAction("energy", 11), ratingAction("energy", 2.5)]).toEqual([null, null, null]);
  });

  test("the status menu ends with «Καμία», which writes «unknown»", () => {
    const dj = statusChoices("dj");
    expect(dj.at(-1)).toEqual({ status: "unknown", label: "Καμία" });
    expect(dj.map(c => c.status)).toEqual(["testing", "approved", "weapon", "retired", "avoid", "unknown"]);
    expect(statusChoices("therapy").map(c => c.status)).not.toContain("weapon");
    expect(statusAction("unknown", "dj")).toEqual({ patch: { personal_status: "unknown" }, label: "καμία κατάσταση", optimistic: true });
    expect(statusAction("weapon", "dj").label).toBe("BANGER");
  });

  test("tooltips name the field, with or without a value", () => {
    expect(ratingTitle("energy", 7, "dj")).toBe("Ενέργεια 7");
    expect(ratingTitle("darkness", null, "dj")).toBe("Σκοτεινότητα: χωρίς τιμή");
  });

  test("a click writes once and the deck shows the new value from the event's patch, without a refetch", async () => {
    const calls: unknown[] = [];
    let slots = { ...emptySlots(), A: { track: track(), token: 3, autoPlay: false } };
    const io: TagWriteIo = {
      track: () => ({ id: 7, title: "Song", values: { energy: 6 } }),
      update: async (id, patch) => { calls.push(["update", id, patch]); },
      toast: { success: () => {}, error: () => {}, undo: () => {} },
      emit: (id, patch) => { slots = patchSlotsTrack(slots, id, t => patchTrackProfile(t, patch)); },
    };
    expect(await writeTagAction(ratingAction("energy", 9, "dj"), io, "dj")).toBe(true);
    expect(calls).toEqual([["update", 7, { energy: 9 }]]);
    expect(slots.A.track?.energy).toBe(9);
    expect(slots.A.track?.darkness).toBe(3);
    expect(slots.A.token).toBe(3); // the load effect does not fire, playback goes on
  });

  test("patchTrackProfile copies only the list fields, empty as null", () => {
    const out = patchTrackProfile(track(), { energy: null, notes: "x", personal_status: "approved" } as never);
    expect(out.energy).toBeNull();
    expect(out.personal_status).toBe("approved");
    expect("notes" in out).toBe(false);
  });

  test("a track without the shown fields (a set row's track) is read once; a list row is not", () => {
    expect(lacksProfileFields(track())).toBe(false);
    const bare: Track = { id: 1, file_name: "a", absolute_path: "/a", extension: ".mp3", play_count: 0, missing: false };
    expect(lacksProfileFields(bare)).toBe(true);
    expect(lacksProfileFields({ ...bare, energy: 5 })).toBe(true);
  });

  test("the switch is off by default and the strip renders nothing then", () => {
    expect(DEFAULT_PREFS.deckRating).toBe(false);
    const strip = source("components/DeckRatingStrip.tsx");
    expect(strip).toContain('const [on] = usePref("deckRating");');
    expect(strip).toContain("if (!on || !track) return null;");
  });

  test("until a track's missing fields are read back, a click writes with no undo (it would empty an unseen value)", () => {
    const strip = source("components/DeckRatingStrip.tsx");
    expect(strip).toContain("return { shown, known: !needsRead || read?.id === track.id };");
    expect(strip).toContain("known ? shown : undefined");
  });
});

describe("Set Builder energy column", () => {
  const row = (position: number, id: number, energy: number | null): SetTrackRow =>
    ({ position, track: track({ id }), profile: energy == null ? null : { track_id: id, energy } });

  test("a write patches every occurrence of the track, a row without a profile too", () => {
    const rows = [row(0, 7, null), row(1, 8, 4), row(2, 7, null)];
    const out = patchRowsProfile(rows, 7, { energy: 8 });
    expect(out.map(r => r.profile?.energy ?? null)).toEqual([8, 4, 8]);
    expect(out[1]).toBe(rows[1]);
    expect(patchRowsProfile(rows, 99, { energy: 1 })).toBe(rows);
  });

  test("a press on the meter or the grip never starts the card's drag onto a deck; the rest of the card does", () => {
    const el = (selectors: string[]) => ({ closest: (sel: string) => (sel.split(", ").some(s => selectors.includes(s)) ? {} : null) });
    expect(blocksTrackDrag(el(["[data-no-track-drag]"]))).toBe(true);
    expect(blocksTrackDrag(el(["[data-reorder-grip]"]))).toBe(true);
    expect(blocksTrackDrag(el([]))).toBe(false);
    expect(blocksTrackDrag(null)).toBe(false);
  });
});
