import { preferenceStorage } from "../lib/preferenceStorage";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import TrackTable, { type TrackTableHandle } from "../components/TrackTable";
import CanonicalTrackCard from "../components/CanonicalTrackCard";
import ProfileEditor from "../components/ProfileEditor";
import SoundCloudReviewDrawer from "../components/SoundCloudReviewDrawer";
import { SmartChip } from "../components/ui/SmartChip";
import { EmptyState } from "../components/ui/EmptyState";
import { ResizeHandle } from "../components/ui/ResizeHandle";
import { useResizable } from "../lib/useResizable";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "../lib/api";
import { useSetTrackAddition } from "../lib/useSetTrackAddition";
import { hasProviderWorkflows, useCapabilities } from "../lib/capabilities";
import { isTypingTarget } from "../lib/keyboardGuard";
import { Flame, Plus, Radio, Save, Search } from "../lib/icons";
import { usePlayer } from "../lib/player";
import { parseQueryChips } from "../lib/queryChips";
import { sortTracks, type SortKey } from "../lib/trackSort";
import type { DJSet, SoundCloudSummary, SoundCloudTrackDetail, Track } from "../lib/types";

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
  const { addToSet, duplicateDialog } = useSetTrackAddition();
  const providerWorkflows = hasProviderWorkflows(useCapabilities());
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [tracks, setTracks] = useState<Track[]>([]);
  const [selected, setSelected] = useState<SoundCloudTrackDetail | null>(null);
  const [selectionLoading, setSelectionLoading] = useState(false);
  const selectionRequest = useRef(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" } | null>(() => {
    try {
      const stored = preferenceStorage.getItem("cratemind:library-sort");
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  });

  const [sets, setSets] = useState<DJSet[]>([]);
  const [activeSetId, setActiveSetId] = useState<number | null>(null);
  const [soundCloudSummary, setSoundCloudSummary] = useState<SoundCloudSummary | null>(null);
  const [soundCloudReviewOpen, setSoundCloudReviewOpen] = useState(false);
  const { play } = usePlayer();
  const tableRef = useRef<TrackTableHandle>(null);

  const {
    size: rightPanelWidth,
    isDragging: isRightDragging,
    handleProps: rightHandleProps,
  } = useResizable({
    direction: "horizontal",
    initial: 384,
    min: 280,
    max: 500,
    storageKey: "cm:library-sidebar-width",
    reverse: true,
  });

  const listRequest = useRef(0);
  const load = useCallback(async (q: string, background = false) => {
    const request = ++listRequest.current;
    if (!background) setLoading(true);
    setError(null);
    try {
      const rows = await api.listTracks(q, 10000);
      if (request === listRequest.current) setTracks(rows);
    } catch (e) {
      if (request === listRequest.current) setError((e as Error).message);
    } finally {
      if (request === listRequest.current) setLoading(false);
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

  const loadSoundCloudSummary = useCallback(async () => {
    if (!providerWorkflows) return;
    try {
      setSoundCloudSummary(await api.soundCloudSummary());
    } catch {
      setSoundCloudSummary(null);
    }
  }, [providerWorkflows]);

  useEffect(() => {
    void loadSoundCloudSummary();
  }, [loadSoundCloudSummary]);

  const runQuery = (q: string) => setParams(q ? { q } : {});

  const select = useCallback(async (id: number) => {
    const request = ++selectionRequest.current;
    // Hide the previous editor while switching so edits cannot target the old track.
    setSelected((current) => current?.track.id === id ? current : null);
    setSelectionLoading(true);
    try {
      const detail = await api.getTrack(id);
      if (request === selectionRequest.current) setSelected(detail);
    } catch {
      if (request === selectionRequest.current) toast.error("Δεν ήταν δυνατή η φόρτωση του track.");
    } finally {
      if (request === selectionRequest.current) setSelectionLoading(false);
    }
  }, []);

  const playFromTable = (track: Track) => {
    void select(track.id);
    play(track);
  };

  // Sorted view feeds BOTH the table and J/K math, so scrollToIndex stays aligned.
  const view = useMemo(() => sortTracks(tracks, sort), [tracks, sort]);

  // Header click: asc → desc → cleared (back to server order).
  function toggleSort(key: SortKey) {
    setSort((s) => {
      const next =
        !s || s.key !== key
          ? { key, dir: "asc" as const }
          : s.dir === "asc"
            ? { key, dir: "desc" as const }
            : null;
      if (next) preferenceStorage.setItem("cratemind:library-sort", JSON.stringify(next));
      else preferenceStorage.removeItem("cratemind:library-sort");
      return next;
    });
  }

  async function addToActiveSet(trackId: number) {
    if (activeSetId === null) return;
    if (!await addToSet(activeSetId, trackId)) return;
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
      if (isTypingTarget(e.target)) return;
      if (e.key !== "j" && e.key !== "k") return;
      const idx = view.findIndex((t) => t.id === selected?.track.id);
      const next = e.key === "j" ? idx + 1 : idx - 1;
      if (next >= 0 && next < view.length) {
        select(view[next].id);
        tableRef.current?.scrollToIndex(next);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, selected, select]);

  const chips = query.trim() ? parseQueryChips(query) : [];

  return (
    <>
      {duplicateDialog}
      <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="border-b border-cm-border bg-cm-bg-2/40 p-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              runQuery(query);
            }}
            className="flex gap-2"
          >
            <div className="glass flex flex-1 items-center gap-2 rounded-xl px-3 py-2 transition focus-within:ring-1 focus-within:ring-cm-cyan/40">
              <Search className="h-4 w-4 shrink-0 text-cm-faint" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onClear={() => runQuery("")}
                wrapperClassName="min-w-0 flex-1"
                title="Ημερομηνίες: added:30, created:60, added:30-60 ή added:2026-09-01..2026-09-30 (UTC)"
                placeholder="Αναζήτηση — π.χ. energy:7-9 darkness:6-10 role:peak bpm:148-155 status:approved"
                className="min-w-0 flex-1 border-none bg-transparent p-0 text-sm text-cm-text shadow-none ring-0 placeholder:text-cm-faint focus-visible:ring-0"
              />

            </div>
            <button
              type="button"
              onClick={saveCrate}
              disabled={!query.trim()}
              className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-xl border border-cm-cyan/30 bg-cm-cyan/12 px-3.5 py-2 text-sm font-medium text-cm-cyan transition hover:border-cm-cyan/50 hover:bg-cm-cyan/20 disabled:cursor-not-allowed disabled:opacity-40"
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
            <Select
              value={activeSetId === null ? "none" : String(activeSetId)}
              onValueChange={(v) => setActiveSetId(v === "none" ? null : Number(v))}
            >
              <SelectTrigger className="h-7 w-auto cursor-pointer rounded-lg border border-cm-line/20 dark:border-white/10 bg-cm-panel px-2 py-1 text-xs text-cm-text focus:ring-0 focus:ring-offset-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— κανένα —</SelectItem>
                {sets.map((s) => (
                  <SelectItem key={s.id} value={String(s.id)}>
                    {s.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <button
              onClick={newSetForCrate}
              className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-cm-cyan/25 bg-cm-cyan/12 px-2 py-1 text-cm-cyan transition hover:bg-cm-cyan/20"
            >
              <Plus className="h-3 w-3" /> Νέο set
            </button>
            {providerWorkflows && <button
              type="button"
              onClick={() => setSoundCloudReviewOpen(true)}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-cm-amber/25 bg-cm-amber/10 px-2 py-1 text-cm-amber transition hover:bg-cm-amber/18"
            >
              <Radio className="h-3 w-3" />
              Έλεγχος SoundCloud
              <span className="rounded bg-cm-amber/15 px-1 font-mono text-[10px] tabular-nums">
                {soundCloudSummary?.pending_candidates ?? 0}
              </span>
            </button>}
            <a href="/canonical" className="text-cyan-300 underline">Κανονικά μεταδεδομένα</a>
            <span className="ml-auto text-cm-muted">
              {loading ? "φόρτωση…" : `${tracks.length} tracks`} · J/K για πλοήγηση
            </span>
          </div>

          {error && <div className="mt-2 text-xs text-cm-rose">{error}</div>}
        </div>
        <div className="min-h-0 flex-1">
          <TrackTable
            ref={tableRef}
            tracks={view}
            loading={loading}
            selectedId={selected?.track.id}
            onSelect={select}
            onPlay={playFromTable}
            onAdd={activeSetId !== null ? addToActiveSet : undefined}
            sortKey={sort?.key}
            sortDir={sort?.dir}
            onSort={toggleSort}
          />
        </div>
      </div>

      <div
        style={{ width: `${rightPanelWidth}px` }}
        className="relative shrink-0 flex flex-col h-full border-l border-cm-border"
      >
        <ResizeHandle
          orientation="vertical"
          isDragging={isRightDragging}
          ariaLabel="Αλλαγή πλάτους δεξιού panel"
          className="absolute -left-1.5 inset-y-0 z-30"
          {...rightHandleProps}
        />
        <aside
          aria-busy={selectionLoading}
          data-at-top="true"
          onScroll={(e) => {
            const el = e.currentTarget;
            const atTop = el.scrollTop <= 2;
            const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
            const topVal = atTop ? "true" : "false";
            const btmVal = atBottom ? "true" : "false";
            if (el.dataset.atTop !== topVal) el.dataset.atTop = topVal;
            if (el.dataset.atBottom !== btmVal) el.dataset.atBottom = btmVal;
          }}
          className="flex-1 overflow-y-auto p-4 scroll-fade-y"
        >
          {selected?.canonical && <CanonicalTrackCard value={selected.canonical} />}
          {selected && <p className="mb-2 text-xs text-cm-muted">Τοπική πηγή · αρχικά στοιχεία αρχείου</p>}
          {selected ? (
            <ProfileEditor
              key={selected.track.id}
              detail={selected}
              onSaved={async () => {
                const id = selected.track.id;
                await Promise.all([
                  load(params.get("q") ?? "", true),
                  api.getTrack(id).then(detail => setSelected(current => current?.track.id === id ? detail : current)),
                ]);
              }}
              onAddToSet={
                activeSetId !== null ? () => addToActiveSet(selected.track.id) : undefined
              }
              onReviewSoundCloud={providerWorkflows ? () => setSoundCloudReviewOpen(true) : undefined}
            />
          ) : selectionLoading ? (
            <p role="status" className="py-6 text-center text-sm text-cm-muted">Φόρτωση track…</p>
          ) : (
            <EmptyState icon={Search} title="Δεν έχει επιλεγεί track" className="mt-6">
              Διάλεξε track για να επεξεργαστείς το DJ προφίλ του.
            </EmptyState>
          )}
        </aside>
      </div>
      </div>
      {providerWorkflows && <SoundCloudReviewDrawer
        open={soundCloudReviewOpen}
        onOpenChange={setSoundCloudReviewOpen}
        onReviewChange={() => {
          void loadSoundCloudSummary();
          if (selected) void select(selected.track.id);
        }}
      />}
    </>
  );
}
