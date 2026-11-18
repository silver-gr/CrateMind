import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "./api";
import type { ArtistProfile } from "./types";

/**
 * The artist list (two tracks or more) behind the «Καλλιτέχνες» page and the Library tab.
 * The first `enabled: true` starts the load; after that the list stays until unmount and reloads
 * whenever `q` changes, whatever `enabled` does. The caller owns `q` (the hook never reads the URL).
 */
export function useArtists({ enabled, q, toastOnError = false }: { enabled: boolean; q?: string; toastOnError?: boolean }) {
  const [started, setStarted] = useState(enabled);
  if (enabled && !started) setStarted(true);
  const [rows, setRows] = useState<ArtistProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const requestId = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; requestId.current += 1; };
  }, []);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const data = await api.listArtists({ q: q || undefined, min_track_count: 2, limit: 5000 });
      if (id === requestId.current && mounted.current) setRows(data);
    } catch (e) {
      if (id === requestId.current && mounted.current) {
        setError((e as Error).message);
        if (toastOnError) toast.error((e as Error).message);
      }
    } finally {
      if (id === requestId.current && mounted.current) {
        setLoading(false);
        setLoaded(true);
      }
    }
  }, [q, toastOnError]);

  useEffect(() => {
    if (started) void load();
  }, [started, load]);

  return { rows, loading, loaded, error, load };
}
