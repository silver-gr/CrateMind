import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { forgetSetTarget, lastSetTarget, orderSetTargets, rememberSetTarget } from "../src/lib/setTargets";
import SetTimeline from "../src/components/SetTimeline";
import { deleteSetMessage } from "../src/components/DeleteSetDialog";
import type { DJSet, SetTrackRow, Track } from "../src/lib/types";

const sets: DJSet[] = [1, 2, 3, 4, 5].map(id => ({ id, title: `Set ${id}` }));
const ids = (list: DJSet[]) => list.map(set => set.id);

test("targets leave out the open set: session targets first (last on top), then newest first", () => {
  expect(ids(orderSetTargets(sets, 3, "", []))).toEqual([5, 4, 2, 1]);
  expect(ids(orderSetTargets(sets, 3, "", [1, 4]))).toEqual([1, 4, 5, 2]);
  expect(ids(orderSetTargets(sets, null, "", [3]))).toEqual([3, 5, 4, 2, 1]);
});

test("the filter matches titles without case", () => {
  const named: DJSet[] = [{ id: 1, title: "Πρωινό Psy" }, { id: 2, title: "Βραδινό" }, { id: 3, title: "PSY draft" }];
  expect(ids(orderSetTargets(named, null, " psy ", []))).toEqual([3, 1]);
  expect(ids(orderSetTargets(named, null, "ΠΡΩΙΝΌ", []))).toEqual([1]);
  expect(ids(orderSetTargets(named, null, "techno", []))).toEqual([]);
});

test("the session remembers the last target and forgets a deleted one", () => {
  rememberSetTarget(2);
  rememberSetTarget(4);
  rememberSetTarget(2);
  expect(lastSetTarget()).toBe(2);
  expect(ids(orderSetTargets(sets, null))).toEqual([2, 4, 5, 3, 1]);
  forgetSetTarget(2);
  expect(lastSetTarget()).toBe(4);
  forgetSetTarget(4);
  expect(lastSetTarget()).toBeNull();
});

test("the delete confirmation names the set and its track count and keeps the tracks", () => {
  expect(deleteSetMessage("Draft", 1)).toContain("«Draft» (1 track)");
  expect(deleteSetMessage("Draft", 12)).toContain("(12 tracks)");
  expect(deleteSetMessage("Draft", 0)).toContain("Τα tracks μένουν στη βιβλιοθήκη.");
});

test("each set row renders the extra row action before its remove button", () => {
  const track = { id: 7, title: "Seven", file_name: "seven.wav" } as Track;
  const rows = [{ position: 0, note: null, track, profile: null }] as unknown as SetTrackRow[];
  const noop = () => {};
  const html = renderToString(<SetTimeline rows={rows} pairNotes={{}} onReorder={noop} onMove={noop} onRemove={noop}
    onPlay={noop} onBridge={noop} onAddPairNote={noop} rowAction={t => <span data-row-action={t.id} />} />);
  const action = html.indexOf('data-row-action="7"');
  expect(action).toBeGreaterThan(-1);
  expect(action).toBeLessThan(html.indexOf('aria-label="Αφαίρεση από set"'));
});
