import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import TrackTable from "../components/TrackTable";
import ProfileEditor from "../components/ProfileEditor";
import { api } from "../lib/api";
import type { DJSet, Track, TrackDetail } from "../lib/types";

const PRESETS: { label: string; q: string }[] = [
  { label: "All", q: "" },
  { label: "Untagged", q: "untagged" },
  { label: "Approved", q: "approved" },
  { label: "Weapons", q: "weapons" },
  { label: "Bridge", q: "role:bridge" },
  { label: "Peak", q: "role:peak" },
  { label: "Risky", q: "weirdness:7+" },
  { label: "Dramatic", q: "dramatic" },
  { label: "Not played 30d", q: "not_recent:30" },
  { label: "Forgotten Approved", q: "status:approved not_recent:90" },
  { label: "Never played", q: "never_played" },
  {
    label: "🔥 Peak bridge weapons",
    q: "status:approved darkness:7+ energy:8+ bpm:150-160 role:bridge break:long tolerance:huge not_recent:30 dramatic",
  },
];

export default function Library() {
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [tracks, setTracks] = useState<Track[]>([]);
  const [selected, setSelected] = useState<TrackDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [sets, setSets] = useState<DJSet[]>([]);
  const [activeSetId, setActiveSetId] = useState<number | null>(null);
  const [flash, setFlash] = useState("");

  const load = useCallback(async (q: string) => {
    setLoading(true);
    setError(null);
    try {
      setTracks(await api.listTracks(q));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // honor ?q= from the dashboard / deep links (re-runs when the param changes)
  useEffect(() => {
    const q = params.get("q") ?? "";
    setQuery(q);
    load(q);
  }, [params, load]);

  useEffect(() => {
    api.listSets().then(setSets);
  }, []);

  const runQuery = (q: string) => setParams(q ? { q } : {});

  const select = useCallback(async (id: number) => {
    setSelected(await api.getTrack(id));
  }, []);

  async function addToActiveSet(trackId: number) {
    if (activeSetId === null) return;
    await api.addSetTrack(activeSetId, trackId);
    const t = tracks.find((x) => x.id === trackId);
    setFlash(`Added "${t?.title || t?.file_name}" to set`);
  }

  async function newSetForCrate() {
    const title = prompt("New set title?");
    if (!title) return;
    const s = await api.createSet(title);
    setSets(await api.listSets());
    setActiveSetId(s.id);
  }

  async function saveCrate() {
    const name = prompt("Crate name?", query.slice(0, 40));
    if (!name) return;
    await api.createSearch(name, query);
    setFlash(`Saved crate "${name}"`);
  }

  // J/K navigation
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key !== "j" && e.key !== "k") return;
      const idx = tracks.findIndex((t) => t.id === selected?.track.id);
      const next = e.key === "j" ? idx + 1 : idx - 1;
      if (next >= 0 && next < tracks.length) select(tracks[next].id);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tracks, selected, select]);

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="border-b border-neutral-800 p-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              runQuery(query);
            }}
            className="flex gap-2"
          >
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder='Search — e.g. energy:7-9 darkness:6-10 role:peak bpm:148-155 status:approved'
              className="flex-1 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
            />
            <button
              type="button"
              onClick={saveCrate}
              disabled={!query.trim()}
              className="rounded bg-neutral-800 px-3 py-2 text-sm hover:bg-neutral-700 disabled:opacity-40"
            >
              Save as crate
            </button>
          </form>
          <div className="mt-2 flex flex-wrap items-center gap-1">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => runQuery(p.q)}
                className="rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-700"
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2 text-xs">
            <span className="text-neutral-500">Add to set:</span>
            <select
              value={activeSetId ?? ""}
              onChange={(e) => setActiveSetId(e.target.value ? Number(e.target.value) : null)}
              className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
            >
              <option value="">— none —</option>
              {sets.map((s) => (
                <option key={s.id} value={s.id}>{s.title}</option>
              ))}
            </select>
            <button onClick={newSetForCrate} className="rounded bg-emerald-800 px-2 py-1 hover:bg-emerald-700">
              + New set
            </button>
            <span className="ml-auto text-neutral-500">
              {loading ? "loading…" : `${tracks.length} tracks`} · J/K to navigate
            </span>
          </div>
          {flash && <div className="mt-2 text-xs text-emerald-400">{flash}</div>}
          {error && <div className="mt-2 text-xs text-red-400">{error}</div>}
        </div>
        <div className="min-h-0 flex-1">
          <TrackTable
            tracks={tracks}
            selectedId={selected?.track.id}
            onSelect={select}
            onAdd={activeSetId !== null ? addToActiveSet : undefined}
          />
        </div>
      </div>

      <aside className="w-96 shrink-0 overflow-auto border-l border-neutral-800 bg-neutral-950 p-4">
        {selected ? (
          <ProfileEditor detail={selected} onSaved={() => select(selected.track.id)} />
        ) : (
          <div className="text-sm text-neutral-600">Select a track to edit its DJ profile.</div>
        )}
      </aside>
    </div>
  );
}
