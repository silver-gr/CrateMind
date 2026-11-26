import { useEffect, useState } from "react";
import { api } from "./api";
import { sessionPlayedIds } from "./libraryExtras";
import { PLAY_LOGGED } from "./playHistory";

const APP_STARTED = performance.timeOrigin;
const NONE: ReadonlySet<number> = new Set();

/** The ids of the tracks played since the app started; refreshed whenever a play is logged. */
export function useSessionPlays(): ReadonlySet<number> {
  const [ids, setIds] = useState<ReadonlySet<number>>(NONE);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      api.historyList().then(page => {
        if (!active) return;
        const next = sessionPlayedIds(page.plays, APP_STARTED);
        // A logged update of a play already counted keeps the same set, so the table does not redraw.
        setIds(current => current.size === next.size && [...next].every(id => current.has(id)) ? current : next);
      }).catch(() => {});
    };
    refresh();
    window.addEventListener(PLAY_LOGGED, refresh);
    return () => { active = false; window.removeEventListener(PLAY_LOGGED, refresh); };
  }, []);
  return ids;
}
