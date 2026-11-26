import { describe, expect, test } from "bun:test";
import { heldBackRoots, keeperReasonLabel, openPairs, pairKey, scanHeldBack, scanMissingCount } from "../src/lib/relink";
import { translateJobMessage } from "../src/lib/labels";
import type { MovedPair } from "../src/lib/types";

const HELD = "/Volumes/Music: λείπουν 4100 από τα 4728 tracks του φακέλου, δεν σημειώθηκε κανένα ότι λείπει (έλεγξε ότι ο δίσκος ή ο φάκελος είναι συνδεδεμένος)";

describe("scan guard", () => {
  test("finds the folders a scan held back", () => {
    const message = `added 0, updated 0, unchanged 628, missing 0, skipped duplicates 0; ${HELD}; /x: missing-file detection skipped (boom)`;
    expect(scanHeldBack(message)).toEqual([HELD]);
    expect(scanHeldBack("added 1, updated 0, unchanged 5, missing 3, skipped duplicates 0")).toEqual([]);
    expect(scanHeldBack(null)).toEqual([]);
  });

  test("the warning is the message's last part, after the analysis summary", () => {
    const message = `added 2, updated 0, unchanged 628, missing 0, skipped duplicates 0, analyzed 2, analysis failed 0; ${HELD}`;
    expect(scanHeldBack(message)).toEqual([HELD]);
    expect(translateJobMessage(message)).toEndWith(HELD);
  });

  test("the go-ahead rescans only the folders that were held back", () => {
    expect(heldBackRoots([HELD, `/a: b/x: λείπουν 30 από τα 40 tracks`])).toEqual(["/Volumes/Music", "/a: b/x"]);
  });

  test("the backend's note is the one the page looks for", async () => {
    const scanner = await Bun.file(`${import.meta.dir}/../../backend/app/services/scanner.py`).text();
    const note = /MASS_MISSING_NOTE = "([^"]+)"/.exec(scanner)?.[1];
    expect(note).toBeTruthy();
    expect(scanHeldBack(`added 0; /lib: ${note}`)).toHaveLength(1);
  });

  test("the Greek warning survives the job message translation", () => {
    const shown = translateJobMessage(`added 0, updated 0, unchanged 628, missing 0, skipped duplicates 0; ${HELD}`);
    expect(shown).toContain(HELD);
    expect(shown).toStartWith("Προστέθηκαν: 0");
  });

  test("reads how many tracks a scan marked as missing", () => {
    expect(scanMissingCount("added 1, updated 0, unchanged 5, missing 3, skipped duplicates 0, merged moved 1")).toBe(3);
    expect(scanMissingCount("added 1, updated 0, unchanged 5, missing 0, skipped duplicates 0")).toBe(0);
    expect(scanMissingCount("groups 2")).toBe(0);
    expect(scanMissingCount(undefined)).toBe(0);
  });
});

describe("moved tracks", () => {
  const track = (track_id: number) => ({ track_id, artist: null, title: null, duration: 300, extension: "mp3", absolute_path: `/lib/${track_id}.mp3` });
  const pairs: MovedPair[] = [{ old: track(1), new: track(11) }, { old: track(2), new: track(12) }];

  test("a declined pair stays out of the list, and only that pair", () => {
    expect(openPairs(pairs, [])).toEqual(pairs);
    expect(openPairs(pairs, [pairKey(pairs[0]), "2:99"])).toEqual([pairs[1]]);
  });
});

test("every keeper reason of the backend has Greek text", async () => {
  const detector = await Bun.file(`${import.meta.dir}/../../backend/app/services/duplicate_detector.py`).text();
  const reasons = /zip\(\(([^)]+)\)/.exec(detector)?.[1].match(/[a-z]+/g) ?? [];
  expect(reasons).toEqual(["lossless", "bitrate", "taste", "longer"]);
  for (const reason of reasons) expect(keeperReasonLabel(reason)).toMatch(/[Ͱ-Ͽ]/);
  expect(keeperReasonLabel("something_else")).toBe("");
});
