import { useEffect, useState } from "react";
import { api } from "./api";
import { sessionPlayedIds } from "./libraryExtras";
import { PLAY_LOGGED } from "./playHistory";

const APP_STARTED = performance.timeOrigin;
const NONE: ReadonlySet<number> = new Set();

// Kept for the app's lifetime: a return to the Library shows the last set at once, and the history (about 1 MB) is
// read again only after a play is logged, never on every mount.
let known: ReadonlySet<number> | null = null;
let stale = true;
const listeners = new Set<(ids: ReadonlySet<number>) => void>();

function refresh() {
  stale = false;
  api.historyList().then(page => {
    const next = sessionPlayedIds(page.plays, APP_STARTED);
    // A logged update of a play already counted keeps the same set, so the table does not redraw.
    const current = known;
    if (current && current.size === next.size && [...next].every(id => current.has(id))) return;
    known = next;
    for (const listener of listeners) listener(next);
  }, () => { stale = true; });
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener(PLAY_LOGGED, () => {
    if (listeners.size > 0) refresh();
    else stale = true;
  });
}

/** The ids of the tracks played since the app started; refreshed whenever a play is logged. */
export function useSessionPlays(): ReadonlySet<number> {
  const [ids, setIds] = useState<ReadonlySet<number>>(() => known ?? NONE);
  useEffect(() => {
    listeners.add(setIds);
    if (known) setIds(known);
    if (stale) refresh();
    return () => { listeners.delete(setIds); };
  }, []);
  return ids;
}
