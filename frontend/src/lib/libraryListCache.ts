// The Library's blank-query list, kept in memory for the app's lifetime, so a return to the page shows its rows at once
// while a background refresh runs (`GET /api/tracks?limit=10000` takes seconds). Only the blank query is cached: a `sort:`
// or `limit:` token is a query, and every query is fetched. The cache follows the window events while the Library is
// unmounted: a profile write or a manual BPM patches its row; a finished analysis or scan and a facets change mark it stale
// (the rows stay; the next mount refreshes them, as every mount does). A failed refresh never stores anything.
import { ANALYSIS_FINISHED, BPM_UPDATED, applyBpmFields, type BpmUpdatedDetail } from "./bpmUpdates";
import { FACETS_CHANGED } from "./facets";
import { patchTrackProfile } from "./fastRating";
import { PROFILE_UPDATED, type ProfileUpdatedDetail } from "./profileUpdates";
import type { Track } from "./types";

export type BlankList = { rows: Track[]; at: number; stale: boolean; scrollTop?: number };
type RowPatch = (row: Track) => Track;

let blank: (BlankList & { ticket: number }) | null = null;
// One clock for fetch tickets, patches and stale marks: a fetch started before a patch gets the patch re-applied on store,
// and one started before a stale mark is stored as stale.
let clock = 0;
let staleAt = 0;
const PATCH_LOG = 500;
let patches: { at: number; id: number; fn: RowPatch }[] = [];

/** The cached rows of the blank query, or null; never an answer for any other query. */
export function blankList(query = ""): BlankList | null {
  return query === "" && blank ? { rows: blank.rows, at: blank.at, stale: blank.stale, scrollTop: blank.scrollTop } : null;
}

/** A ticket for a blank-query fetch; pass it to `storeBlankList` with the answer. */
export function beginBlankFetch(): number {
  return ++clock;
}

/** Stores a fetched blank list and returns the rows to show: the patches written since the fetch began applied again,
 * so an older answer never undoes a newer write. An answer older than the stored one is not stored. */
export function storeBlankList(rows: Track[], ticket = beginBlankFetch()): Track[] {
  let out = rows;
  for (const patch of patches) if (patch.at > ticket) out = patchRows(out, patch.id, patch.fn);
  if (blank && blank.ticket > ticket) return out;
  blank = { rows: out, at: Date.now(), stale: staleAt > ticket, ticket, scrollTop: blank?.scrollTop };
  return out;
}

/** Applies `fn` to the cached row of `trackId` (the cached list only; the on-screen rows patch themselves). */
export function patchBlankRow(trackId: number, fn: RowPatch): void {
  patches.push({ at: ++clock, id: trackId, fn });
  if (patches.length > PATCH_LOG) patches = patches.slice(-PATCH_LOG);
  if (blank) blank = { ...blank, rows: patchRows(blank.rows, trackId, fn) };
}

export function markBlankListStale(): void {
  staleAt = ++clock;
  if (blank) blank = { ...blank, stale: true };
}

/** The table's scroll offset when the Library left the blank list; restored once on the next mount. */
export function rememberBlankScroll(scrollTop: number): void {
  if (blank) blank = { ...blank, scrollTop };
}

export function clearBlankList(): void {
  blank = null;
  patches = [];
}

function patchRows(rows: Track[], trackId: number, fn: RowPatch): Track[] {
  const i = rows.findIndex(row => row.id === trackId);
  if (i < 0) return rows;
  const out = rows.slice();
  out[i] = fn(rows[i]);
  return out;
}

/** The listeners that keep the cache in step while the Library is unmounted; attached to `window` on import. */
export function attachBlankListListeners(target: EventTarget): () => void {
  const onProfile = (e: Event) => {
    const detail = (e as CustomEvent<ProfileUpdatedDetail>).detail;
    if (!detail) return;
    const { trackId, patch } = detail;
    if (patch) patchBlankRow(trackId, row => patchTrackProfile(row, patch));
    else markBlankListStale();
  };
  const onBpm = (e: Event) => {
    const detail = (e as CustomEvent<BpmUpdatedDetail>).detail;
    if (detail) patchBlankRow(detail.trackId, row => applyBpmFields(row, detail.fields));
  };
  target.addEventListener(PROFILE_UPDATED, onProfile);
  target.addEventListener(BPM_UPDATED, onBpm);
  target.addEventListener(ANALYSIS_FINISHED, markBlankListStale);
  target.addEventListener(FACETS_CHANGED, markBlankListStale);
  return () => {
    target.removeEventListener(PROFILE_UPDATED, onProfile);
    target.removeEventListener(BPM_UPDATED, onBpm);
    target.removeEventListener(ANALYSIS_FINISHED, markBlankListStale);
    target.removeEventListener(FACETS_CHANGED, markBlankListStale);
  };
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") attachBlankListListeners(window);
