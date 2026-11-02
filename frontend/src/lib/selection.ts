import type { BatchEditRequest, Profile } from "./types";

/**
 * Checkbox selection over the rendered rows. A plain click toggles `ids[index]`
 * and moves the anchor; Shift sets every row between the anchor and `index` to
 * the opposite of the clicked row's current state. The anchor is a track id, so
 * a re-sort or reload keeps it on the same track; an anchor that left the list,
 * or an empty selection (new query, applied bulk edit), acts on the clicked row only.
 */
export function rangeSelect(
  ids: readonly number[],
  selected: ReadonlySet<number>,
  anchor: number | null,
  index: number,
  shift: boolean,
): { selected: Set<number>; anchor: number } {
  const next = new Set(selected);
  const value = !selected.has(ids[index]);
  const anchorIndex = anchor === null || selected.size === 0 ? -1 : ids.indexOf(anchor);
  if (!shift || anchorIndex < 0) {
    if (value) next.add(ids[index]);
    else next.delete(ids[index]);
    return { selected: next, anchor: ids[index] };
  }
  const [from, to] = anchorIndex <= index ? [anchorIndex, index] : [index, anchorIndex];
  for (let i = from; i <= to; i++) {
    if (value) next.add(ids[i]);
    else next.delete(ids[i]);
  }
  return { selected: next, anchor: anchor! };
}

export type BatchScope = "selected" | "all";

/** One bulk request: the selected scope sends `track_ids`, the all scope sends `query`, never both. */
export function buildBatchRequest(args: {
  scope: BatchScope;
  selectedIds: ReadonlySet<number>;
  query: string;
  mode: "add" | "remove";
  tagIds: readonly number[];
  profile: Partial<Profile>;
  dryRun: boolean;
}): BatchEditRequest {
  const req: BatchEditRequest = args.scope === "selected"
    ? { track_ids: [...args.selectedIds].sort((a, b) => a - b) }
    : { query: args.query };
  if (args.tagIds.length) req[args.mode === "add" ? "add_tag_ids" : "remove_tag_ids"] = [...args.tagIds];
  if (Object.keys(args.profile).length) req.profile = { ...args.profile };
  req.dry_run = args.dryRun;
  return req;
}

/** The confirmation sentence built from the server's dry-run counts. */
export function confirmText({ matched, replaced }: { matched: number; replaced: number }): string {
  const n = (value: number) => value.toLocaleString("el-GR");
  const tracks = matched === 1 ? "Θα αλλάξει 1 κομμάτι." : `Θα αλλάξουν ${n(matched)} κομμάτια.`;
  if (!replaced) return tracks;
  const values = replaced === 1
    ? "Θα αντικατασταθεί 1 τιμή μονής επιλογής."
    : `Θα αντικατασταθούν ${n(replaced)} τιμές μονής επιλογής.`;
  return `${tracks} ${values}`;
}

/** The previewed request with only `dry_run` changed, so the confirmed write is exactly what was counted. */
export function withDryRun(req: BatchEditRequest, dryRun: boolean): BatchEditRequest {
  return { ...req, dry_run: dryRun };
}
