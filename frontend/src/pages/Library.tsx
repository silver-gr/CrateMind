import { preferenceStorage } from "../lib/preferenceStorage";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import TrackTable, { type TrackTableHandle } from "../components/TrackTable";
import ProfileEditor from "../components/ProfileEditor";
import SoundCloudReviewDrawer from "../components/SoundCloudReviewDrawer";
import { LibraryBulkActions, LibraryDisclosure, LibraryTools } from "../components/LibraryTools";
import { SmartChip } from "../components/ui/SmartChip";
import { EmptyState } from "../components/ui/EmptyState";
import { ResizeHandle } from "../components/ui/ResizeHandle";
import { Kbd } from "../components/ui/KeyboardHint";
import { NumberCount } from "../components/ui/NumberCount";
import { useResizable } from "../lib/useResizable";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "../lib/api";
import { useSetTrackAddition } from "../lib/useSetTrackAddition";
import { hasProviderWorkflows, useCapabilities } from "../lib/capabilities";
import { isTypingTarget } from "../lib/keyboardGuard";
import { useBrowseList } from "../lib/browseTarget";
import { Flame, Search, SlidersHorizontal } from "../lib/icons";
import { usePlayer, type DeckId } from "../lib/player";
import { parseQueryChips } from "../lib/queryChips";
import { notifyFacetsChanged, useFacets } from "../lib/facets";
import { libraryPlaceholder, libraryPresets } from "../lib/profileCopy";
import { FacetFilterPanel } from "../components/FacetFilterPanel";
import { getPref, setPref, usePref } from "../lib/prefs";
import { ANALYSIS_FINISHED, BPM_UPDATED, applyBpmFields, queryHasBpmFilter, type BpmUpdatedDetail } from "../lib/bpmUpdates";
import { sortTracks, type SortKey } from "../lib/trackSort";
import type { DJSet, SoundCloudSummary, SoundCloudTrackDetail, Track } from "../lib/types";

export default function Library() {
  const { addToSet, duplicateDialog } = useSetTrackAddition();
  const capabilities = useCapabilities();
  const providerWorkflows = hasProviderWorkflows(capabilities);
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState(params.get("q") ?? "");
  const appliedQuery = params.get("q") ?? "";
  const [facetPanel] = usePref("libraryFacetPanel");
  const { facets } = useFacets();
  const [tracks, setTracks] = useState<Track[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const [selected, setSelected] = useState<SoundCloudTrackDetail | null>(null);
  const [selectionLoading, setSelectionLoading] = useState(false);
  const [profileFooter, setProfileFooter] = useState<HTMLDivElement | null>(null);
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
  const inspectorRef = useRef<HTMLElement>(null);

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

  // A manual «×½ / ×2» patches the row and the side card; a `bpm:` filter reloads quietly so the track can leave it.
  useEffect(() => {
    function onBpmUpdated(e: Event) {
      const detail = (e as CustomEvent<BpmUpdatedDetail>).detail;
      if (!detail) return;
      const { trackId, fields } = detail;
      setTracks(rows => rows.map(row => (row.id === trackId ? applyBpmFields(row, fields) : row)));
      setSelected(current => (current?.track.id === trackId ? { ...current, track: applyBpmFields(current.track, fields) } : current));
      const q = params.get("q") ?? "";
      if (queryHasBpmFilter(q)) void load(q, true);
    }
    window.addEventListener(BPM_UPDATED, onBpmUpdated);
    return () => window.removeEventListener(BPM_UPDATED, onBpmUpdated);
  }, [params, load]);

  // A finished analysis (also one started from Crates, or before this page mounted) reloads the current query quietly.
  useEffect(() => {
    const onAnalysisFinished = () => void load(params.get("q") ?? "", true);
    window.addEventListener(ANALYSIS_FINISHED, onAnalysisFinished);
    return () => window.removeEventListener(ANALYSIS_FINISHED, onAnalysisFinished);
  }, [params, load]);

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
      <div className="@container h-full min-w-0">
      <div className="flex h-full flex-col overflow-y-auto @min-[56rem]:flex-row @min-[56rem]:overflow-hidden">
      <div className="flex min-w-0 shrink-0 flex-col @min-[56rem]:min-h-0 @min-[56rem]:flex-1">
        <div className="border-b border-cm-border bg-cm-bg-2/40 p-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              runQuery(query);
            }}
            className="flex items-center gap-2"
          >
            <div className="glass flex h-11 flex-1 items-center gap-2 rounded-xl px-3 transition-[border-color,box-shadow] duration-150 focus-within:border-cm-cyan/50 focus-within:ring-[3px] focus-within:ring-cm-cyan/15">
              <Search className="h-4 w-4 shrink-0 text-cm-faint" />
              <Input
                aria-label="Αναζήτηση στη βιβλιοθήκη"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onClear={() => runQuery("")}
                wrapperClassName="min-w-0 flex-1"
                title="Ημερομηνίες: added:30, created:60, added:30-60 ή added:2026-09-01..2026-09-30 (UTC)"
                placeholder={libraryPlaceholder()}
                className="min-w-0 flex-1 border-none bg-transparent p-0 text-sm text-ellipsis text-cm-text shadow-none ring-0 placeholder:text-cm-faint focus-visible:ring-0"
              />
            </div>
          </form>

          <div className="mt-2 grid grid-cols-1 gap-x-3 gap-y-2 @min-[35rem]:grid-cols-[minmax(0,1fr)_auto]">
            <div className="min-w-0">
              {chips.length > 0 && (
                <div className="mb-1 flex flex-wrap items-center gap-1.5">
                  {chips.map((chip, i) => (
                    <SmartChip key={`${chip.label}-${i}`} tone={chip.tone}>
                      {chip.label}
                    </SmartChip>
                  ))}
                </div>
              )}
              <LibraryDisclosure label="Έτοιμα φίλτρα">
                <div className="flex flex-wrap items-center gap-1.5 px-1.5 py-1">
                  {libraryPresets().map((preset) => (
                    <SmartChip
                      key={preset.label}
                      tone={preset.flagship ? "chartreuse" : "muted"}
                      icon={preset.flagship ? Flame : undefined}
                      active={query.trim() === preset.q.trim()}
                      onClick={() => runQuery(preset.q)}
                      className={preset.flagship ? "glow-chartreuse" : undefined}
                    >
                      {preset.label}
                    </SmartChip>
                  ))}
                </div>
              </LibraryDisclosure>

              <LibraryBulkActions
                canAnalyze={capabilities.analysis}
                selectedIds={selectedIds}
                query={appliedQuery}
                onApplied={async () => {
                  setSelectedIds(new Set());
                  await load(params.get("q") ?? "", true);
                  if (selected) await select(selected.track.id);
                }}
              />
            </div>
            <div className="flex min-w-0 flex-col justify-between gap-2">
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button type="button" variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-xs"
                  aria-expanded={facetPanel.open} aria-controls="library-facet-panel"
                  onClick={() => { const current = getPref("libraryFacetPanel"); setPref("libraryFacetPanel", { ...current, open: !current.open }); }}>
                  <SlidersHorizontal aria-hidden="true" className="h-3 w-3" /> Φίλτρα
                </Button>
                <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs @min-[56rem]:hidden"
                  aria-controls="library-inspector"
                  onClick={() => {
                    inspectorRef.current?.scrollIntoView({ block: "start" });
                    inspectorRef.current?.focus({ preventScroll: true });
                  }}>
                  Εργαλεία
                </Button>
              </div>
              <div role="status" aria-label="Σύνολο κομματιών και πλοήγηση"
                className="mt-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-[11px] text-cm-muted">
                <span>{loading ? "Φόρτωση…" : <><NumberCount value={tracks.length} /> κομμάτια</>}</span>
                <span className="inline-flex items-center gap-1 whitespace-nowrap">
                  <Kbd>J ↓</Kbd><Kbd>K ↑</Kbd> πλοήγηση
                </span>
              </div>
            </div>
          </div>

          {error && <div className="mt-2 text-xs text-cm-rose">{error}</div>}
        </div>
        <div className="relative flex h-[min(55dvh,28rem)] min-h-48 @min-[56rem]:h-auto @min-[56rem]:min-h-0 @min-[56rem]:flex-1">
        {facetPanel.open && <FacetFilterPanel draft={query} applied={appliedQuery} onApply={runQuery} />}
        <div className="min-h-0 min-w-0 flex-1" {...browse.bind}>
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

      </div>

      <div
        style={{ "--library-sidebar-width": `${rightPanelWidth}px` } as CSSProperties}
        className="relative flex min-w-0 shrink-0 flex-col border-t border-cm-border @min-[56rem]:h-full @min-[56rem]:w-[var(--library-sidebar-width)] @min-[56rem]:border-l @min-[56rem]:border-t-0"
      >
        <ResizeHandle
          orientation="vertical"
          isDragging={isRightDragging}
          ariaLabel="Αλλαγή πλάτους δεξιού panel"
          className="absolute inset-y-0 -left-1.5 z-30 hidden @min-[56rem]:flex"
          {...rightHandleProps}
        />
        <aside
          ref={inspectorRef}
          id="library-inspector"
          aria-label="Εργαλεία και στοιχεία βιβλιοθήκης"
          tabIndex={-1}
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
          className="scroll-fade-y min-w-0 p-4 @min-[56rem]:min-h-0 @min-[56rem]:flex-1 @min-[56rem]:overflow-y-auto"
        >
          <div className="mb-2 border-b border-cm-border pb-1">
            <LibraryTools
              sets={sets}
              activeSetId={activeSetId}
              onActiveSetChange={setActiveSetId}
              onCreateSet={newSetForCrate}
              canSaveCrate={Boolean(query.trim())}
              onSaveCrate={saveCrate}
              pendingSoundCloud={soundCloudSummary?.pending_candidates ?? 0}
              onReviewSoundCloud={providerWorkflows ? () => setSoundCloudReviewOpen(true) : undefined}
            />
          </div>
          <div aria-busy={selectionLoading}>
            {selected ? (
              <ProfileEditor
                key={selected.track.id}
                detail={selected}
                footerTarget={profileFooter}
                onSaved={async () => {
                  const id = selected.track.id;
                  notifyFacetsChanged(); // the facet counts follow a profile edit, as the rows do
                  await Promise.all([
                    load(params.get("q") ?? "", true),
                    api.getTrack(id).then(detail => setSelected(current => current?.track.id === id ? detail : current)),
                  ]);
                }}
                onAddToSet={
                  activeSetId !== null ? () => addToActiveSet(selected.track.id) : undefined
                }
                onLoadDeck={(deck) => loadOnDeck(deck, selected.track)}
                onReviewSoundCloud={providerWorkflows ? () => setSoundCloudReviewOpen(true) : undefined}
              />
            ) : selectionLoading ? (
              <p role="status" className="py-6 text-center text-sm text-cm-muted">Φόρτωση track…</p>
            ) : (
              <EmptyState icon={Search} title="Δεν έχει επιλεγεί track" className="mt-6">
                Διάλεξε track για να επεξεργαστείς το DJ προφίλ του.
              </EmptyState>
            )}
          </div>
        </aside>
        {/* Outside the scroll mask: reserves space instead of covering editor fields. */}
        <div ref={setProfileFooter} hidden={!selected} role="group" aria-label="Αποθήκευση προφίλ"
          className="shrink-0 border-t border-cm-border bg-cm-bg-2/40 px-4 py-3 backdrop-blur-xl" />
      </div>
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
