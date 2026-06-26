import { useCallback, useEffect, useState } from "react";
import Curve from "../components/Curve";
import TrackTable from "../components/TrackTable";
import { api } from "../lib/api";
import { usePlayer } from "../lib/player";
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
  const [msg, setMsg] = useState("");
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
    const title = prompt("Set title?");
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

  async function recommendNext() {
    if (setId === null) return;
    setRecLabel("Next track");
    setRecs(await api.recommendNext(setId, { limit: 12 }));
  }
  async function bridgeBetween(i: number) {
    if (setId === null || i + 1 >= rows.length) return;
    const a = rows[i].track;
    const b = rows[i + 1].track;
    setRecLabel(`Bridge: ${a.title || a.file_name} → ${b.title || b.file_name}`);
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
    const transition_type = prompt(`Transition ${a.title} → ${b.title}\nType? (e.g. breakdown swap, long blend, hard cut)`);
    if (transition_type === null) return;
    const ratingStr = prompt("Rating 1–5?", "4");
    const notes = prompt("Note?", "");
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
    setMsg(`Logged play for ${r.tracks_logged} tracks`);
    loadSet(setId);
  }

  async function doExport(fmt: "m3u" | "csv" | "markdown" | "json-backup") {
    if (setId === null) return;
    try {
      const r = await api.exportArtifact(fmt, { set_id: setId, overwrite: true });
      setMsg(`Exported → ${r.path}`);
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <div className="flex h-full">
      {/* candidates */}
      <div className="flex w-1/3 min-w-0 flex-col border-r border-neutral-800">
        <div className="border-b border-neutral-800 p-3">
          <div className="mb-2 text-xs uppercase text-neutral-500">Candidates</div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="filter candidates…"
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm"
          />
        </div>
        <div className="min-h-0 flex-1">
          <TrackTable tracks={candidates} onSelect={() => {}} onPlay={play} onAdd={add} />
        </div>
      </div>

      {/* timeline */}
      <div className="flex w-1/3 min-w-0 flex-col border-r border-neutral-800">
        <div className="flex items-center gap-2 border-b border-neutral-800 p-3">
          <select
            value={setId ?? ""}
            onChange={(e) => setSetId(Number(e.target.value))}
            className="flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm"
          >
            {sets.length === 0 && <option value="">no sets</option>}
            {sets.map((s) => (
              <option key={s.id} value={s.id}>{s.title}</option>
            ))}
          </select>
          <button onClick={newSet} className="rounded bg-emerald-700 px-2 py-1.5 text-sm hover:bg-emerald-600">
            + New
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {rows.map((r, i) => {
            const next = rows[i + 1];
            const note = next ? pairNotes[`${r.track.id}-${next.track.id}`] : undefined;
            return (
              <div key={r.track.id}>
                <div className="flex items-center gap-2 rounded bg-neutral-900 px-2 py-1.5 text-sm">
                  <span className="w-6 text-center text-xs text-neutral-600">{i + 1}</span>
                  <div className="min-w-0 flex-1 truncate">
                    <span className="text-neutral-200">{r.track.title || r.track.file_name}</span>
                    <span className="ml-2 text-xs text-neutral-500">
                      {r.track.bpm ? `${r.track.bpm.toFixed(0)}` : "—"}{" "}
                      {r.profile?.energy ? `E${r.profile.energy}` : ""}{" "}
                      {r.profile?.personal_status && r.profile.personal_status !== "unknown"
                        ? r.profile.personal_status
                        : ""}
                    </span>
                  </div>
                  <button onClick={() => reorder(i, i - 1)} className="text-neutral-500 hover:text-white">▲</button>
                  <button onClick={() => reorder(i, i + 1)} className="text-neutral-500 hover:text-white">▼</button>
                  <button onClick={() => remove(r.track.id)} className="text-neutral-500 hover:text-red-400">×</button>
                </div>
                {next && (
                  <div className="flex items-center gap-2 py-0.5 pl-8 text-xs">
                    <button
                      onClick={() => bridgeBetween(i)}
                      className="rounded bg-neutral-800 px-2 py-0.5 text-neutral-300 hover:bg-emerald-800"
                    >
                      ⇄ bridge
                    </button>
                    <button
                      onClick={() => addPairNote(i)}
                      className="text-neutral-600 hover:text-neutral-300"
                    >
                      {note ? "✎ note" : "+ note"}
                    </button>
                    {note && (
                      <span className="truncate text-emerald-500/80" title={note.notes ?? ""}>
                        {note.transition_type}{note.rating ? ` ${note.rating}/5` : ""}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {rows.length === 0 && (
            <div className="p-4 text-sm text-neutral-600">Empty set. Add candidates from the left.</div>
          )}
        </div>
        <div className="flex flex-wrap gap-1 border-t border-neutral-800 p-2">
          <button
            onClick={markPlayed}
            disabled={setId === null}
            className="rounded bg-emerald-800 px-2 py-1 text-xs hover:bg-emerald-700 disabled:opacity-40"
          >
            ▶ Mark set played
          </button>
          {(["m3u", "csv", "markdown", "json-backup"] as const).map((f) => (
            <button
              key={f}
              onClick={() => doExport(f)}
              disabled={setId === null}
              className="rounded bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-700 disabled:opacity-40"
            >
              export {f}
            </button>
          ))}
          {msg && <div className="w-full text-xs text-emerald-400">{msg}</div>}
        </div>
      </div>

      {/* analysis */}
      <aside className="w-1/3 shrink-0 overflow-auto bg-neutral-950 p-4">
        <div className="mb-3 text-xs uppercase text-neutral-500">Analysis</div>
        {analysis && (
          <div className="space-y-3 text-sm">
            <div className="text-neutral-400">
              {analysis.track_count} tracks · {fmtDur(analysis.total_duration)}
            </div>
            <Curve label="BPM" values={analysis.bpm_curve} color="#60a5fa" />
            <Curve label="Energy" values={analysis.energy_curve} min={0} max={10} color="#34d399" />
            <Curve label="Darkness" values={analysis.darkness_curve} min={0} max={10} color="#a78bfa" />

            {analysis.transition_warnings.length > 0 && (
              <div>
                <div className="text-xs font-semibold text-amber-400">Transition warnings</div>
                {analysis.transition_warnings.map((w, i) => (
                  <div key={i} className="text-xs text-amber-300/80">@{w.from_position}: {w.message}</div>
                ))}
              </div>
            )}
            {Object.keys(analysis.repeated_artists).length > 0 && (
              <div className="text-xs text-neutral-400">
                Repeated artists:{" "}
                {Object.entries(analysis.repeated_artists).map(([a, c]) => `${a} ×${c}`).join(", ")}
              </div>
            )}
            {analysis.not_approved.length > 0 && (
              <div className="text-xs text-neutral-500">{analysis.not_approved.length} not human-approved</div>
            )}
          </div>
        )}

        <div className="mt-5">
          <button
            onClick={recommendNext}
            disabled={setId === null}
            className="w-full rounded bg-emerald-700 py-2 text-sm hover:bg-emerald-600 disabled:opacity-40"
          >
            Recommend next track
          </button>
          {recLabel && <div className="mt-2 text-xs text-neutral-400">{recLabel}</div>}
          <div className="mt-2 space-y-2">
            {recs.map((r) => (
              <div key={r.track_id} className="rounded border border-neutral-800 bg-neutral-900 p-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-neutral-200">{r.artist} — {r.title}</span>
                  <span className="tabular-nums text-emerald-400">{r.score}</span>
                </div>
                <div className="text-neutral-500">
                  {r.bpm ? `${r.bpm.toFixed(0)} BPM` : ""} {r.key || ""} {r.personal_status}
                </div>
                <ul className="mt-1 text-neutral-400">
                  {r.reasons.map((reason, i) => (<li key={i}>{reason}</li>))}
                </ul>
                <button
                  onClick={() => add(r.track_id)}
                  className="mt-1 rounded bg-emerald-800 px-2 py-0.5 hover:bg-emerald-700"
                >
                  + add to set
                </button>
              </div>
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}
