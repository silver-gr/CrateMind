import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ANALYSIS_FINISHED, BPM_UPDATED } from "../src/lib/bpmUpdates";
import { FACETS_CHANGED } from "../src/lib/facets";
import {
  attachBlankListListeners, beginBlankFetch, blankList, clearBlankList, markBlankListStale, patchBlankRow, rememberBlankScroll,
  storeBlankList,
} from "../src/lib/libraryListCache";
import { PROFILE_UPDATED } from "../src/lib/profileUpdates";
import type { Track } from "../src/lib/types";

const track = (id: number, over: Partial<Track> = {}): Track => ({
  id, file_name: `t${id}.mp3`, absolute_path: `/fixture/t${id}.mp3`, extension: ".mp3", title: `T${id}`, play_count: 0, missing: false,
  personal_status: "testing", energy: 6, darkness: 3, ...over,
});
const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

let target: EventTarget;
let detach: () => void;
beforeEach(() => {
  clearBlankList();
  target = new EventTarget();
  detach = attachBlankListListeners(target);
});
afterEach(() => detach());

test("answers only the blank query, and nothing before a store", () => {
  expect(blankList()).toBeNull();
  storeBlankList([track(1), track(2)]);
  expect(blankList()?.rows.map(row => row.id)).toEqual([1, 2]);
  for (const q of ["sort:bpm", "limit:20", "energy:7-9", " "]) expect(blankList(q)).toBeNull();
});

test("a profile event patches only that row, and a row it does not hold changes nothing", () => {
  const rows = [track(1), track(2)];
  storeBlankList(rows);
  target.dispatchEvent(new CustomEvent(PROFILE_UPDATED, { detail: { trackId: 2, patch: { energy: 9, personal_status: "weapon" } } }));
  const after = blankList()!.rows;
  expect(after[0]).toBe(rows[0]);
  expect(after[1]).toMatchObject({ id: 2, energy: 9, personal_status: "weapon", darkness: 3 });
  expect(rows[1].energy).toBe(6); // the stored array is never mutated (React may hold it)
  target.dispatchEvent(new CustomEvent(PROFILE_UPDATED, { detail: { trackId: 99, patch: { energy: 1 } } }));
  expect(blankList()!.rows).toBe(after);
});

test("a manual BPM patches the row's BPM fields", () => {
  storeBlankList([track(1, { bpm_consensus: 70, bpm_consensus_sources: "tag" })]);
  target.dispatchEvent(new CustomEvent(BPM_UPDATED, { detail: { trackId: 1, fields: { bpm_consensus: 140, bpm_consensus_sources: "manual:x2" } } }));
  expect(blankList()!.rows[0]).toMatchObject({ bpm_consensus: 140, bpm_consensus_sources: "manual:x2" });
});

test("a finished analysis and a facets change mark the list stale and keep its rows", () => {
  storeBlankList([track(1)]);
  expect(blankList()!.stale).toBe(false);
  target.dispatchEvent(new Event(ANALYSIS_FINISHED));
  expect(blankList()).toMatchObject({ stale: true, rows: [{ id: 1 }] });
  storeBlankList([track(1)]);
  expect(blankList()!.stale).toBe(false);
  target.dispatchEvent(new Event(FACETS_CHANGED));
  expect(blankList()!.stale).toBe(true);
});

test("an answer fetched before a write gets the write again, and an older answer never replaces a newer one", () => {
  storeBlankList([track(1)]);
  const slow = beginBlankFetch();
  patchBlankRow(1, row => ({ ...row, energy: 9 }));
  const shown = storeBlankList([track(1, { energy: 6 })], slow);
  expect(shown[0].energy).toBe(9);
  expect(blankList()!.rows[0].energy).toBe(9);

  const older = beginBlankFetch();
  const newer = beginBlankFetch();
  storeBlankList([track(1), track(2)], newer);
  storeBlankList([track(1)], older);
  expect(blankList()!.rows.map(row => row.id)).toEqual([1, 2]);
});

test("an answer fetched before more writes than the log holds is not stored", () => {
  storeBlankList([track(1, { energy: 9 })]);
  const slow = beginBlankFetch();
  // A bulk edit of 501 tracks: the log keeps the last 500, so the first write (track 1) can no longer be re-applied.
  patchBlankRow(1, row => ({ ...row, energy: 2 }));
  for (let id = 2; id <= 501; id += 1) patchBlankRow(id, row => row);
  storeBlankList([track(1, { energy: 9 })], slow);
  expect(blankList()!.rows[0].energy).toBe(2);
  // A fetch begun after the bulk edit is stored as usual.
  storeBlankList([track(1, { energy: 4 })]);
  expect(blankList()!.rows[0].energy).toBe(4);
});

test("a fetch started before a stale mark is stored as stale", () => {
  const ticket = beginBlankFetch();
  markBlankListStale();
  storeBlankList([track(1)], ticket);
  expect(blankList()!.stale).toBe(true);
});

test("the scroll offset is kept beside the rows across a refresh", () => {
  storeBlankList([track(1)]);
  rememberBlankScroll(920);
  storeBlankList([track(1)]);
  expect(blankList()!.scrollTop).toBe(920);
});

test("the Library shows the cached rows at once, refreshes in the background and keeps the rows on a failed refresh", () => {
  const library = source("pages/Library.tsx");
  // Initial state from the cache: no «Φόρτωση βιβλιοθήκης…» placeholder when rows are cached.
  expect(library).toContain("useState<Track[]>(() => blankList(appliedQuery)?.rows ?? [])");
  expect(library).toContain("useState(() => blankList(appliedQuery) === null)");
  // The mount refresh is a background one when rows were cached.
  expect(library).toContain("load(appliedQuery, cached !== null);");
  // Only a fetched answer is stored; the catch sets the error line and leaves `tracks` as they are.
  const loadBody = library.slice(library.indexOf("const load = useCallback"), library.indexOf("}, []);", library.indexOf("const load = useCallback")));
  expect(loadBody.indexOf("storeBlankList(")).toBeLessThan(loadBody.indexOf("catch (e)"));
  expect(loadBody.slice(loadBody.indexOf("catch (e)"))).not.toContain("setTracks");
  expect(loadBody).toContain("setError((e as Error).message)");
  // The page follows profile writes on screen too.
  expect(library).toContain("window.addEventListener(PROFILE_UPDATED, onProfileUpdated)");
});

test("the top bar follows every running job, and the analysis dialog's own end is not announced twice", () => {
  expect(source("components/layout/TopBar.tsx")).toContain("if (job) followAnalysisJob(job, api.scanStatus);");
  expect(source("components/AnalyzeBpmDialog.tsx")).toContain("claimAnalysisJob(started.id);");
});
