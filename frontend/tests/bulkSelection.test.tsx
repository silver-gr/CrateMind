import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { renderToString } from "react-dom/server";
import * as virtual from "@tanstack/react-virtual";
import TrackTable from "../src/components/TrackTable";
import { preferenceStorage } from "../src/lib/preferenceStorage";
import { buildBatchRequest, confirmText, rangeSelect, withDryRun } from "../src/lib/selection";
import type { Track } from "../src/lib/types";

const ids = [10, 11, 12, 13, 14];

describe("rangeSelect", () => {
  test("a plain click toggles one row and moves the anchor", () => {
    const first = rangeSelect(ids, new Set(), null, 1, false);
    expect([...first.selected]).toEqual([11]);
    expect(first.anchor).toBe(1);
    const off = rangeSelect(ids, first.selected, first.anchor, 1, false);
    expect(off.selected.size).toBe(0);
  });

  test("shift sets the whole range from the anchor to the clicked row", () => {
    const range = rangeSelect(ids, new Set([11]), 1, 3, true);
    expect([...range.selected].sort()).toEqual([11, 12, 13]);
  });

  test("shift onto a selected end clears the range", () => {
    const cleared = rangeSelect(ids, new Set([11, 12, 13]), 1, 3, true);
    expect(cleared.selected.size).toBe(0);
  });

  test("shift without an anchor acts on the clicked row only", () => {
    expect([...rangeSelect(ids, new Set(), null, 2, true).selected]).toEqual([12]);
  });
});

describe("batch requests", () => {
  test("the selected scope sends sorted track ids and no query", () => {
    const req = buildBatchRequest({
      scope: "selected", selectedIds: new Set([3, 1]), query: "ambient", mode: "add", tagIds: [7], profile: {}, dryRun: true,
    });
    expect(req.track_ids).toEqual([1, 3]);
    expect("query" in req).toBe(false);
    expect(req.add_tag_ids).toEqual([7]);
    expect(req.dry_run).toBe(true);
  });

  test("the all scope sends the query and no track ids; remove fills remove_tag_ids", () => {
    const req = buildBatchRequest({
      scope: "all", selectedIds: new Set([3]), query: "ambient", mode: "remove", tagIds: [7, 8], profile: { energy: 4 }, dryRun: false,
    });
    expect(req.query).toBe("ambient");
    expect("track_ids" in req).toBe(false);
    expect(req.remove_tag_ids).toEqual([7, 8]);
    expect("add_tag_ids" in req).toBe(false);
    expect(req.profile).toEqual({ energy: 4 });
    expect(req.dry_run).toBe(false);
  });

  test("the all scope keeps an empty query (whole library)", () => {
    const req = buildBatchRequest({ scope: "all", selectedIds: new Set(), query: "", mode: "add", tagIds: [7], profile: {}, dryRun: true });
    expect(req.query).toBe("");
  });

  test("confirmText states the server's counts", () => {
    expect(confirmText({ matched: 120, replaced: 7 }))
      .toBe("Θα αλλάξουν 120 κομμάτια. Θα αντικατασταθούν 7 τιμές μονής επιλογής.");
    expect(confirmText({ matched: 120, replaced: 0 })).toBe("Θα αλλάξουν 120 κομμάτια.");
  });

  test("withDryRun only flips dry_run", () => {
    const req = { track_ids: [1, 2], query: undefined, add_tag_ids: [7], remove_tag_ids: [8], profile: { valence: 3 }, dry_run: true };
    expect(withDryRun(req, false)).toEqual({ ...req, dry_run: false });
  });
});

describe("TrackTable selection column", () => {
  let virtualizerSpy: ReturnType<typeof spyOn> | undefined;
  let storageSpy: ReturnType<typeof spyOn> | undefined;
  afterEach(() => {
    virtualizerSpy?.mockRestore();
    storageSpy?.mockRestore();
  });

  const tracks: Track[] = [1, 2].map(id => ({
    id, file_name: `t${id}.wav`, absolute_path: `/t${id}.wav`, extension: "wav", title: `T${id}`, play_count: 0, missing: false,
  }));

  function render(selection: boolean) {
    virtualizerSpy = spyOn(virtual, "useVirtualizer").mockImplementation((options: any) => ({
      getTotalSize: () => options.count * options.estimateSize(),
      getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({
        index, size: options.estimateSize(), start: options.scrollMargin + index * options.estimateSize(),
      })),
      scrollToIndex: () => {},
    }) as any);
    storageSpy = spyOn(preferenceStorage, "getItem").mockImplementation(() => null);
    return renderToString(<TrackTable tracks={tracks} variant="full" onSelect={() => {}} onPlay={() => {}}
      {...(selection ? { selectedIds: new Set([1]), onSelectionChange: () => {} } : {})} />);
  }

  test("with the selection props each row gets a checkbox in a leading 32px column", () => {
    const html = render(true);
    const boxes = [...html.matchAll(/<input[^>]*aria-label="Επιλογή κομματιού"[^>]*>/g)].map(m => m[0]);
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toContain("checked");
    expect(boxes[1]).not.toContain("checked");
    const grids = [...html.matchAll(/grid-template-columns:([^";]+)/g)].map(match => match[1]);
    for (const grid of grids) expect(grid.startsWith("32px ")).toBe(true);
  });

  test("without the props there is no checkbox", () => {
    const html = render(false);
    expect(html).not.toContain('type="checkbox"');
    const grids = [...html.matchAll(/grid-template-columns:([^";]+)/g)].map(match => match[1]);
    for (const grid of grids) expect(grid.startsWith("40px ")).toBe(true);
  });
});
