/**
 * Library «Ομαδοποίηση»: splits the already sorted track list into collapsible
 * sections. Pure helpers; Library.tsx owns the choice, the collapsed set and
 * the crate membership fetch.
 */
import { formatKey, type KeyFormat, fallbackKey } from "./camelot";
import { axisLabel, statusLabel, valueLabel } from "./labels";
import type { LibraryProfile } from "./prefs";
import { effectiveBpm } from "./tempo";
import { STATUS_RANK, keyOrder } from "./trackSort";
import type { SearchMembership, Track } from "./types";

export type GroupKey =
  | "none" | "status" | "energy" | "role" | "substyle" | "bpm" | "key" | "genre" | "year" | "folder" | "crates";

export const GROUP_KEYS: readonly GroupKey[] = [
  "none", "status", "energy", "role", "substyle", "bpm", "key", "genre", "year", "folder", "crates",
];

export interface TrackGroup {
  id: string;
  label: string;
  tracks: Track[];
}

export interface GroupContext {
  profile: LibraryProfile;
  keyFormat: KeyFormat;
  /** Crate membership in crate-list order («Crates» mode only). */
  crates: readonly SearchMembership[];
  /** The query the list was loaded with; a crate with the same query would catch every track. */
  appliedQuery: string;
}

export type GroupRow =
  | { kind: "header"; groupId: string; label: string; count: number; collapsed: boolean }
  | { kind: "track"; index: number };

export interface FlatGroups {
  /** Visible tracks in display order (collapsed groups left out). */
  view: Track[];
  /** Header and track rows; a track row's `index` points into `view`. */
  rows: GroupRow[];
  /** Every grouped track in group order, collapsed or not. */
  order: Track[];
}

const NO_VALUE_ID = "none";
const NO_VALUE_LABEL = "Χωρίς τιμή";
const ROOT_FOLDER_LABEL = "Κύριος φάκελος";
const UNSORTED_LABEL = "Χωρίς crate";
/** A status missing from STATUS_RANK sorts below every ranked one. */
const UNRANKED_STATUS = -1;

const compareText = (a: string, b: string) => a.localeCompare(b, "el");

type Bucket = { id: string; label: string; rank: number | string; tracks: Track[] };

/** One pass in sorted order; `bucketOf` returns null for a track with no value. */
function bucketize(
  sorted: readonly Track[],
  bucketOf: (t: Track) => { id: string; label: string; rank: number | string } | null,
  compare: (a: Bucket, b: Bucket) => number,
): TrackGroup[] {
  const buckets = new Map<string, Bucket>();
  const missing: Track[] = [];
  for (const track of sorted) {
    const b = bucketOf(track);
    if (!b) {
      missing.push(track);
      continue;
    }
    const bucket = buckets.get(b.id);
    if (!bucket) {
      buckets.set(b.id, { ...b, tracks: [track] });
      continue;
    }
    bucket.tracks.push(track);
    // A bucket that merges several values (therapy statuses) ranks by its best member.
    if (typeof b.rank === "number" && typeof bucket.rank === "number") bucket.rank = Math.max(bucket.rank, b.rank);
  }
  const groups: TrackGroup[] = [...buckets.values()].sort(compare)
    .map(({ id, label, tracks }) => ({ id, label, tracks }));
  if (missing.length) groups.push({ id: NO_VALUE_ID, label: NO_VALUE_LABEL, tracks: missing });
  return groups;
}

const byNumber = (dir: 1 | -1) => (a: Bucket, b: Bucket) => dir * ((a.rank as number) - (b.rank as number));
const byText = (a: Bucket, b: Bucket) => compareText(String(a.rank), String(b.rank));

function parentDir(path: string): string {
  const normal = path.replace(/\\/g, "/");
  const at = normal.lastIndexOf("/");
  return at < 0 ? "" : normal.slice(0, at);
}

function groupByFolder(sorted: readonly Track[]): TrackGroup[] {
  const dirs = new Map<Track, string[]>();
  let common: string[] | null = null;
  for (const track of sorted) {
    const parts = parentDir(track.absolute_path).split("/");
    dirs.set(track, parts);
    if (common === null) {
      common = parts;
      continue;
    }
    let n = 0;
    while (n < common.length && n < parts.length && common[n] === parts[n]) n++;
    common = common.slice(0, n);
  }
  const prefix = common?.length ?? 0;
  const buckets = new Map<string, Track[]>();
  for (const track of sorted) {
    const rel = (dirs.get(track) ?? []).slice(prefix).join("/");
    const bucket = buckets.get(rel);
    if (bucket) bucket.push(track);
    else buckets.set(rel, [track]);
  }
  if (buckets.size === 1) {
    // Every track sits in one folder: name it by its own leaf, not «Κύριος φάκελος».
    const named = common?.filter(Boolean) ?? [];
    const leaf = named[named.length - 1] ?? "";
    return [{ id: "folder:", label: leaf || ROOT_FOLDER_LABEL, tracks: [...sorted] }];
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : compareText(a, b)))
    .map(([rel, tracks]) => ({ id: `folder:${rel}`, label: rel || ROOT_FOLDER_LABEL, tracks }));
}

function groupByCrates(sorted: readonly Track[], ctx: GroupContext): TrackGroup[] {
  const open = ctx.appliedQuery.trim();
  const crates = ctx.crates
    .filter(crate => crate.query.trim() !== open)
    .map(crate => ({ crate, ids: new Set(crate.track_ids), tracks: [] as Track[] }));
  const unsorted: Track[] = [];
  for (const track of sorted) {
    const bin = crates.find(c => c.ids.has(track.id));
    if (bin) bin.tracks.push(track);
    else unsorted.push(track);
  }
  const groups: TrackGroup[] = crates
    .filter(c => c.tracks.length > 0)
    .map(c => ({ id: `crate:${c.crate.id}`, label: c.crate.name, tracks: c.tracks }));
  if (unsorted.length) groups.push({ id: "unsorted", label: UNSORTED_LABEL, tracks: unsorted });
  return groups;
}

/** Split `sorted` into groups; tracks keep their incoming order inside a group, empty groups are omitted. */
export function groupTracks(sorted: readonly Track[], key: Exclude<GroupKey, "none">, ctx: GroupContext): TrackGroup[] {
  switch (key) {
    case "status": {
      // By label, so statuses that share one in the therapy profile (weapon, approved) merge; a null status is `unknown`.
      return bucketize(sorted, t => {
        const status = t.personal_status || "unknown";
        const label = statusLabel(status, ctx.profile);
        return { id: `status:${label}`, label, rank: STATUS_RANK[status] ?? UNRANKED_STATUS };
      }, byNumber(-1));
    }
    case "energy": {
      const name = axisLabel("energy", ctx.profile);
      return bucketize(sorted, t => (t.energy == null ? null : { id: `energy:${t.energy}`, label: `${name} ${t.energy}`, rank: t.energy }), byNumber(1));
    }
    case "role":
    case "substyle":
      return bucketize(sorted, t => {
        const value = key === "role" ? t.set_role : t.psy_substyle || t.artist_substyle;
        if (!value) return null;
        const label = valueLabel(value);
        return { id: `${key}:${value}`, label, rank: label };
      }, byText);
    case "bpm":
      return bucketize(sorted, t => {
        const bpm = effectiveBpm(t);
        if (bpm === null) return null;
        // Band the rounded tempo, the value the BPM cell shows.
        const band = Math.floor(Math.round(bpm) / 5) * 5;
        return { id: `bpm:${band}`, label: `${band}–${band + 4}`, rank: band };
      }, byNumber(1));
    case "key":
      return bucketize(sorted, t => {
        const order = keyOrder(t);
        return order === null ? null : { id: `key:${order}`, label: formatKey(t.key_text, fallbackKey(t), ctx.keyFormat), rank: order };
      }, byNumber(1));
    case "genre":
      return bucketize(sorted, t => {
        const genre = t.genre?.trim();
        if (!genre) return null;
        const folded = genre.toLocaleLowerCase("el");
        return { id: `genre:${folded}`, label: genre, rank: folded };
      }, byText);
    case "year":
      return bucketize(sorted, t => (t.year ? { id: `year:${t.year}`, label: String(t.year), rank: t.year } : null), byNumber(-1));
    case "folder":
      return groupByFolder(sorted);
    case "crates":
      return groupByCrates(sorted, ctx);
  }
}

/** Header + track rows for the table; collapsed groups contribute their header only. */
const capitalize = (label: string) => label.charAt(0).toLocaleUpperCase("el") + label.slice(1);

export function flattenGroups(groups: readonly TrackGroup[], collapsed: ReadonlySet<string>): FlatGroups {
  const view: Track[] = [];
  const rows: GroupRow[] = [];
  const order: Track[] = [];
  for (const group of groups) {
    const isCollapsed = collapsed.has(group.id);
    rows.push({ kind: "header", groupId: group.id, label: capitalize(group.label), count: group.tracks.length, collapsed: isCollapsed });
    for (const track of group.tracks) {
      order.push(track);
      if (isCollapsed) continue;
      rows.push({ kind: "track", index: view.length });
      view.push(track);
    }
  }
  return { view, rows, order };
}

/** The next (`delta` > 0) or previous visible track after `fromId` in `order`; null at either end or when `fromId` is absent. */
export function stepVisible(order: readonly Track[], visibleIds: ReadonlySet<number>, fromId: number, delta: number): Track | null {
  const from = order.findIndex(t => t.id === fromId);
  if (from < 0 || delta === 0) return null;
  const step = delta > 0 ? 1 : -1;
  for (let i = from + step; i >= 0 && i < order.length; i += step) {
    if (visibleIds.has(order[i].id)) return order[i];
  }
  return null;
}
