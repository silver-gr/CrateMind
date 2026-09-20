import { useCallback, useEffect, useState, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Button } from "../components/ui/button";
import { sortTracks, type SortState } from "../lib/trackSort";
import Curve from "../components/Curve";
import RecommendationCard from "../components/RecommendationCard";
import SetTimeline from "../components/SetTimeline";
import TrackTable from "../components/TrackTable";
import { GlassPanel } from "../components/ui/GlassPanel";
import { KeyWheel } from "../components/ui/KeyWheel";
import { SectionHeader } from "../components/ui/SectionHeader";
import { SmartChip } from "../components/ui/SmartChip";
import { ResizeHandle } from "../components/ui/ResizeHandle";
import { useResizable } from "../lib/useResizable";
import { recMatchPercents } from "../lib/aggregate";
import { api } from "../lib/api";
import { camelotCode, toCamelot } from "../lib/camelot";
import { Clock, Copy, ListMusic, Play, Plus, Save, Search, Sparkles, TriangleAlert } from "../lib/icons";
import { translateSetWarning } from "../lib/labels";
import { usePlayer } from "../lib/player";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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

function fmtDur(s: number) {
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
}

const EXPORTS: { fmt: "m3u" | "csv" | "markdown" | "json-backup"; label: string }[] = [
  { fmt: "m3u", label: "M3U" },
  { fmt: "csv", label: "CSV" },
  { fmt: "markdown", label: "Markdown" },
  { fmt: "json-backup", label: "JSON" },
];

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-white/8 bg-white/[0.02] px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wide text-cm-faint">{label}</div>
      <div className="mt-0.5 font-mono text-sm tabular-nums text-cm-text">{value}</div>
    </div>
  );
}

export default function SetBuilder() {
  const [params, setParams] = useSearchParams();
  const [sets, setSets] = useState<DJSet[]>([]);
  const [setId, setSetId] = useState<number | null>(null);
  const [rows, setRows] = useState<SetTrackRow[]>([]);
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
  const [pairNotes, setPairNotes] = useState<Record<string, PairNote>>({});
  const { play } = usePlayer();

  const loadSets = useCallback(async () => {
    setSets(await api.listSets());
  }, []);

  const loadSet = useCallback(async (id: number) => {
    const data = await api.getSet(id);
    setRows(data.tracks);
    setAnalysis(await api.setAnalysis(id));
    const notes = await api.listAllPairNotes();
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
    if (setId !== null) loadSet(setId);
  }, [setId, loadSet]);
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
    if (setId === null) return;
    await api.addSetTrack(setId, trackId);
    loadSet(setId);
  }
  async function remove(trackId: number) {
    if (setId === null) return;
    await api.removeSetTrack(setId, trackId);
    loadSet(setId);
  }
  async function reorder(from: number, to: number) {
    if (setId === null || to < 0 || to >= rows.length) return;
    const ids = rows.map((r) => r.track.id);
    const [m] = ids.splice(from, 1);
    ids.splice(to, 0, m);
    await api.reorderSet(setId, ids);
    loadSet(setId);
  }
  async function commitOrder(ids: number[]) {
    if (setId === null) return;
    await api.reorderSet(setId, ids);
    loadSet(setId);
  }

  async function recommendNext() {
    if (setId === null) return;
    setRecLabel("Επόμενο track");
    setRecs(await api.recommendNext(setId, { limit: 12 }));
  }
  async function bridgeBetween(i: number) {
    if (setId === null || i + 1 >= rows.length) return;
    const a = rows[i].track;
    const b = rows[i + 1].track;
    setRecLabel(`Γέφυρα: ${a.title || a.file_name} → ${b.title || b.file_name}`);
    setRecs(await api.recommendNext(setId, {
      after_track_id: a.id,
      before_track_id: b.id,
      need_bridge: true,
      limit: 12,
    }));
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

  async function doExport(fmt: "m3u" | "csv" | "markdown" | "json-backup") {
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

  // Real per-key counts within this set + the key it currently ends on.
  const keyCounts: Record<string, number> = {};
  for (const r of rows) {
    const c = toCamelot(r.track.key_text);
    if (c) {
      const code = camelotCode(c);
      keyCounts[code] = (keyCounts[code] ?? 0) + 1;
    }
  }
  const lastKey = rows.length ? rows[rows.length - 1].track.key_text ?? null : null;
  const lastCam = lastKey ? toCamelot(lastKey) : null;

  const keyPath = rows
    .map((r) => {
      const c = toCamelot(r.track.key_text);
      return c ? camelotCode(c) : null;
    })
    .filter((x): x is string => x != null);

  const bpms = (analysis?.bpm_curve ?? []).filter((v): v is number => v != null);
  const bpmLo = bpms.length ? Math.min(...bpms) : null;
  const bpmHi = bpms.length ? Math.max(...bpms) : null;

  return (
    <div className="flex h-full flex-col">
      {/* header */}
      <header className="flex flex-wrap items-center gap-3 border-b border-black/10 dark:border-white/10 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <Select
            value={setId !== null ? String(setId) : undefined}
            onValueChange={(v) => selectSet(Number(v))}
          >
            <SelectTrigger className="h-9 min-w-[180px] max-w-[300px] border-white/10 bg-cm-panel/60 text-base font-semibold text-cm-text focus:border-cm-cyan/40 focus:ring-cm-cyan/30">
              <SelectValue placeholder="χωρίς sets" />
            </SelectTrigger>
            <SelectContent>
              {sets.map((s) => (
                <SelectItem key={s.id} value={String(s.id)}>
                  {s.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <button
            onClick={newSet}
            title="Νέο set"
            className="inline-flex cursor-pointer items-center gap-1 rounded-lg bg-cm-cyan/12 px-2.5 py-1.5 text-sm font-medium text-cm-cyan transition hover:bg-cm-cyan/25"
          >
            <Plus className="h-3.5 w-3.5" /> Νέο
          </button>
          {analysis && (
            <div className="flex items-center gap-1.5">
              <SmartChip tone="muted" icon={ListMusic} className="px-2 py-0.5 text-[11px]">
                {analysis.track_count} tracks
              </SmartChip>
              <SmartChip tone="muted" icon={Clock} className="px-2 py-0.5 font-mono text-[11px] tabular-nums">
                {fmtDur(analysis.total_duration)}
              </SmartChip>
            </div>
          )}
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={saveSet}
            disabled={setId === null}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-cm-cyan/15 px-3 py-1.5 text-sm font-medium text-cm-cyan transition hover:bg-cm-cyan/25 disabled:cursor-default disabled:opacity-40"
          >
            <Save className="h-3.5 w-3.5" /> Αποθήκευση
          </button>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-cm-faint">Export</span>
            <div className="flex items-center gap-0.5 rounded-lg border border-white/10 bg-white/5 p-0.5">
              {EXPORTS.map(({ fmt, label }) => (
                <button
                  key={fmt}
                  onClick={() => doExport(fmt)}
                  disabled={setId === null}
                  className="inline-flex cursor-pointer items-center rounded-md px-2 py-1 text-[11px] text-cm-muted transition hover:bg-white/10 hover:text-cm-text disabled:cursor-default disabled:opacity-40"
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <button
            onClick={duplicateSet}
            disabled={setId === null}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-cm-muted transition hover:bg-white/10 hover:text-cm-text disabled:cursor-default disabled:opacity-40"
          >
            <Copy className="h-3.5 w-3.5" /> Αντίγραφο
          </button>
        </div>
      </header>

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
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-cm-faint" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="φίλτρο υποψηφίων…"
                className="w-full rounded-lg border border-black/10 dark:border-white/10 bg-cm-panel/60 py-1.5 pl-8 pr-2 text-sm text-cm-text placeholder:text-cm-faint focus:border-cm-cyan/40 focus:outline-none focus:ring-1 focus:ring-cm-cyan/30"
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
              onSelect={() => {}}
              onPlay={play}
              onAdd={add}
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
          <div className="min-h-0 flex-1 overflow-auto">
            <SetTimeline
              rows={rows}
              pairNotes={pairNotes}
              onReorder={commitOrder}
              onMove={reorder}
              onRemove={remove}
              onPlay={play}
              onBridge={bridgeBetween}
              onAddPairNote={addPairNote}
            />
          </div>
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
          <aside className="flex-1 space-y-4 overflow-y-auto p-4">
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
                <Stat label="Διάρκεια" value={fmtDur(analysis.total_duration)} />
                <Stat label="Tracks" value={analysis.track_count} />
                <Stat label="BPM" value={bpmLo != null ? `${bpmLo}–${bpmHi}` : "—"} />
                <Stat label="Keys" value={keyPath.length} />
              </div>

              {keyPath.length > 0 && (
                <div className="mt-3">
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-cm-faint">Διαδρομή key</div>
                  <div className="flex flex-wrap gap-1">
                    {keyPath.map((code, i) => (
                      <span key={i} className="rounded bg-cm-violet/12 px-1.5 py-0.5 font-mono text-[10px] text-cm-violet">
                        {code}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {analysis.transition_warnings.length > 0 && (
                <Alert variant="destructive" className="mt-3 border-cm-rose/30 bg-cm-rose/8">
                  <TriangleAlert />
                  <AlertTitle>Προειδοποιήσεις μετάβασης</AlertTitle>
                  <AlertDescription className="text-[11px] text-cm-rose/90">
                    {analysis.transition_warnings.map((w, i) => (
                      <div key={i} className="flex items-start gap-1.5">
                        <span className="font-mono tabular-nums">@{w.from_position}</span>
                        <span>{translateSetWarning(w.message)}</span>
                      </div>
                    ))}
                  </AlertDescription>
                </Alert>
              )}

              {Object.keys(analysis.repeated_artists).length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-cm-faint">Επανάληψη:</span>
                  {Object.entries(analysis.repeated_artists).map(([a, c]) => (
                    <SmartChip key={a} tone="amber" className="px-2 py-0.5">
                      {a} ×{c}
                    </SmartChip>
                  ))}
                </div>
              )}

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
            <button
              onClick={recommendNext}
              disabled={setId === null}
              className="inline-flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-cm-cyan/12 py-2 text-sm font-medium text-cm-cyan transition hover:bg-cm-cyan/25 disabled:cursor-default disabled:opacity-40"
            >
              <Sparkles className="h-4 w-4" /> Πρότεινε επόμενο track
            </button>
            {recLabel && <div className="mt-2 text-xs text-cm-muted">{recLabel}</div>}
            <div ref={recsParent} className="mt-3 space-y-2">
              {recs.length === 0 ? (
                <div className="text-[11px] text-cm-faint">
                  Τρέξε πρόταση για να δεις επόμενα tracks.
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
            {rows.length > 0 ? (
              <div className="flex flex-col items-center gap-2">
                <KeyWheel counts={keyCounts} selected={lastKey} size={236} />
                {lastCam && (
                  <div className="text-[11px] text-cm-muted">
                    Τέλος set: <span className="font-mono text-cm-cyan">{camelotCode(lastCam)}</span> — τα τονισμένα ταιριάζουν αρμονικά
                  </div>
                )}
              </div>
            ) : (
              <div className="text-xs text-cm-faint">Πρόσθεσε tracks για να δεις το wheel.</div>
            )}
          </GlassPanel>
        </aside>
      </div>
    </div>
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
