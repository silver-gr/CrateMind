import { useEffect, useState } from "react";

/**
 * Reactive CSS media-query hook. Used (e.g.) by the Library TrackTable to DROP
 * low-priority columns at narrow widths — the shared `gridTemplateColumns` is one
 * computed string, so a column must be removed from cols+headers+cells in lockstep,
 * not hidden via CSS (which would leave an empty grid track).
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}
