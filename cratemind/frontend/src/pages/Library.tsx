import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import TrackTable, { type TrackTableHandle } from "../components/TrackTable";
import ProfileEditor from "../components/ProfileEditor";
import { SmartChip } from "../components/ui/SmartChip";
import { EmptyState } from "../components/ui/EmptyState";
import { api } from "../lib/api";
import { Flame, Plus, Save, Search, X } from "../lib/icons";
import { usePlayer } from "../lib/player";
import { parseQueryChips } from "../lib/queryChips";
import type { DJSet, Track, TrackDetail } from "../lib/types";

const PRESETS: { label: string; q: string; flagship?: boolean }[] = [
  { label: "Όλα", q: "" },
  { label: "Χωρίς tags", q: "untagged" },
  { label: "Εγκεκριμένα", q: "approved" },
  { label: "Όπλα", q: "weapons" },
  { label: "Γέφυρα", q: "role:bridge" },
  { label: "Κορύφωση", q: "role:peak" },
  { label: "Ρίσκο", q: "weirdness:7+" },
  { label: "Δραματικά", q: "dramatic" },
  { label: "Χωρίς play 30η", q: "not_recent:30" },
  { label: "Ξεχασμένα εγκεκριμένα", q: "status:approved not_recent:90" },
  { label: "Δεν παίχτηκαν ποτέ", q: "never_played" },
  {
    label: "Όπλα για γέφυρα κορύφωσης",
    q: "status:approved darkness:7+ energy:8+ bpm:150-160 role:bridge break:long tolerance:huge not_recent:30 dramatic",
    flagship: true,
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
  const { play } = usePlayer();
  const tableRef = useRef<TrackTableHandle>(null);

  const load = useCallback(async (q: string) => {
    setLoading(true);
    setError(null);
    try {
      setTracks(await api.listTracks(q, 2000));
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
    toast.success(`Προστέθηκε "${t?.title || t?.file_name}" στο set`);
  }

  async function newSetForCrate() {
    const title = prompt("Τίτλος νέου set;");
    if (!title) return;
    const s = await api.createSet(title);
    setSets(await api.listSets());
    setActiveSetId(s.id);
  }

  async function saveCrate() {
    const name = prompt("Όνομα crate;", query.slice(0, 40));
    if (!name) return;
    await api.createSearch(name, query);
    toast.success(`Σώθηκε το crate "${name}"`);
  }

  // J/K navigation
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key !== "j" && e.key !== "k") return;
      const idx = tracks.findIndex((t) => t.id === selected?.track.id);
      const next = e.key === "j" ? idx + 1 : idx - 1;
      if (next >= 0 && next < tracks.length) {
        select(tracks[next].id);
        tableRef.current?.scrollToIndex(next);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tracks, selected, select]);

  const chips = query.trim() ? parseQueryChips(query) : [];

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="border-b border-white/8 bg-cm-bg-2/40 p-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              runQuery(query);
            }}
            className="flex gap-2"
          >
            <div className="glass flex flex-1 items-center gap-2 rounded-xl px-3 py-2 transition focus-within:ring-1 focus-within:ring-cm-cyan/40">
              <Search className="h-4 w-4 shrink-0 text-cm-faint" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Αναζήτηση — π.χ. energy:7-9 darkness:6-10 role:peak bpm:148-155 status:approved"
                className="min-w-0 flex-1 bg-transparent text-sm text-cm-text outline-none placeholder:text-cm-faint"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => {
                    setQuery("");
                    runQuery("");
                  }}
                  aria-label="Καθαρισμός αναζήτησης"
                  title="Καθαρισμός αναζήτησης"
                  className="flex shrink-0 cursor-pointer items-center justify-center rounded p-0.5 text-cm-faint transition hover:text-cm-text"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={saveCrate}
              disabled={!query.trim()}
              className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-xl border border-white/10 bg-cm-panel px-3 py-2 text-sm text-cm-text transition hover:border-cm-cyan/30 hover:bg-cm-cyan/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Save className="h-3.5 w-3.5" />
              Αποθήκευση ως crate
            </button>
          </form>

          {chips.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {chips.map((chip, i) => (
                <SmartChip key={`${chip.label}-${i}`} tone={chip.tone}>
                  {chip.label}
                </SmartChip>
              ))}
            </div>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {PRESETS.map((p) => (
              <SmartChip
                key={p.label}
                tone={p.flagship ? "chartreuse" : "muted"}
                icon={p.flagship ? Flame : undefined}
                active={query.trim() === p.q.trim()}
                onClick={() => runQuery(p.q)}
                className={p.flagship ? "glow-chartreuse" : undefined}
              >
                {p.label}
              </SmartChip>
            ))}
          </div>

          <div className="mt-3 flex items-center gap-2 text-xs">
            <span className="text-cm-faint">Προσθήκη στο set:</span>
            <select
              value={activeSetId ?? ""}
              onChange={(e) => setActiveSetId(e.target.value ? Number(e.target.value) : null)}
              className="cursor-pointer rounded-lg border border-white/10 bg-cm-panel px-2 py-1 text-cm-text outline-none transition focus:border-cm-cyan/30"
            >
              <option value="">— κανένα —</option>
              {sets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
            <button
              onClick={newSetForCrate}
              className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-cm-cyan/25 bg-cm-cyan/12 px-2 py-1 text-cm-cyan transition hover:bg-cm-cyan/20"
            >
              <Plus className="h-3 w-3" /> Νέο set
            </button>
            <span className="ml-auto text-cm-muted">
              {loading ? "φόρτωση…" : `${tracks.length} tracks`} · J/K για πλοήγηση
            </span>
          </div>

          {error && <div className="mt-2 text-xs text-cm-rose">{error}</div>}
        </div>
        <div className="min-h-0 flex-1">
          <TrackTable
            ref={tableRef}
            tracks={tracks}
            selectedId={selected?.track.id}
            onSelect={select}
            onPlay={play}
            onAdd={activeSetId !== null ? addToActiveSet : undefined}
          />
        </div>
      </div>

      <aside className="w-96 shrink-0 overflow-auto border-l border-white/8 bg-cm-bg-2 p-4">
        {selected ? (
          <ProfileEditor detail={selected} onSaved={() => select(selected.track.id)} />
        ) : (
          <EmptyState icon={Search} title="Δεν έχει επιλεγεί track" className="mt-6">
            Διάλεξε track για να επεξεργαστείς το DJ προφίλ του.
          </EmptyState>
        )}
      </aside>
    </div>
  );
}
