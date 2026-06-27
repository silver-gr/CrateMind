import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import Curve from "../components/Curve";
import RecommendationCard from "../components/RecommendationCard";
import SetTimeline from "../components/SetTimeline";
import TrackTable from "../components/TrackTable";
import { GlassPanel } from "../components/ui/GlassPanel";
import { SectionHeader } from "../components/ui/SectionHeader";
import { SmartChip } from "../components/ui/SmartChip";
import { api } from "../lib/api";
import { Download, Play, Plus, Search, Sparkles, TriangleAlert } from "../lib/icons";
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

export default function SetBuilder() {
  const [sets, setSets] = useState<DJSet[]>([]);
  const [setId, setSetId] = useState<number | null>(null);
  const [rows, setRows] = useState<SetTrackRow[]>([]);
  const [analysis, setAnalysis] = useState<SetAnalysis | null>(null);
  const [candidates, setCandidates] = useState<Track[]>([]);
  const [query, setQuery] = useState("");
  const [recs, setRecs] = useState<Recommendation[]>([]);
  const [recLabel, setRecLabel] = useState("");
  const [pairNotes, setPairNotes] = useState<Record<string, PairNote>>({});
  const { play } = usePlayer();

  const loadSets = useCallback(async () => {
    const s = await api.listSets();
    setSets(s);
    if (s.length && setId === null) setSetId(s[0].id);
  }, [setId]);

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
  useEffect(() => {
    if (setId !== null) loadSet(setId);
  }, [setId, loadSet]);
  useEffect(() => {
    api.listTracks(query).then(setCandidates);
  }, [query]);

  async function newSet() {
    const title = prompt("Τίτλος set;");
    if (!title) return;
    const s = await api.createSet(title);
    await loadSets();
    setSetId(s.id);
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

  async function addPairNote(i: number) {
    if (i + 1 >= rows.length) return;
    const a = rows[i].track;
    const b = rows[i + 1].track;
    const transition_type = prompt(`Μετάβαση ${a.title} → ${b.title}\nΤύπος; (π.χ. breakdown swap, long blend, hard cut)`);
    if (transition_type === null) return;
    const ratingStr = prompt("Βαθμός 1–5;", "4");
    const notes = prompt("Σημείωση;", "");
    await api.createPairNote({
      from_track_id: a.id,
      to_track_id: b.id,
      transition_type: transition_type || null,
      rating: ratingStr ? Number(ratingStr) : null,
      notes: notes || null,
    });
    if (setId !== null) loadSet(setId);
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

  const [recsParent] = useAutoAnimate<HTMLDivElement>();

  return (
    <div className="flex h-full">
      {/* candidates */}
      <div className="flex w-1/3 min-w-0 flex-col border-r border-white/8">
        <div className="border-b border-white/8 p-3">
          <SectionHeader>Υποψήφια tracks</SectionHeader>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-cm-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="φίλτρο υποψηφίων…"
              className="w-full rounded-lg border border-white/10 bg-cm-panel/60 py-1.5 pl-8 pr-2 text-sm text-cm-text placeholder:text-cm-faint focus:border-cm-cyan/40 focus:outline-none focus:ring-1 focus:ring-cm-cyan/30"
            />
          </div>
        </div>
        <div className="min-h-0 flex-1">
          <TrackTable tracks={candidates} variant="compact" onSelect={() => {}} onPlay={play} onAdd={add} />
        </div>
      </div>

      {/* timeline */}
      <div className="flex w-1/3 min-w-0 flex-col border-r border-white/8">
        <div className="flex items-center gap-2 border-b border-white/8 p-3">
          <Select
            value={setId !== null ? String(setId) : undefined}
            onValueChange={(v) => setSetId(Number(v))}
          >
            <SelectTrigger className="flex-1 border-white/10 bg-cm-panel/60 text-cm-text focus:border-cm-cyan/40 focus:ring-cm-cyan/30">
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
            className="inline-flex cursor-pointer items-center gap-1 rounded-lg bg-cm-cyan/12 px-2.5 py-1.5 text-sm font-medium text-cm-cyan transition hover:bg-cm-cyan/25"
          >
            <Plus className="h-3.5 w-3.5" /> Νέο
          </button>
        </div>

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

        <div className="flex flex-wrap items-center gap-1.5 border-t border-white/8 p-2">
          <button
            onClick={markPlayed}
            disabled={setId === null}
            className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-cm-chartreuse/12 px-2.5 py-1 text-xs font-medium text-cm-chartreuse transition hover:bg-cm-chartreuse/25 disabled:cursor-default disabled:opacity-40"
          >
            <Play className="h-3 w-3" /> Σήμανση set ως παιγμένο
          </button>
          {EXPORTS.map(({ fmt, label }) => (
            <button
              key={fmt}
              onClick={() => doExport(fmt)}
              disabled={setId === null}
              className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-cm-muted transition hover:bg-white/10 hover:text-cm-text disabled:cursor-default disabled:opacity-40"
            >
              <Download className="h-3 w-3" /> {label}
            </button>
          ))}
        </div>
      </div>

      {/* analysis + recommendations */}
      <aside className="w-1/3 shrink-0 space-y-4 overflow-auto p-4">
        <GlassPanel className="p-4">
          <SectionHeader
            right={
              analysis ? (
                <span className="font-mono text-xs tabular-nums text-cm-muted">
                  {analysis.track_count} · {fmtDur(analysis.total_duration)}
                </span>
              ) : undefined
            }
          >
            Ανάλυση
          </SectionHeader>
          {analysis ? (
            <div className="space-y-3 text-sm">
              <Curve label="BPM" values={analysis.bpm_curve} color="var(--color-cm-blue)" />
              <Curve label="Ενέργεια" values={analysis.energy_curve} min={0} max={10} color="var(--color-cm-chartreuse)" />
              <Curve label="Σκοτάδι" values={analysis.darkness_curve} min={0} max={10} color="var(--color-cm-violet)" />

              {analysis.transition_warnings.length > 0 && (
                <Alert variant="destructive" className="border-cm-rose/30 bg-cm-rose/8">
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
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-cm-faint">Επανάληψη:</span>
                  {Object.entries(analysis.repeated_artists).map(([a, c]) => (
                    <SmartChip key={a} tone="amber" className="px-2 py-0.5">
                      {a} ×{c}
                    </SmartChip>
                  ))}
                </div>
              )}

              {analysis.not_approved.length > 0 && (
                <div className="text-[11px] text-cm-faint">
                  {analysis.not_approved.length} χωρίς ανθρώπινη έγκριση
                </div>
              )}
            </div>
          ) : (
            <div className="text-xs text-cm-faint">Διάλεξε set για να δεις ανάλυση.</div>
          )}
        </GlassPanel>

        <GlassPanel className="p-4">
          <SectionHeader>Προτάσεις</SectionHeader>
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
              recs.map((r) => <RecommendationCard key={r.track_id} rec={r} onAdd={add} />)
            )}
          </div>
        </GlassPanel>
      </aside>
    </div>
  );
}
