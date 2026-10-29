import { useCallback, useEffect, useState, useMemo, useRef } from "react";
import { motion } from "motion/react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Button } from "../components/ui/button";
import { sortTracks, type SortState } from "../lib/trackSort";
import Curve from "../components/Curve";
import RecommendationCard from "../components/RecommendationCard";
import RepeatedArtists from "../components/RepeatedArtists";
import { refillSetRecommendations } from "../lib/setRecommendations";
import SetTimeline from "../components/SetTimeline";
import SetActions, { type SetExportFormat } from "../components/SetActions";
import SetKeyPath from "../components/SetKeyPath";
import TrackTable from "../components/TrackTable";
import { GlassPanel } from "../components/ui/GlassPanel";
import { KeyWheel } from "../components/ui/KeyWheel";
import KeyWheelSourceControl from "../components/KeyWheelSourceControl";
import { SectionHeader } from "../components/ui/SectionHeader";
import { ResizeHandle } from "../components/ui/ResizeHandle";
import { useResizable } from "../lib/useResizable";
import { recMatchPercents } from "../lib/aggregate";
import { api } from "../lib/api";
import { useSetTrackAddition } from "../lib/useSetTrackAddition";
import { formatSetDuration } from "../lib/setDuration";
import { canonicalCamelot, KEY_WHEEL_SOURCE_LABELS, resolveKeyWheelSource, type KeyWheelSource } from "../lib/keyWheelSource";
import { recommendationSourceIsCurrent, recommendationSourceKey, recommendationSourceRequest, resolveRecommendationSource, type RecommendationSource } from "../lib/recommendationSource";
import type { LucideIcon } from "lucide-react";
import { setKeyStats, formatSetBpmRange } from "../lib/setStats";
import { Clock, Gauge, KeyRound, ListMusic, Play, Search, Sparkles } from "../lib/icons";
import { usePlayer } from "../lib/player";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import type {
  DJSet,
  PairNote,
  Recommendation,
  SetAnalysis,
  SetTrackRow,
  Track,
} from "../lib/types";



function Stat({ label, value, icon: Icon }: { label: string; value: string | number; icon: LucideIcon }) {
  return (
    <div className="rounded-lg border border-white/8 bg-white/[0.02] px-2.5 py-2">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-cm-faint"><Icon aria-hidden="true" className="h-3 w-3" />{label}</div>
      <div className="mt-0.5 font-mono text-sm tabular-nums text-cm-text">{value}</div>
    </div>
  );
}

export default function SetBuilder() {
  const [params, setParams] = useSearchParams();
  const { addToSet, duplicateDialog } = useSetTrackAddition();
  const [sets, setSets] = useState<DJSet[]>([]);
  const [setId, setSetId] = useState<number | null>(null);
  const [rows, setRows] = useState<SetTrackRow[]>([]);
  const timelineRef = useRef<HTMLDivElement>(null);
  const [loadedSetId, setLoadedSetId] = useState<number | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);
  const orderPending = useRef(false);
  const activeSetId = useRef(setId);
  activeSetId.current = setId;
  const loadVersion = useRef(0);
  const [analysis, setAnalysis] = useState<SetAnalysis | null>(null);
  const [candidates, setCandidates] = useState<Track[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [candidateSort, setCandidateSort] = useState<SortState | null>(null);
  const sortedCandidates = useMemo(() => sortTracks(candidates, candidateSort), [candidates, candidateSort]);
  const [dialog, setDialog] = useState<{ kind: "new" } | { kind: "pair"; from: Track; to: Track; setId: number | null } | null>(null);
  const [titleInput, setTitleInput] = useState("");
  const [transitionInput, setTransitionInput] = useState("");
  const [ratingInput, setRatingInput] = useState("4");
  const [noteInput, setNoteInput] = useState("");
  const [savingDialog, setSavingDialog] = useState(false);
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<{ trackId: number; source: "candidate" | "set"; setId: number | null } | null>(null);
  const [keyWheelSource, setKeyWheelSource] = useState<KeyWheelSource>("last");
  const [recommendationSource, setRecommendationSource] = useState<KeyWheelSource>("last");
  const [fetchedPlayingTrack, setFetchedPlayingTrack] = useState<Track | null>(null);

  const {
    size: rightPanelWidth,
    isDragging: isRightDragging,
    handleProps: rightHandleProps,
  } = useResizable({
    direction: "horizontal",
    initial: 360,
    min: 280,
    max: 500,
    storageKey: "cm:setbuilder-sidebar-width",
    reverse: true,
  });

  const {
    size: candidatesWidth,
    isDragging: isCandidatesDragging,
    handleProps: candidatesHandleProps,
  } = useResizable({
    direction: "horizontal",
    initial: 320,
    min: 240,
    max: 600,
    storageKey: "cm:setbuilder-candidates-width",
    reverse: false,
  });
  const [recs, setRecs] = useState<Recommendation[]>([]);
  const [recLabel, setRecLabel] = useState("");
  const [recommending, setRecommending] = useState(false);
  const recRequest = useRef(0);
  const recContext = useRef<{ setId: number; body: Record<string, unknown>; source: RecommendationSource | null } | null>(null);
  const pendingRecommendationTail = useRef<{ setId: number; trackId: number } | null>(null);
  const [pairNotes, setPairNotes] = useState<Record<string, PairNote>>({});
  const { play, current: playerTrack, playingTrackId } = usePlayer();
  const setTracks = loadedSetId === setId ? rows.map(row => row.track) : [];
  const selectedTrack = selection?.source === "set"
    ? selection.setId === setId ? setTracks.find(track => track.id === selection.trackId) : undefined
    : candidates.find(track => track.id === selection?.trackId);
  const knownPlayingTrack = playingTrackId === null ? undefined
    : setTracks.find(track => track.id === playingTrackId)
      ?? candidates.find(track => track.id === playingTrackId)
      ?? (playerTrack?.id === playingTrackId ? playerTrack : undefined);
  const playingTrack = knownPlayingTrack
    ?? (fetchedPlayingTrack?.id === playingTrackId ? fetchedPlayingTrack : null);

  const lastTrack = setTracks[setTracks.length - 1];
  const recommendationTracks = { playing: playingTrack, selection: selectedTrack, last: lastTrack };
  const activeRecommendationSource = resolveRecommendationSource(recommendationSource, recommendationTracks);
  const activeRecommendationKey = recommendationSourceKey(activeRecommendationSource);
  const recommendationState = useRef(activeRecommendationSource);
  recommendationState.current = activeRecommendationSource;

  function recommendationContextIsCurrent(context: NonNullable<typeof recContext.current>) {
    if (activeSetId.current !== context.setId) return false;
    // A committed addition becomes the last track before its refreshed rows arrive.
    const pendingTail = pendingRecommendationTail.current;
    return recommendationSourceIsCurrent(context.source, recommendationState.current,
      pendingTail?.setId === context.setId ? pendingTail.trackId : undefined);
  }

  function clearRecommendations() {
    ++recRequest.current;
    recContext.current = null;
    pendingRecommendationTail.current = null;
    setRecs([]);
    setRecLabel("");
    setRecommending(false);
  }

  function selectRecommendationSource(source: KeyWheelSource) {
    clearRecommendations();
    setRecommendationSource(source);
  }

  useEffect(() => {
    const context = recContext.current;
    if (context && !recommendationContextIsCurrent(context)) clearRecommendations();
    else if (context?.source && activeRecommendationSource
      && recommendationSourceKey(context.source) === activeRecommendationKey) {
      setRecLabel(recommendationLabel(activeRecommendationSource));
    }
    if (pendingRecommendationTail.current?.trackId === lastTrack?.id) pendingRecommendationTail.current = null;
  }, [activeRecommendationKey, recommendationSource, lastTrack?.id]);

  // Secondary decks can play tracks outside this set, its candidates, or the primary player.
  useEffect(() => {
    if (playingTrackId === null || knownPlayingTrack) return;
    let cancelled = false;
    api.getTrack(playingTrackId).then(detail => {
      if (!cancelled) setFetchedPlayingTrack(detail.track);
    }).catch(() => {
      if (!cancelled) setFetchedPlayingTrack(null);
    });
    return () => { cancelled = true; };
  }, [playingTrackId, knownPlayingTrack]);

  const loadSets = useCallback(async () => {
    setSets(await api.listSets());
  }, []);

  const loadSet = useCallback(async (id: number) => {
    if (activeSetId.current !== id) return;
    const version = ++loadVersion.current;
    const data = await api.getSet(id);
    // A late refresh must never overwrite another set or a newer order.
    if (activeSetId.current !== id || version !== loadVersion.current) return;
    setRows(data.tracks);
    setLoadedSetId(id);
    const [nextAnalysis, notes] = await Promise.all([
      api.setAnalysis(id), api.listAllPairNotes(),
    ]);
    if (activeSetId.current !== id || version !== loadVersion.current) return;
    setAnalysis(nextAnalysis);
    const map: Record<string, PairNote> = {};
    for (const n of notes) map[`${n.from_track_id}-${n.to_track_id}`] = n;
    setPairNotes(map);
  }, []);

  useEffect(() => {
    loadSets();
  }, [loadSets]);

  // Deep-link: honor ?id= from the URL (the /playlists page links /sets?id=N),
  // and re-resolve whenever the param or the loaded set list changes. Falls back
  // to the newest set (highest id) when ?id= is absent or unknown.
  useEffect(() => {
    if (!sets.length) return;
    const wanted = Number(params.get("id"));
    const match = sets.find((s) => s.id === wanted);
    const newest = sets.reduce((a, b) => (b.id > a.id ? b : a));
    setSetId(match ? match.id : newest.id);
  }, [sets, params]);

  useEffect(() => {
    setLoadedSetId(null);
    setAnalysis(null);
    ++recRequest.current;
    recContext.current = null;
    pendingRecommendationTail.current = null;
    setRecs([]);
    setRecLabel("");
    setRecommending(false);
    if (setId !== null) {
      loadSet(setId).catch(() => {
        if (activeSetId.current === setId) toast.error("Δεν ήταν δυνατή η φόρτωση του set");
      });
    }
  }, [setId, loadSet]);
  useEffect(() => () => { ++recRequest.current; recContext.current = null; }, []);
  useEffect(() => {
    setCandidatesLoading(true);
    api
      .listTracks(query)
      .then(setCandidates)
      .finally(() => setCandidatesLoading(false));
  }, [query]);

  // Active set is driven through the URL so deep links and the switcher agree.
  const selectSet = (id: number) => setParams({ id: String(id) });

  function newSet() { setTitleInput(""); setDialog({ kind: "new" }); }

  async function saveDialog(e: React.FormEvent) {
    e.preventDefault();
    if (!dialog) return;
    setSavingDialog(true);
    try {
      if (dialog.kind === "new") {
        if (!titleInput.trim()) return;
        const created = await api.createSet(titleInput.trim());
        await loadSets(); selectSet(created.id);
      } else {
        await api.createPairNote({ from_track_id: dialog.from.id, to_track_id: dialog.to.id,
          transition_type: transitionInput.trim() || null, rating: ratingInput ? Number(ratingInput) : null, notes: noteInput.trim() || null });
        if (dialog.setId !== null) await loadSet(dialog.setId);
      }
      setDialog(null);
    } catch { toast.error("Δεν ήταν δυνατή η αποθήκευση"); }
    finally { setSavingDialog(false); }
  }

  async function duplicateSet() {
    if (setId === null) return;
    const src = sets.find((s) => s.id === setId);
    const copy = await api.createSet(`${src?.title ?? "Set"} (αντίγραφο)`);
    for (const r of rows) await api.addSetTrack(copy.id, r.track.id);
    await loadSets();
    selectSet(copy.id);
    toast.success(`Δημιουργήθηκε αντίγραφο: ${copy.title}`);
  }

  async function add(trackId: number) {
    if (setId === null || orderPending.current || loadedSetId !== setId) return;
    const id = setId;
    orderPending.current = true;
    setSavingOrder(true);
    try {
      if (await addToSet(id, trackId)) {
        if (activeSetId.current === id) {
          // Remove only after the add commits; cancellation/failure keeps the card.
          ++recRequest.current;
          setRecs(current => current.filter(rec => rec.track_id !== trackId));
          const context = recContext.current;
          if (context?.setId === id && recommendationContextIsCurrent(context)) {
            const excluded = new Set([...rows.map(row => row.track.id), trackId]);
            // Explicit bridges keep their endpoints; last-track mode follows the addition.
            const addedTrack = candidates.find(track => track.id === trackId)
              ?? recs.find(rec => rec.track_id === trackId);
            const source = context.source?.source === "last"
              ? { source: "last" as const, track: { id: trackId, title: addedTrack?.title ?? null, file_name: addedTrack && "file_name" in addedTrack ? addedTrack.file_name : String(trackId) } }
              : context.source;
            if (source?.source === "last") pendingRecommendationTail.current = { setId: id, trackId };
            const nextContext = { setId: id, source, body: source ? recommendationSourceRequest(source) : context.body };
            recContext.current = nextContext;
            if (source) setRecLabel(recommendationLabel(source));
            void requestRecommendations(nextContext, excluded, true);
          }
        }
        try { await loadSet(id); } catch {
          if (pendingRecommendationTail.current?.setId === id) clearRecommendations();
          toast.error("Το track προστέθηκε, αλλά δεν ανανεώθηκε το set");
        }
      }
    } finally {
      pendingRecommendationTail.current = null;
      orderPending.current = false;
      setSavingOrder(false);
    }
  }
  async function remove(trackId: number, position: number) {
    if (setId === null || orderPending.current || loadedSetId !== setId) return;
    const id = setId;
    orderPending.current = true;
    setSavingOrder(true);
    ++loadVersion.current;
    try {
      await api.removeSetTrack(id, trackId, position);
      if (activeSetId.current === id) setRows(current => current.filter(row => row.position !== position));
      try { await loadSet(id); } catch { toast.error("Το track αφαιρέθηκε, αλλά δεν ανανεώθηκε το set"); }
    } catch {
      toast.error("Δεν ήταν δυνατή η αφαίρεση. Το set μπορεί να έχει αλλάξει.");
      try { await loadSet(id); } catch { /* Keep the last confirmed order. */ }
    } finally {
      orderPending.current = false;
      setSavingOrder(false);
    }
  }
  async function reorder(from: number, to: number) {
    if (from < 0 || from >= rows.length || to < 0 || to >= rows.length) return;
    const orderedRows = [...rows];
    const [m] = orderedRows.splice(from, 1);
    orderedRows.splice(to, 0, m);
    await commitOrder(orderedRows.map((r) => r.track.id), orderedRows.map((r) => r.position));
  }
  async function commitOrder(ids: number[], positions?: number[]) {
    if (setId === null || activeSetId.current !== setId || loadedSetId !== setId || orderPending.current) return;
    const byPosition = new Map(rows.map((row) => [row.position, row]));
    // Positions distinguish repeated tracks and preserve each occurrence's note.
    // The fallback supports callers that only have the ordered track IDs.
    const remaining = [...rows];
    const orderedRows = positions
      ? positions.map((position) => byPosition.get(position))
      : ids.map((trackId) => {
        const index = remaining.findIndex((row) => row.track.id === trackId);
        return index < 0 ? undefined : remaining.splice(index, 1)[0];
      });
    if (ids.length !== rows.length || orderedRows.length !== rows.length ||
      orderedRows.some((row, i) => !row || row.track.id !== ids[i]) ||
      new Set(orderedRows.map((row) => row?.position)).size !== rows.length) return;
    const nextRows = orderedRows as SetTrackRow[];
    if (nextRows.every((row, i) => row.position === rows[i].position)) return;
    const previousRows = rows;
    const id = setId;
    orderPending.current = true;
    setSavingOrder(true);
    // Invalidate refreshes that started before this optimistic update.
    ++loadVersion.current;
    setRows(nextRows);
    try {
      await api.reorderSet(id, ids, nextRows.map((row) => row.position));
      // The server rewrites positions from zero. Keep these occurrence IDs
      // current even if the subsequent analysis refresh fails.
      if (activeSetId.current === id) {
        setRows(nextRows.map((row, position) => ({ ...row, position })));
      }
      try { await loadSet(id); } catch {
        if (activeSetId.current === id) toast.error("Η σειρά αποθηκεύτηκε, αλλά δεν ανανεώθηκε η ανάλυση");
      }
    } catch {
      if (activeSetId.current === id) {
        toast.error("Δεν ήταν δυνατή η αποθήκευση της σειράς");
        // Restore first, then fetch the actual order in case the server saved
        // the request but its response was interrupted.
        setRows([...previousRows]);
        try { await loadSet(id); } catch { /* Keep the last confirmed order. */ }
      }
    } finally {
      orderPending.current = false;
      setSavingOrder(false);
    }
  }

  async function requestRecommendations(context: NonNullable<typeof recContext.current>, excluded: ReadonlySet<number>, refill = false) {
    const { setId: id, body } = context;
    const version = ++recRequest.current;
    setRecommending(true);
    try {
      const fresh = await api.recommendNext(id, body);
      if (!recommendationContextIsCurrent(context) || version !== recRequest.current) return;
      setRecs(current => refillSetRecommendations(refill ? current : [], fresh, excluded, 12));
    } catch {
      if (recommendationContextIsCurrent(context) && version === recRequest.current) {
        toast.error("Δεν ανανεώθηκαν οι προτάσεις. Δοκίμασε ξανά.");
      }
    } finally {
      if (activeSetId.current === id && version === recRequest.current) setRecommending(false);
    }
  }
  function recommendationLabel(source: RecommendationSource) {
    return `${KEY_WHEEL_SOURCE_LABELS[source.source]}: ${source.track.title || source.track.file_name}`;
  }

  async function recommendNext() {
    if (setId === null || orderPending.current || loadedSetId !== setId || !activeRecommendationSource) return;
    setRecLabel(recommendationLabel(activeRecommendationSource));
    setRecs([]);
    const context = { setId, body: recommendationSourceRequest(activeRecommendationSource), source: activeRecommendationSource };
    recContext.current = context;
    await requestRecommendations(context, new Set(rows.map(row => row.track.id)));
  }
  async function bridgeBetween(i: number) {
    if (setId === null || orderPending.current || loadedSetId !== setId || i + 1 >= rows.length) return;
    const a = rows[i].track;
    const b = rows[i + 1].track;
    setRecLabel(`Γέφυρα: ${a.title || a.file_name} → ${b.title || b.file_name}`);
    const body = {
      after_track_id: a.id,
      before_track_id: b.id,
      need_bridge: true,
      limit: 12,
    };
    const context = { setId, body, source: null };
    recContext.current = context;
    setRecs([]);
    await requestRecommendations(context, new Set(rows.map(row => row.track.id)));
  }

  function addPairNote(i: number) {
    if (i + 1 >= rows.length) return;
    const from = rows[i].track, to = rows[i + 1].track;
    const existing = pairNotes[`${from.id}-${to.id}`];
    setTransitionInput(existing?.transition_type ?? "");
    setRatingInput(String(existing?.rating ?? 4));
    setNoteInput(existing?.notes ?? "");
    setDialog({ kind: "pair", from, to, setId });
  }

  async function markPlayed() {
    if (setId === null) return;
    const r = await api.logSetPlay(setId, {});
    toast.success(`Καταγράφηκε play για ${r.tracks_logged} tracks`);
    loadSet(setId);
  }

  async function doExport(fmt: SetExportFormat) {
    if (setId === null) return;
    try {
      const r = await api.exportArtifact(fmt, { set_id: setId, overwrite: true });
      toast.success(`Έγινε export → ${r.path}`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  // "Save" persists a real on-disk JSON snapshot of the set (the set itself is
  // already auto-persisted on every edit; this writes a backup artifact).
  async function saveSet() {
    if (setId === null) return;
    try {
      const r = await api.exportArtifact("json-backup", { set_id: setId, overwrite: true });
      toast.success(`Αποθηκεύτηκε → ${r.path}`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const [recsParent] = useAutoAnimate<HTMLDivElement>();

  // ---- derived (cheap, in-memory) ------------------------------------------
  const matches = recMatchPercents(recs);

  const { counts: keyCounts, distinct: keyCount } = setKeyStats(setTracks);
  const wheelKeys: Record<KeyWheelSource, string | null> = {
    playing: playingTrackId === null ? null : canonicalCamelot(playingTrack),
    selection: canonicalCamelot(selectedTrack),
    last: canonicalCamelot(lastTrack),
  };
  const activeWheelSource = resolveKeyWheelSource(keyWheelSource, wheelKeys);
  const wheelTrack = activeWheelSource === "playing" ? playingTrack
    : activeWheelSource === "selection" ? selectedTrack : lastTrack;
  const bpmRange = formatSetBpmRange(analysis?.bpm_curve ?? []);

  return (
    <div className="flex h-full flex-col">
      {/* body */}
      <div className="flex min-h-0 flex-1">
        {/* candidates */}
        <div
          style={{ width: `${candidatesWidth}px` }}
          className="relative flex shrink-0 flex-col border-r border-black/10 dark:border-white/10"
        >
          <div className="border-b border-black/10 dark:border-white/10 p-3">
            <SectionHeader>Υποψήφια tracks</SectionHeader>
            <div className="relative">
              <Search className="pointer-events-none absolute z-10 left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-cm-faint" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="φίλτρο υποψηφίων…"
                className="w-full rounded-lg surface-field py-1.5 pl-8 pr-2 text-sm text-cm-text placeholder:text-cm-faint focus:border-cm-cyan/40 focus:outline-none focus:ring-1 focus:ring-cm-cyan/30"
              />
            </div>
          </div>
          <div className="min-h-0 flex-1">
            <TrackTable
              tracks={sortedCandidates}
              sortKey={candidateSort?.key}
              sortDir={candidateSort?.dir}
              onSort={key => setCandidateSort(prev => ({key, dir: prev?.key === key && prev.dir === "asc" ? "desc" : "asc"}))}
              loading={candidatesLoading}
              variant="compact"
              selectedId={selection?.source === "candidate" ? selectedTrack?.id : undefined}
              onSelect={trackId => setSelection({ trackId, source: "candidate", setId: null })}
              onPlay={play}
              onAdd={add}
              addDisabled={setId === null || savingOrder || loadedSetId !== setId}
            />
          </div>
          <ResizeHandle
            orientation="vertical"
            isDragging={isCandidatesDragging}
            ariaLabel="Αλλαγή πλάτους υποψηφίων tracks"
            className="absolute -right-1.5 inset-y-0 z-30"
            {...candidatesHandleProps}
          />
        </div>

        {/* timeline */}
        <div className="flex min-w-0 flex-1 flex-col">
          <motion.div ref={timelineRef} layoutScroll className="min-h-0 flex-1 overflow-auto" aria-busy={savingOrder}>
            <SetTimeline
              key={setId}
              rows={loadedSetId === setId ? rows : []}
              disabled={savingOrder}
              playingTrackId={playingTrackId}
              selectedTrackId={selection?.source === "set" ? selectedTrack?.id : null}
              onSelect={trackId => setSelection({ trackId, source: "set", setId })}
              pairNotes={pairNotes}
              onReorder={commitOrder}
              onMove={reorder}
              onRemove={remove}
              onPlay={play}
              onBridge={bridgeBetween}
              onAddPairNote={addPairNote}
            />
          </motion.div>
          <div className="border-t border-black/10 dark:border-white/10 p-2">
            <button
              onClick={markPlayed}
              disabled={setId === null}
              className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-cm-chartreuse/12 px-2.5 py-1 text-xs font-medium text-cm-chartreuse transition hover:bg-cm-chartreuse/25 disabled:cursor-default disabled:opacity-40"
            >
              <Play className="h-3 w-3" /> Σήμανση set ως παιγμένο
            </button>
          </div>
        </div>

        {/* analysis + recommendations */}
        <div
          style={{ width: `${rightPanelWidth}px` }}
          className="relative shrink-0 flex flex-col h-full border-l border-black/10 dark:border-white/10"
        >
          <ResizeHandle
            orientation="vertical"
            isDragging={isRightDragging}
            ariaLabel="Αλλαγή πλάτους panel ανάλυσης"
            className="absolute -left-1.5 inset-y-0 z-30"
            {...rightHandleProps}
          />
          <div className="shrink-0 border-b border-black/10 p-3 dark:border-white/10" data-set-controls>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-cm-faint">Επιλεγμένο set</div>
            <div className="flex min-w-0 items-center gap-2">
              <Select value={setId !== null ? String(setId) : ""}
                onValueChange={value => selectSet(Number(value))}>
                <SelectTrigger aria-label="Επιλογή set" className="h-9 min-w-0 flex-1 surface-field text-sm font-semibold text-cm-text focus:border-cm-cyan/40 focus:ring-cm-cyan/30 [&>span]:truncate">
                  <SelectValue placeholder="Χωρίς sets" />
                </SelectTrigger>
                <SelectContent>
                  {sets.map(set => <SelectItem key={set.id} value={String(set.id)}>{set.title}</SelectItem>)}
                </SelectContent>
              </Select>
              <SetActions disabled={setId === null || loadedSetId !== setId || savingOrder}
                onNew={newSet} onDuplicate={duplicateSet} onSave={saveSet} onExport={doExport} />
            </div>
            {savingOrder && <p role="status" className="mt-1.5 text-[10px] text-cm-faint">Αποθήκευση αλλαγών…</p>}
          </div>
          <aside className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {/* set energy curve */}
          <GlassPanel className="p-4">
            <SectionHeader>Καμπύλη ενέργειας</SectionHeader>
            {analysis ? (
              <div className="space-y-3">
                <Curve values={analysis.energy_curve} min={0} max={10} color="var(--color-cm-chartreuse)" height={64} />
                <div className="grid grid-cols-2 gap-3">
                  <Curve label="BPM" values={analysis.bpm_curve} color="var(--color-cm-blue)" height={28} />
                  <Curve label="Σκοτεινότητα" values={analysis.darkness_curve} min={0} max={10} color="var(--color-cm-violet)" height={28} />
                </div>
              </div>
            ) : (
              <div className="text-xs text-cm-faint">Διάλεξε set για να δεις ανάλυση.</div>
            )}
          </GlassPanel>

          {/* set stats */}
          {analysis && (
            <GlassPanel className="p-4">
              <SectionHeader>Στατιστικά set</SectionHeader>
              <div className="grid grid-cols-2 gap-2.5">
                <Stat icon={Clock} label="Διάρκεια" value={formatSetDuration(analysis.total_duration)} />
                <Stat icon={ListMusic} label="Tracks" value={analysis.track_count} />
                <Stat icon={Gauge} label="BPM" value={bpmRange} />
                <Stat icon={KeyRound} label="Keys" value={keyCount} />
              </div>

              <SetKeyPath key={setId} rows={rows} disabled={savingOrder}
                onJump={position => {
                  const row = timelineRef.current?.querySelector<HTMLElement>(`[data-set-position="${position}"]`);
                  row?.scrollIntoView({ block: "center", behavior: "auto" });
                  row?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
                }} />

              <RepeatedArtists artists={analysis.repeated_artists} />

              {analysis.not_approved.length > 0 && (
                <div className="mt-3 text-[11px] text-cm-faint">
                  {analysis.not_approved.length} χωρίς ανθρώπινη έγκριση
                </div>
              )}
            </GlassPanel>
          )}

          {/* recommended next */}
          <GlassPanel className="p-4">
            <SectionHeader>Επόμενα προτεινόμενα</SectionHeader>
            <KeyWheelSourceControl value={activeRecommendationSource?.source ?? null}
              legend="Πηγή για το επόμενο προτεινόμενο track"
              keys={{
                playing: playingTrack ? playingTrack.title || playingTrack.file_name || String(playingTrack.id) : null,
                selection: selectedTrack ? selectedTrack.title || selectedTrack.file_name || String(selectedTrack.id) : null,
                last: lastTrack ? lastTrack.title || lastTrack.file_name || String(lastTrack.id) : null,
              }}
              unavailable={{ playing: playingTrackId === null ? "Δεν παίζει track" : "Το track δεν είναι διαθέσιμο", selection: "Επίλεξε track", last: "Το set είναι άδειο" }}
              onChange={selectRecommendationSource} />
            <button
              onClick={recommendNext}
              disabled={setId === null || savingOrder || recommending || loadedSetId !== setId || !activeRecommendationSource}
              className="mt-3 inline-flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-cm-cyan/12 py-2 text-sm font-medium text-cm-cyan transition hover:bg-cm-cyan/25 disabled:cursor-default disabled:opacity-40"
            >
              <Sparkles className="h-4 w-4" /> {recommending ? "Ανανέωση προτάσεων…" : "Πρότεινε επόμενο track"}
            </button>
            {recLabel && <div className="mt-2 text-xs text-cm-muted">{recLabel}</div>}
            <div ref={recsParent} className="mt-3 space-y-2" aria-busy={recommending}>
              {recs.length === 0 ? (
                <div className="text-[11px] text-cm-faint">
                  {recommending ? "Ανανέωση προτάσεων…" : recLabel
                    ? "Δεν υπάρχουν διαθέσιμες προτάσεις. Δοκίμασε ξανά."
                    : "Τρέξε πρόταση για να δεις επόμενα tracks."}
                </div>
              ) : (
                recs.map((r, i) => (
                  <RecommendationCard key={r.track_id} rec={r} onAdd={add} match={matches[i]} />
                ))
              )}
            </div>
          </GlassPanel>

          {/* key compatibility */}
          <GlassPanel className="p-4">
            <SectionHeader>Συμβατότητα key</SectionHeader>
            <KeyWheelSourceControl value={activeWheelSource} keys={wheelKeys} onChange={setKeyWheelSource}
              unavailable={{
                playing: playingTrackId === null ? "Δεν παίζει track" : !playingTrack ? "Το track δεν είναι διαθέσιμο" : "Χωρίς αναγνωρισμένο key",
                selection: selectedTrack ? "Χωρίς αναγνωρισμένο key" : "Επίλεξε track",
                last: lastTrack ? "Χωρίς αναγνωρισμένο key" : "Το set είναι άδειο",
              }} />
            {activeWheelSource || setTracks.length > 0 ? (
              <div className="mt-3 flex flex-col items-center gap-2">
                <KeyWheel counts={keyCounts} selected={activeWheelSource ? wheelKeys[activeWheelSource] : null} size={236} />
                <div aria-live="polite" className="w-full text-center text-[11px] text-cm-muted">
                  {activeWheelSource ? <>
                    <div className="truncate" title={wheelTrack?.title || wheelTrack?.file_name}>
                      {KEY_WHEEL_SOURCE_LABELS[activeWheelSource]}: {wheelTrack?.title || wheelTrack?.file_name}
                    </div>
                    <span className="font-mono text-cm-cyan">{wheelKeys[activeWheelSource]}</span> — τα τονισμένα ταιριάζουν αρμονικά
                  </> : "Επίλεξε track με αναγνωρισμένο key για να δεις συμβατότητα."}
                </div>
              </div>
            ) : (
              <div aria-live="polite" className="mt-3 text-xs text-cm-faint">Πρόσθεσε, επίλεξε ή παίξε track με αναγνωρισμένο key για να δεις το wheel.</div>
            )}
          </GlassPanel>
        </aside>
      </div>
    </div>
    {duplicateDialog}
    <Dialog open={dialog !== null} onOpenChange={open => { if (!open && !savingDialog) setDialog(null); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{dialog?.kind === "pair" ? `Μετάβαση ${dialog.from.title || dialog.from.file_name} → ${dialog.to.title || dialog.to.file_name}` : "Νέο set"}</DialogTitle></DialogHeader>
        <form onSubmit={saveDialog} className="space-y-4">
          {dialog?.kind === "new" ? <label className="block space-y-2">Τίτλος set<Input autoFocus required value={titleInput} onChange={e => setTitleInput(e.target.value)} /></label> : <>
            <label className="block space-y-2">Τύπος μετάβασης<Input autoFocus placeholder="long blend, hard cut…" value={transitionInput} onChange={e => setTransitionInput(e.target.value)} /></label>
            <label className="block space-y-2">Βαθμός 1–5<Input type="number" min={1} max={5} step={1} value={ratingInput} onChange={e => setRatingInput(e.target.value)} /></label>
            <label className="block space-y-2">Σημείωση<Textarea aria-label="Σημείωση" value={noteInput} onChange={e => setNoteInput(e.target.value)} /></label>
          </>}
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={savingDialog} onClick={() => setDialog(null)}>Ακύρωση</Button><Button type="submit" disabled={savingDialog}>{savingDialog ? "Αποθήκευση…" : "Αποθήκευση"}</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  </div>
  );
}
