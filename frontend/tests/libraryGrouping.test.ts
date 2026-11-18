import { describe, expect, test } from "bun:test";
import { flattenGroups, groupTracks, stepVisible, type GroupContext, type TrackGroup } from "../src/lib/libraryGrouping";
import { sortTracks } from "../src/lib/trackSort";
import type { SearchMembership, Track } from "../src/lib/types";

function track(id: number, fields: Partial<Track> = {}): Track {
  return { id, file_name: `${id}.mp3`, absolute_path: `/lib/${id}.mp3`, play_count: 0, missing: false, ...fields };
}
const ctx = (over: Partial<GroupContext> = {}): GroupContext => ({
  profile: "dj", keyFormat: "camelot", crates: [], appliedQuery: "", ...over,
});
const shape = (groups: TrackGroup[]) => groups.map(g => [g.label, g.tracks.map(t => t.id)]);

describe("groupTracks", () => {
  test("status: ranked best first, a null status joins «άγνωστο», sorted order kept inside", () => {
    const sorted = [
      track(1, { personal_status: "testing" }),
      track(2, { personal_status: null }),
      track(3, { personal_status: "weapon" }),
      track(4, { personal_status: "unknown" }),
      track(5, { personal_status: "avoid" }),
      track(6, { personal_status: "overplayed" }),
    ];
    expect(shape(groupTracks(sorted, "status", ctx()))).toEqual([
      ["banger", [3]], ["δοκιμή", [1]], ["άγνωστο", [2, 4]], ["απόφυγε", [5]], ["πολυπαιγμένο", [6]],
    ]);
  });

  test("status: therapy merges weapon and approved in one group, keeping the sorted order", () => {
    const sorted = [
      track(1, { personal_status: "approved" }),
      track(2, { personal_status: "testing" }),
      track(3, { personal_status: "weapon" }),
      track(4, { personal_status: "approved" }),
    ];
    expect(shape(groupTracks(sorted, "status", ctx({ profile: "therapy" })))).toEqual([
      ["Εγκεκριμένο", [1, 3, 4]], ["Υπό δοκιμή", [2]],
    ]);
  });

  test("energy: 1 → 10 with the profile's axis name, «Χωρίς τιμή» last", () => {
    const sorted = [track(1, { energy: 9 }), track(2), track(3, { energy: 2 }), track(4, { energy: 9 })];
    expect(shape(groupTracks(sorted, "energy", ctx()))).toEqual([
      ["Ενέργεια 2", [3]], ["Ενέργεια 9", [1, 4]], ["Χωρίς τιμή", [2]],
    ]);
    expect(groupTracks(sorted, "energy", ctx({ profile: "therapy" }))[0].label).toBe("Διέγερση 2");
  });

  test("role and substyle: alphabetical by their Greek label", () => {
    const sorted = [track(1, { set_role: "peak" }), track(2, { set_role: "bridge" }), track(3), track(4, { set_role: "closer" })];
    expect(shape(groupTracks(sorted, "role", ctx()))).toEqual([
      ["γέφυρα", [2]], ["κλείσιμο", [4]], ["κορύφωση", [1]], ["Χωρίς τιμή", [3]],
    ]);
    const styles = [track(1, { psy_substyle: "full_on" }), track(2, { psy_substyle: "dark" })];
    expect(groupTracks(styles, "substyle", ctx()).map(g => g.tracks[0].id)).toEqual([2, 1]);
  });

  test("substyle: a track without one joins its confirmed artist's genre; its own substyle wins", () => {
    const sorted = [
      track(1, { psy_substyle: "hi-tech" }),
      track(2, { artist_substyle: "hi-tech" }),
      track(3, { psy_substyle: "darkpsy", artist_substyle: "hi-tech" }),
      track(4),
    ];
    expect(shape(groupTracks(sorted, "substyle", ctx())).map(([, ids]) => ids)).toEqual([[3], [1, 2], [4]]);
    expect(sortTracks(sorted, { key: "substyle", dir: "asc" }).map(t => t.id)).toEqual([3, 1, 2, 4]);
  });

  test("bpm: ascending 5-BPM bands on the rounded tempo", () => {
    const sorted = [track(1, { bpm: 149.6 }), track(2, { bpm: 149.4 }), track(3, { bpm: 145 }), track(4), track(5, { bpm: 138 })];
    expect(shape(groupTracks(sorted, "bpm", ctx()))).toEqual([
      ["135–139", [5]], ["145–149", [2, 3]], ["150–154", [1]], ["Χωρίς τιμή", [4]],
    ]);
  });

  test("key: Camelot order, labelled in the user's key format", () => {
    const sorted = [track(1, { key_text: "9A" }), track(2, { key_text: "Am" }), track(3, { key_analyzed: "1B" }), track(4), track(5, { key_text: "8A" })];
    expect(shape(groupTracks(sorted, "key", ctx()))).toEqual([
      ["1B", [3]], ["8A", [2, 5]], ["9A", [1]], ["Χωρίς τιμή", [4]],
    ]);
    expect(groupTracks(sorted, "key", ctx({ keyFormat: "musical" }))[1].label).toBe("Am");
  });

  test("genre: case-folded, alphabetical; year: newest first", () => {
    const sorted = [track(1, { genre: "Psytrance", year: 2020 }), track(2, { genre: "ambient", year: 2024 }), track(3, { genre: "psytrance " }), track(4, { year: 2020 })];
    expect(shape(groupTracks(sorted, "genre", ctx()))).toEqual([
      ["ambient", [2]], ["Psytrance", [1, 3]], ["Χωρίς τιμή", [4]],
    ]);
    expect(shape(groupTracks(sorted, "year", ctx()))).toEqual([
      ["2024", [2]], ["2020", [1, 4]], ["Χωρίς τιμή", [3]],
    ]);
  });

  test("folder: common prefix stripped, «Κύριος φάκελος» first, then subfolders alphabetically", () => {
    const sorted = [
      track(1, { absolute_path: "/music/lib/Psy/Dark/a.mp3" }),
      track(2, { absolute_path: "/music/lib/b.mp3" }),
      track(3, { absolute_path: "/music/lib/Ambient/c.mp3" }),
      track(4, { absolute_path: "/music/lib/Psy/Dark/d.mp3" }),
    ];
    expect(shape(groupTracks(sorted, "folder", ctx()))).toEqual([
      ["Κύριος φάκελος", [2]], ["Ambient", [3]], ["Psy/Dark", [1, 4]],
    ]);
  });

  test("folder: Windows paths, and a single folder keeps its own leaf name", () => {
    const windows = [
      track(1, { absolute_path: "C:\\Music\\Psy\\a.mp3" }),
      track(2, { absolute_path: "C:\\Music\\Goa\\b.mp3" }),
    ];
    expect(shape(groupTracks(windows, "folder", ctx()))).toEqual([["Goa", [2]], ["Psy", [1]]]);
    const single = [track(1, { absolute_path: "D:\\Sets\\Night\\a.mp3" }), track(2, { absolute_path: "D:\\Sets\\Night\\b.mp3" })];
    expect(shape(groupTracks(single, "folder", ctx()))).toEqual([["Night", [1, 2]]]);
  });

  test("crates: first matching crate wins, the rest under «Χωρίς crate», the open crate is skipped", () => {
    const crates: SearchMembership[] = [
      { id: 10, name: "Όλα τα approved", query: " status:approved ", track_ids: [1, 2, 3, 4] },
      { id: 11, name: "Peak", query: "role:peak", track_ids: [2, 3] },
      { id: 12, name: "Dark", query: "darkness:8+", track_ids: [3, 9] },
      { id: 13, name: "Empty", query: "energy:10", track_ids: [] },
    ];
    const sorted = [track(1), track(2), track(3), track(4), track(5)];
    expect(shape(groupTracks(sorted, "crates", ctx({ crates })))).toEqual([
      ["Όλα τα approved", [1, 2, 3, 4]], ["Χωρίς crate", [5]],
    ]);
    expect(shape(groupTracks(sorted, "crates", ctx({ crates, appliedQuery: "status:approved" })))).toEqual([
      ["Peak", [2, 3]], ["Χωρίς crate", [1, 4, 5]],
    ]);
  });
});

describe("flattenGroups", () => {
  const groups: TrackGroup[] = [
    { id: "a", label: "A", tracks: [track(1), track(2)] },
    { id: "b", label: "B", tracks: [track(3)] },
    { id: "c", label: "C", tracks: [track(4), track(5)] },
  ];

  test("collapsed groups contribute only their header; track rows index into view", () => {
    const flat = flattenGroups(groups, new Set(["b"]));
    expect(flat.view.map(t => t.id)).toEqual([1, 2, 4, 5]);
    expect(flat.order.map(t => t.id)).toEqual([1, 2, 3, 4, 5]);
    expect(flat.rows).toEqual([
      { kind: "header", groupId: "a", label: "A", count: 2, collapsed: false },
      { kind: "track", index: 0 },
      { kind: "track", index: 1 },
      { kind: "header", groupId: "b", label: "B", count: 1, collapsed: true },
      { kind: "header", groupId: "c", label: "C", count: 2, collapsed: false },
      { kind: "track", index: 2 },
      { kind: "track", index: 3 },
    ]);
    for (const row of flat.rows) if (row.kind === "track") expect(flat.view[row.index]).toBeDefined();
  });

  test("all collapsed still lists every header", () => {
    const flat = flattenGroups(groups, new Set(["a", "b", "c"]));
    expect(flat.view).toEqual([]);
    expect(flat.rows.map(r => r.kind)).toEqual(["header", "header", "header"]);
    expect(flat.order).toHaveLength(5);
  });
});

describe("stepVisible", () => {
  const order = [track(1), track(2), track(3), track(4), track(5)];
  const visible = new Set([1, 4, 5]); // 2 and 3 sit in a collapsed group

  test("steps across a collapsed group in both directions", () => {
    expect(stepVisible(order, visible, 2, 1)?.id).toBe(4);
    expect(stepVisible(order, visible, 3, -1)?.id).toBe(1);
    expect(stepVisible(order, visible, 1, 1)?.id).toBe(4);
  });

  test("null at both ends and for an unknown track", () => {
    expect(stepVisible(order, visible, 5, 1)).toBeNull();
    expect(stepVisible(order, new Set([4, 5]), 2, -1)).toBeNull();
    expect(stepVisible(order, visible, 99, 1)).toBeNull();
  });
});
