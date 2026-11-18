import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api } from "./api";
import { PLAY_LOGGED, defaultTitle, groupSessions, mergePlays, playStartMs, tracksLabel, type PlaySession } from "./playHistory";
import type { PlayHistoryEntry } from "./types";

/**
 * The play history list shared by the «Ιστορικό» page and the Library tab. The first `enabled: true` starts the load
 * once; after that the rows, the `PLAY_LOGGED` refresh and the first-page `hasMore` live until unmount.
 */
export function usePlayHistoryList({ enabled }: { enabled: boolean }) {
  const navigate = useNavigate();
  const [started, setStarted] = useState(enabled);
  if (enabled && !started) setStarted(true);
  const [plays, setPlays] = useState<PlayHistoryEntry[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState(false);
  // Rows deleted here: a refresh that started before the delete must not bring them back.
  const deletedRef = useRef(new Set<number>());
  const refreshRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!started) return;
    let active = true;
    let first = true;
    const refresh = () => api.historyList().then(page => {
      if (!active) return;
      const fresh = page.plays.filter(play => !deletedRef.current.has(play.id));
      setPlays(loaded => (loaded ? mergePlays(loaded, fresh) : fresh));
      // Only the first page decides: a refresh adds rows at the top and never changes what lies older.
      if (first) { first = false; setHasMore(page.has_more); }
      setFailed(false);
    }).catch(() => { if (active) setFailed(true); });
    refreshRef.current = () => void refresh();
    void refresh();
    window.addEventListener(PLAY_LOGGED, refresh);
    return () => { active = false; refreshRef.current = null; window.removeEventListener(PLAY_LOGGED, refresh); };
  }, [started]);

  const sessions = useMemo(() => groupSessions(plays ?? []), [plays]);

  async function loadOlder() {
    // The oldest loaded row in the server's order (start, then id); none left after deletes → the newest page.
    const oldest = plays?.length
      ? plays.reduce((a, b) => (playStartMs(b) < playStartMs(a) || (playStartMs(b) === playStartMs(a) && b.id < a.id) ? b : a))
      : null;
    setLoadingMore(true);
    try {
      const page = await api.historyList(oldest?.id);
      setPlays(loaded => mergePlays(loaded ?? [], page.plays));
      setHasMore(page.has_more);
    } catch {
      toast.error("Δεν φορτώθηκαν παλιότερα");
    } finally {
      setLoadingMore(false);
    }
  }

  /** Deletes plays; resolves `true` once they are gone from the server and the list. */
  async function remove(ids: number[], message: string): Promise<boolean> {
    setBusy(true);
    try {
      await api.historyDeletePlays(ids);
      const gone = new Set(ids);
      ids.forEach(id => deletedRef.current.add(id));
      setPlays(loaded => loaded?.filter(play => !gone.has(play.id)) ?? null);
      toast.success(message);
      return true;
    } catch {
      toast.error("Η διαγραφή απέτυχε");
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** Saves the session as a DJ set; resolves `true` when it was saved. */
  async function saveAsSet(session: PlaySession): Promise<boolean> {
    const title = defaultTitle(session.startMs);
    setBusy(true);
    try {
      const { set_id, track_count } = await api.historySaveSet(session.plays.map(play => play.id), title);
      toast.success(`Αποθηκεύτηκε το set «${title}» (${tracksLabel(track_count)})`, {
        action: { label: "Άνοιγμα στο Χτίσιμο set", onClick: () => navigate(`/sets?id=${set_id}`) },
      });
      return true;
    } catch {
      toast.error("Το set δεν αποθηκεύτηκε");
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** After a failed first load: shows the loading state again and asks once more. */
  function retry() {
    setFailed(false);
    refreshRef.current?.();
  }

  return { plays, sessions, hasMore, failed, loadingMore, busy, loadOlder, remove, saveAsSet, retry };
}
