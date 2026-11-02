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
import { Kbd } from "../components/ui/KeyboardHint";
import { NumberCount } from "../components/ui/NumberCount";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { LIBRARY_COLUMNS, columnLabel } from "../lib/tablePreferences";
import { tablePreferenceStore, useTablePreferences } from "../lib/useTablePreferences";
import { useResizable } from "../lib/useResizable";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "../lib/api";
import { useSetTrackAddition } from "../lib/useSetTrackAddition";
import { hasProviderWorkflows, useCapabilities } from "../lib/capabilities";
import { isTypingTarget } from "../lib/keyboardGuard";
import { useBrowseList } from "../lib/browseTarget";
import { Flame, ListFilter, Plus, Radio, RotateCcw, Save, Search } from "../lib/icons";
import { usePlayer, type DeckId } from "../lib/player";
import { parseQueryChips } from "../lib/queryChips";
import { useFacets } from "../lib/facets";
import { libraryPlaceholder } from "../lib/profileCopy";
import { BulkTagBar } from "../components/BulkTagBar";
import { sortTracks, type SortKey } from "../lib/trackSort";
import type { DJSet, SoundCloudSummary, SoundCloudTrackDetail, Track } from "../lib/types";
import SpecularButton from "../components/ui/SpecularButton";

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
  const { facets } = useFacets();
  const [tracks, setTracks] = useState<Track[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
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
  const [nameDialog, setNameDialog] = useState<{ kind: "set" } | { kind: "crate"; query: string } | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [soundCloudSummary, setSoundCloudSummary] = useState<SoundCloudSummary | null>(null);
  const [soundCloudReviewOpen, setSoundCloudReviewOpen] = useState(false);
  const { play, load: loadDeck } = usePlayer();
  const tableRef = useRef<TrackTableHandle>(null);
  const tablePreferences = useTablePreferences();

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
    setSelectedIds(new Set());
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
    const next = !sort || sort.key !== key
      ? { key, dir: "asc" as const }
      : sort.dir === "asc" ? { key, dir: "desc" as const } : null;
    setSort(next);
    if (next) preferenceStorage.setItem("cratemind:library-sort", JSON.stringify(next));
    else preferenceStorage.removeItem("cratemind:library-sort");
  }

  function loadOnDeck(deck: DeckId, track: Track) {
    if (!loadDeck(deck, track, { play: false, ifIdle: true })) toast(`Το Deck ${deck} παίζει — δεν φορτώθηκε`);
  }

  async function addToActiveSet(trackId: number) {
    if (activeSetId === null) return;
    if (!await addToSet(activeSetId, trackId)) return;
    const t = tracks.find((x) => x.id === trackId);
    toast.success(`Προστέθηκε "${t?.title || t?.file_name}" στο set`);
  }

  function newSetForCrate() {
    setNameInput("");
    setNameDialog({ kind: "set" });
  }

  function saveCrate() {
    setNameInput(query.slice(0, 40));
    setNameDialog({ kind: "crate", query });
  }

  async function saveNamedAction(event: React.FormEvent) {
    event.preventDefault();
    const name = nameInput.trim();
    if (!nameDialog || !name || savingName) return;
    setSavingName(true);
    try {
      if (nameDialog.kind === "set") {
        const created = await api.createSet(name);
        setSets(current => [created, ...current]);
        setActiveSetId(created.id);
        // Creation already succeeded; a failed refresh must not offer a duplicate retry.
        const refreshed = await api.listSets().catch(() => null);
        if (refreshed) setSets(refreshed);
      } else {
        await api.createSearch(name, nameDialog.query);
        toast.success(`Σώθηκε το crate "${name}"`);
      }
      setNameDialog(null);
    } catch {
      toast.error(nameDialog.kind === "set"
        ? "Δεν ήταν δυνατή η δημιουργία του set"
        : "Δεν ήταν δυνατή η αποθήκευση του crate");
    } finally {
      setSavingName(false);
    }
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

  // Controller browse (lib/browseTarget.ts): the cursor selects + scrolls; Load hold adds to the active set.
  const browse = useBrowseList("library", {
    rows: () => view,
    onCursor: (track, index) => { void select(track.id); tableRef.current?.scrollToIndex(index); },
    addToSet: track => {
      if (activeSetId === null) toast("Διάλεξε πρώτα ενεργό set");
      else void addToActiveSet(track.id);
    },
  }, selected?.track.id);

  const chips = query.trim() ? parseQueryChips(query, facets) : [];

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
            className="flex items-center gap-2"
          >
            <div className="glass flex flex-1 items-center gap-2 rounded-xl px-3 py-2 transition focus-within:ring-1 focus-within:ring-cm-cyan/40">
              <Search className="h-4 w-4 shrink-0 text-cm-faint" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onClear={() => runQuery("")}
                wrapperClassName="min-w-0 flex-1"
                title="Ημερομηνίες: added:30, created:60, added:30-60 ή added:2026-09-01..2026-09-30 (UTC)"
                placeholder={libraryPlaceholder()}
                className="min-w-0 flex-1 border-none bg-transparent p-0 text-sm text-cm-text shadow-none ring-0 placeholder:text-cm-faint focus-visible:ring-0"
              />

            </div>
            <SpecularButton type="button" onClick={saveCrate} disabled={!query.trim()}>
              <Save className="h-3.5 w-3.5" />
              Αποθήκευση ως crate
            </SpecularButton>
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

          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-cm-faint">Προσθήκη στο set:</span>
            <Select
              value={activeSetId === null ? "none" : String(activeSetId)}
              onValueChange={(v) => setActiveSetId(v === "none" ? null : Number(v))}
            >
              <SelectTrigger className="h-7 w-auto cursor-pointer rounded-lg px-2 py-1 text-xs text-cm-text focus:ring-0 focus:ring-offset-0">
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
              type="button"
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
                <NumberCount value={soundCloudSummary?.pending_candidates ?? 0} />
              </span>
            </button>}
            <a href="/canonical" className="text-cyan-300 underline">Κανονικά μεταδεδομένα</a>
            <span className="ml-auto inline-flex flex-wrap items-center gap-1.5 text-cm-muted">
              {loading ? "φόρτωση…" : <><NumberCount value={tracks.length} /> tracks</>}
              <span aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1 whitespace-nowrap"><Kbd>J ↓</Kbd><Kbd>K ↑</Kbd> πλοήγηση</span>
            </span>
            <Button type="button" variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-xs"
              title="Επαναφορά πλάτους στηλών · οι επιλογές εμφάνισης διατηρούνται"
              onClick={() => tablePreferenceStore.resetWidths()}>
              <RotateCcw aria-hidden="true" className="h-3 w-3" /> Επαναφορά μεγεθών
            </Button>
            <Popover>
              <PopoverTrigger asChild>
                <Button type="button" variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-xs">
                  <ListFilter aria-hidden="true" className="h-3 w-3" /> Στήλες
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-64 p-3" aria-label="Εμφάνιση στηλών βιβλιοθήκης">
                <p className="mb-2 text-sm font-medium">Στήλες βιβλιοθήκης</p>
                <div className="max-h-[min(60vh,26rem)] overflow-y-auto">
                  {LIBRARY_COLUMNS.map(column => (
                    <label key={column.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1.5 text-xs hover:bg-cm-line/5 dark:hover:bg-white/5">
                      <input type="checkbox" className="h-3.5 w-3.5 accent-cm-cyan" checked={tablePreferences.visibility[column.id]}
                        disabled={column.id === "track"}
                        onChange={event => tablePreferenceStore.setVisible(column.id, event.target.checked)} />
                      {columnLabel(column)}
                    </label>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          </div>

          <BulkTagBar
            selectedIds={selectedIds}
            query={params.get("q") ?? ""}
            onApplied={async () => {
              setSelectedIds(new Set());
              await load(params.get("q") ?? "", true);
              if (selected) await select(selected.track.id);
            }}
          />

          {error && <div className="mt-2 text-xs text-cm-rose">{error}</div>}
        </div>
        <div className="min-h-0 flex-1" {...browse.bind}>
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
            selectedIds={selectedIds}
            onSelectionChange={setSelectedIds}
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
          {selected && (
            <div className="mb-2 flex items-center gap-2">
              <Button type="button" size="sm" variant="outline" className="motion-safe:active:scale-[0.98] transition-transform duration-100 ease-out" onClick={() => loadOnDeck("A", selected.track)}>→ Deck A</Button>
              <Button type="button" size="sm" variant="outline" className="motion-safe:active:scale-[0.98] transition-transform duration-100 ease-out" onClick={() => loadOnDeck("B", selected.track)}>→ Deck B</Button>
            </div>
          )}
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
      <Dialog open={nameDialog !== null} onOpenChange={open => { if (!open && !savingName) setNameDialog(null); }}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader><DialogTitle>{nameDialog?.kind === "crate" ? "Αποθήκευση ως crate" : "Νέο set"}</DialogTitle></DialogHeader>
          <form onSubmit={saveNamedAction} className="space-y-4">
            <label className="block space-y-2">
              {nameDialog?.kind === "crate" ? "Όνομα crate" : "Τίτλος set"}
              <Input autoFocus required value={nameInput} disabled={savingName} onChange={event => setNameInput(event.target.value)} />
            </label>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" disabled={savingName} onClick={() => setNameDialog(null)}>Ακύρωση</Button>
              <Button type="submit" disabled={savingName || !nameInput.trim()}>{savingName ? "Αποθήκευση…" : "Αποθήκευση"}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
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
