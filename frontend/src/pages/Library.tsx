import { preferenceStorage } from "../lib/preferenceStorage";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
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
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import LibraryCrates from "../components/library/LibraryCrates";
import LibrarySets from "../components/library/LibrarySets";
import { LibraryDrawer } from "../components/library/LibraryDrawer";
import { LIBRARY_PANEL_TAB_LABELS, LibrarySidePanel } from "../components/library/LibrarySidePanel";
import { PanelTabs } from "../components/library/PanelTabs";
import { TagCloudBody, useTagList } from "../components/TagCloudBody";
import FlowFinderPanel from "../components/FlowFinderPanel";
import { api } from "../lib/api";
import { useSetTrackAddition } from "../lib/useSetTrackAddition";
import { hasProviderWorkflows, useCapabilities } from "../lib/capabilities";
import { isTypingTarget } from "../lib/keyboardGuard";
import { useBrowseList } from "../lib/browseTarget";
import { ChevronUp, Flame, Hash, HistoryIcon, Layers, MicVocal, Search, SlidersHorizontal, Workflow } from "../lib/icons";
import { usePlayer, type DeckId } from "../lib/player";
import { parseQueryChips } from "../lib/queryChips";
import { notifyFacetsChanged, useFacets } from "../lib/facets";
import { libraryPlaceholder, libraryPresets } from "../lib/profileCopy";
import { getPref, isLibraryPanelTab, setPref, usePref, type LibraryPanelTab } from "../lib/prefs";
import { toggleFieldValue } from "../lib/queryGrammar";
import { cn } from "../lib/cn";
import { ANALYSIS_FINISHED, BPM_UPDATED, applyBpmFields, queryHasBpmFilter, type BpmUpdatedDetail } from "../lib/bpmUpdates";
import { sortTracks, type SortKey } from "../lib/trackSort";
import { GROUP_KEYS, flattenGroups, groupTracks, stepVisible, type GroupKey } from "../lib/libraryGrouping";
import { axisLabel } from "../lib/labels";
import { LIBRARY_COLUMNS, columnLabel, type LibraryColumnId } from "../lib/tablePreferences";
import type { DJSet, SearchMembership, SoundCloudSummary, SoundCloudTrackDetail, Track } from "../lib/types";

type SidebarTab = "track" | "crates" | "sets";
const SIDEBAR_TABS: { value: SidebarTab; label: string }[] = [
  { value: "track", label: "Κομμάτι" },
  { value: "crates", label: "Crates" },
  { value: "sets", label: "Sets/Playlist" },
];

const PANEL_ICONS: Record<LibraryPanelTab, typeof Search> = { filters: SlidersHorizontal, artists: MicVocal, history: HistoryIcon };

const NO_COLLAPSED: ReadonlySet<string> = new Set();
const DJ_ONLY_GROUPS: ReadonlySet<GroupKey> = new Set(["role", "substyle"]);

/** Scroll-edge markers for the aside's `scroll-fade-y` mask. */
function markScrollEdges(el: HTMLElement) {
  const topVal = el.scrollTop <= 2 ? "true" : "false";
  const btmVal = el.scrollTop + el.clientHeight >= el.scrollHeight - 2 ? "true" : "false";
  if (el.dataset.atTop !== topVal) el.dataset.atTop = topVal;
  if (el.dataset.atBottom !== btmVal) el.dataset.atBottom = btmVal;
}

/** The «Ετικέτες» drawer body: tags load each time the drawer opens. */
function TagsDrawerBody({ appliedQuery, onPick }: { appliedQuery: string; onPick: (q: string) => void }) {
  const { tags, loading } = useTagList();
  return (
    <div className="p-4">
      <TagCloudBody bare tags={tags} loading={loading} activeQuery={appliedQuery} onPick={onPick} />
    </div>
  );
}

export default function Library() {
  const { addToSet, duplicateDialog } = useSetTrackAddition();
  const capabilities = useCapabilities();
  const providerWorkflows = hasProviderWorkflows(capabilities);
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState(params.get("q") ?? "");
  const appliedQuery = params.get("q") ?? "";
  const [facetPanel] = usePref("libraryFacetPanel");
  const [profile] = usePref("libraryProfile");
  const isDj = profile === "dj";
  const [tab, setTab] = useState<SidebarTab>(() => {
    const initial = params.get("tab");
    return initial === "crates" || initial === "sets" ? initial : "track";
  });
  const [drawer, setDrawer] = useState<"tags" | "flow" | null>(null);
  const [crateRevision, setCrateRevision] = useState(0);
  // «Ομαδοποίηση»: the persisted choice; a failed first crate fetch falls back to «Καμία» here only.
  const [storedGroupBy, setStoredGroupBy] = usePref("libraryGroupBy");
  const [keyFormat] = usePref("keyFormat");
  const [crateFallback, setCrateFallback] = useState(false);
  const groupBy: GroupKey = !GROUP_KEYS.includes(storedGroupBy) || (!isDj && DJ_ONLY_GROUPS.has(storedGroupBy))
    || (storedGroupBy === "crates" && crateFallback) ? "none" : storedGroupBy;
  const [collapsedGroups, setCollapsedGroups] = useState<{ key: GroupKey; ids: ReadonlySet<string> }>({ key: "none", ids: NO_COLLAPSED });
  const [membership, setMembership] = useState<SearchMembership[] | null>(null);
  // Bumped by track and crate mutations; membership covers the whole library, so a query change does not refetch.
  const [membershipRevision, setMembershipRevision] = useState(0);
  const bumpMembership = useCallback(() => setMembershipRevision(r => r + 1), []);
  const hasMembership = useRef(false);
  const tagsButtonRef = useRef<HTMLButtonElement>(null);
  const flowButtonRef = useRef<HTMLButtonElement>(null);
  const panelButtons = useRef<Partial<Record<LibraryPanelTab, HTMLButtonElement | null>>>({});
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

  // honor ?q= from the dashboard / deep links (re-runs when the query changes, not on other params)
  useEffect(() => {
    setQuery(appliedQuery);
    setSelectedIds(new Set());
    load(appliedQuery);
  }, [appliedQuery, load]);

  // ?tab=crates|sets (palette, dashboard, old /crates and /playlists links) opens that tab, then leaves the URL;
  // `q` stays, so stripping never refetches. Works again while already on /library.
  const tabParam = params.get("tab");
  useEffect(() => {
    if (tabParam === null) return;
    if (tabParam === "crates" || tabParam === "sets") setTab(tabParam);
    setParams(current => {
      const next = new URLSearchParams(current);
      next.delete("tab");
      return next;
    }, { replace: true });
  }, [tabParam, setParams]);

  // ?panel=filters|artists|history (palette, old /artists and /history entries) opens the side panel on that tab,
  // then leaves the URL; an unknown value is ignored.
  const panelParam = params.get("panel");
  useEffect(() => {
    if (panelParam === null) return;
    if (isLibraryPanelTab(panelParam)) setPref("libraryFacetPanel", { ...getPref("libraryFacetPanel"), open: true, tab: panelParam });
    setParams(current => {
      const next = new URLSearchParams(current);
      next.delete("panel");
      return next;
    }, { replace: true });
  }, [panelParam, setParams]);

  const refreshSets = useCallback(() => {
    api.listSets().then(rows => setSets(rows)).catch(() => toast.error("Αποτυχία φόρτωσης sets"));
  }, []);
  useEffect(() => {
    if (tab === "sets") refreshSets();
  }, [tab, refreshSets]);
  useEffect(() => {
    refreshSets();
  }, [refreshSets]);

  // A tab switch starts the aside at the top, with fresh fade markers for the new content.
  useLayoutEffect(() => {
    const el = inspectorRef.current;
    if (!el) return;
    el.scrollTop = 0;
    markScrollEdges(el);
  }, [tab]);

  // A manual «×½ / ×2» patches the row and the side card; a `bpm:` filter reloads quietly so the track can leave it.
  useEffect(() => {
    function onBpmUpdated(e: Event) {
      const detail = (e as CustomEvent<BpmUpdatedDetail>).detail;
      if (!detail) return;
      const { trackId, fields } = detail;
      setTracks(rows => rows.map(row => (row.id === trackId ? applyBpmFields(row, fields) : row)));
      setSelected(current => (current?.track.id === trackId ? { ...current, track: applyBpmFields(current.track, fields) } : current));
      bumpMembership();
      const q = params.get("q") ?? "";
      if (queryHasBpmFilter(q)) void load(q, true);
    }
    window.addEventListener(BPM_UPDATED, onBpmUpdated);
    return () => window.removeEventListener(BPM_UPDATED, onBpmUpdated);
  }, [params, load, bumpMembership]);

  // A finished analysis (also one started from Crates, or before this page mounted) reloads the current query quietly.
  useEffect(() => {
    const onAnalysisFinished = () => {
      bumpMembership();
      void load(params.get("q") ?? "", true);
    };
    window.addEventListener(ANALYSIS_FINISHED, onAnalysisFinished);
    return () => window.removeEventListener(ANALYSIS_FINISHED, onAnalysisFinished);
  }, [params, load, bumpMembership]);

  // «Crates» grouping: fetched when chosen and on every membership revision. Until the first answer the list
  // stays ungrouped; a refetch keeps the previous membership on screen, and a stale answer never wins.
  const wantsMembership = groupBy === "crates";
  useEffect(() => {
    if (!wantsMembership) return;
    let current = true;
    api.searchMembership().then(rows => {
      if (!current) return;
      hasMembership.current = true;
      setMembership(rows);
    }).catch(() => {
      if (!current || hasMembership.current) return;
      toast.error("Δεν ήταν δυνατή η φόρτωση των crates για την ομαδοποίηση");
      setCrateFallback(true);
    });
    return () => { current = false; };
  }, [wantsMembership, membershipRevision]);

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
  // An artist row swaps the positive `artist:` token of the applied query; the current artist removes it.
  // Stable per applied query, so the memoized tab does not redraw on every keystroke.
  const openArtist = useCallback(
    (name: string) => {
      const next = toggleFieldValue(appliedQuery, "artist", name);
      setParams(next ? { q: next } : {});
    },
    [appliedQuery, setParams],
  );

  // A toolbar button opens the side panel on its tab; the open tab's button closes it.
  function togglePanel(next: LibraryPanelTab) {
    const current = getPref("libraryFacetPanel");
    setPref("libraryFacetPanel", current.open && current.tab === next
      ? { ...current, open: false }
      : { ...current, open: true, tab: next });
  }

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

  // User picks (table click, J/K, controller cursor) bring the «Κομμάτι» tab forward; select() alone does not.
  const selectFromUser = useCallback((id: number) => {
    setTab("track");
    void select(id);
  }, [select]);

  const playFromTable = (track: Track) => {
    void select(track.id);
    play(track);
  };

  // Sorted (and, when grouped, flattened visible) view feeds BOTH the table and J/K math, so scrollToIndex stays aligned.
  const sorted = useMemo(() => sortTracks(tracks, sort), [tracks, sort]);
  const groups = useMemo(() => {
    if (groupBy === "none" || (groupBy === "crates" && membership === null)) return null;
    return groupTracks(sorted, groupBy, { profile, keyFormat, crates: membership ?? [], appliedQuery });
  }, [sorted, groupBy, profile, keyFormat, membership, appliedQuery]);
  const collapsed = collapsedGroups.key === groupBy ? collapsedGroups.ids : NO_COLLAPSED;
  const grouped = useMemo(() => (groups ? flattenGroups(groups, collapsed) : null), [groups, collapsed]);
  const view = grouped ? grouped.view : sorted;

  // A history play selects its track and, when the track is in the current list, scrolls the table to it.
  const selectFromHistory = useCallback((id: number) => {
    selectFromUser(id);
    const index = view.findIndex(t => t.id === id);
    if (index >= 0) tableRef.current?.scrollToIndex(index);
  }, [selectFromUser, view]);

  const toggleGroup = useCallback((groupId: string) => {
    setCollapsedGroups(current => {
      const ids = new Set(current.key === groupBy ? current.ids : []);
      if (!ids.delete(groupId)) ids.add(groupId);
      return { key: groupBy, ids };
    });
  }, [groupBy]);

  function changeGroupBy(value: string) {
    const next = GROUP_KEYS.find(key => key === value);
    if (!next) return;
    setCrateFallback(false);
    setCollapsedGroups({ key: next, ids: NO_COLLAPSED });
    setStoredGroupBy(next);
  }

  // The table's own labels («Κατάσταση», the profile's axis name); columnLabel reads the profile pref.
  const groupOptions = useMemo(() => {
    const column = (id: LibraryColumnId) => {
      const meta = LIBRARY_COLUMNS.find(c => c.id === id);
      return meta ? columnLabel(meta, profile) : id;
    };
    const options: { value: GroupKey; label: string }[] = [
      { value: "none", label: "Καμία" },
      { value: "status", label: column("status") },
      { value: "energy", label: axisLabel("energy", profile) },
      { value: "role", label: column("role") },
      { value: "substyle", label: column("substyle") },
      { value: "bpm", label: column("bpm") },
      { value: "key", label: column("key") },
      { value: "genre", label: column("genre") },
      { value: "year", label: "Χρονιά" },
      { value: "folder", label: "Φάκελος" },
      { value: "crates", label: "Crates" },
    ];
    return profile === "dj" ? options : options.filter(option => !DJ_ONLY_GROUPS.has(option.value));
  }, [profile]);

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
        setCrateRevision(r => r + 1);
        bumpMembership();
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
      const selectedId = selected?.track.id;
      const idx = view.findIndex((t) => t.id === selectedId);
      // The selected track sits in a collapsed group: step to the next/previous visible one.
      if (idx < 0 && selectedId !== undefined && grouped?.order.some(t => t.id === selectedId)) {
        const visible = new Set(view.map(t => t.id));
        const target = stepVisible(grouped.order, visible, selectedId, e.key === "j" ? 1 : -1);
        if (target) {
          setTab("track");
          select(target.id);
          tableRef.current?.scrollToIndex(view.indexOf(target));
        }
        return;
      }
      const next = e.key === "j" ? idx + 1 : idx - 1;
      if (next >= 0 && next < view.length) {
        setTab("track");
        select(view[next].id);
        tableRef.current?.scrollToIndex(next);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, grouped, selected, select]);

  // Controller browse (lib/browseTarget.ts): the cursor selects + scrolls; Load hold adds to the active set.
  const browse = useBrowseList("library", {
    rows: () => view,
    stepFromMissing: (trackId, delta) =>
      grouped ? stepVisible(grouped.order, new Set(view.map(t => t.id)), trackId, delta) : null,
    onCursor: (track, index) => { selectFromUser(track.id); tableRef.current?.scrollToIndex(index); },
    addToSet: track => {
      if (activeSetId === null) toast("Διάλεξε πρώτα ενεργό set");
      else void addToActiveSet(track.id);
    },
  }, selected?.track.id);

  const chips = query.trim() ? parseQueryChips(query, facets) : [];
  const toggleDrawer = (next: "tags" | "flow") => setDrawer(current => (current === next ? null : next));

  return (
    <>
      {duplicateDialog}
      <div className="@container relative h-full min-w-0 overflow-hidden">
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
              {/* One line inside the field: applying a query (an artist row, a facet) never changes the toolbar's height. */}
              {chips.length > 0 && (
                <div className="hidden max-w-[45%] shrink items-center gap-1.5 overflow-x-auto whitespace-nowrap [scrollbar-width:none] @min-[35rem]:flex">
                  {chips.map((chip, i) => (
                    <SmartChip key={`${chip.label}-${i}`} tone={chip.tone} className="shrink-0">
                      {chip.label}
                    </SmartChip>
                  ))}
                </div>
              )}
            </div>
          </form>

          <div className="mt-2 grid grid-cols-1 gap-x-3 gap-y-2 @min-[35rem]:grid-cols-[minmax(13rem,1fr)_minmax(0,auto)]">
            <div className="min-w-0">
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
                  bumpMembership();
                  await load(params.get("q") ?? "", true);
                  if (selected) await select(selected.track.id);
                }}
              />
            </div>
            <div className="flex min-w-0 flex-col justify-between gap-2">
              <div className="flex flex-wrap items-center justify-end gap-2">
                <div role="group" aria-label="Πλαϊνή στήλη" className="inline-flex">
                  {LIBRARY_PANEL_TAB_LABELS.map(({ value, label }, i) => {
                    const Icon = PANEL_ICONS[value];
                    return (
                      <Button key={value} ref={el => { panelButtons.current[value] = el; }} type="button" variant="outline" size="sm"
                        aria-pressed={facetPanel.open && facetPanel.tab === value} aria-controls="library-facet-panel"
                        className={cn(
                          "relative h-7 gap-1.5 px-2 text-xs focus-visible:z-10 aria-pressed:bg-cm-cyan/14 aria-pressed:text-cm-cyan",
                          i === 0 ? "rounded-r-none" : i === LIBRARY_PANEL_TAB_LABELS.length - 1 ? "-ml-px rounded-l-none" : "-ml-px rounded-none",
                        )}
                        onClick={() => togglePanel(value)}>
                        <Icon aria-hidden="true" className="h-3 w-3" /> {label}
                      </Button>
                    );
                  })}
                </div>
                <Select value={crateFallback && storedGroupBy === "crates" ? "crates" : groupBy} onValueChange={changeGroupBy}>
                  <SelectTrigger className="h-7 min-w-0 max-w-full cursor-pointer gap-1.5 rounded-lg px-2 py-1 text-xs text-cm-text data-[size=default]:h-7">
                    <Layers aria-hidden="true" className="size-3 text-cm-muted" />
                    <span className="text-cm-muted">Ομαδοποίηση:</span>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {groupOptions.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                  </SelectContent>
                </Select>
                {isDj && (
                  <Button ref={tagsButtonRef} type="button" variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-xs"
                    aria-expanded={drawer === "tags"} aria-controls="library-tags-drawer"
                    onClick={() => toggleDrawer("tags")}>
                    <Hash aria-hidden="true" className="h-3 w-3" /> Ετικέτες
                    <ChevronUp aria-hidden="true"
                      className={`h-3 w-3 motion-safe:transition-transform motion-safe:duration-200 motion-safe:ease-[var(--ease-out)] ${drawer === "tags" ? "rotate-180" : ""}`} />
                  </Button>
                )}
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
        <LibrarySidePanel
          open={facetPanel.open}
          tab={facetPanel.tab}
          draft={query}
          applied={appliedQuery}
          onApply={runQuery}
          onOpenArtist={openArtist}
          selectedId={selected?.track.id}
          onSelect={selectFromHistory}
          onSetSaved={refreshSets}
          returnFocus={() => panelButtons.current[getPref("libraryFacetPanel").tab] ?? null}
        />
        <div className="min-h-0 min-w-0 flex-1" {...browse.bind}>
          <TrackTable
            ref={tableRef}
            tracks={view}
            loading={loading}
            selectedId={selected?.track.id}
            onSelect={selectFromUser}
            onPlay={playFromTable}
            onAdd={activeSetId !== null ? addToActiveSet : undefined}
            sortKey={sort?.key}
            sortDir={sort?.dir}
            onSort={toggleSort}
            selectedIds={selectedIds}
            onSelectionChange={setSelectedIds}
            rows={grouped?.rows}
            onToggleGroup={toggleGroup}
          />
        </div>
        </div>

      </div>

      <Tabs
        value={tab}
        onValueChange={value => setTab(value as SidebarTab)}
        style={{ "--library-sidebar-width": `${rightPanelWidth}px` } as CSSProperties}
        className="relative min-w-0 shrink-0 gap-0 border-t border-cm-border @min-[56rem]:h-full @min-[56rem]:w-[var(--library-sidebar-width)] @min-[56rem]:border-l @min-[56rem]:border-t-0"
      >
        <ResizeHandle
          orientation="vertical"
          isDragging={isRightDragging}
          ariaLabel="Αλλαγή πλάτους δεξιού panel"
          className="absolute inset-y-0 -left-1.5 z-30 hidden @min-[56rem]:flex"
          {...rightHandleProps}
        />
        {/* Above the aside, not inside it: the aside's scroll-fade-y mask would fade a sticky list. */}
        <div className="shrink-0 border-b border-cm-border px-4 py-2.5">
          <PanelTabs tabs={SIDEBAR_TABS} value={tab} ariaLabel="Καρτέλες εργαλείων" />
        </div>
        <aside
          ref={inspectorRef}
          id="library-inspector"
          aria-label="Εργαλεία και στοιχεία βιβλιοθήκης"
          tabIndex={-1}
          data-at-top="true"
          onScroll={(e) => markScrollEdges(e.currentTarget)}
          className="scroll-fade-y min-w-0 p-4 @min-[56rem]:min-h-0 @min-[56rem]:flex-1 @min-[56rem]:overflow-y-auto"
        >
          {/* forceMount: the editor's unsaved draft and a crate's running analysis dialog survive a tab switch. */}
          <TabsContent value="track" forceMount className="data-[state=inactive]:hidden">
            {isDj && (
              <Button ref={flowButtonRef} type="button" variant="outline" size="sm"
                className="mb-3 w-full justify-start gap-2"
                aria-expanded={drawer === "flow"} aria-controls="library-flow-drawer"
                onClick={() => toggleDrawer("flow")}>
                <Workflow aria-hidden="true" className="h-3.5 w-3.5 text-cm-cyan" />
                Flow Finder
                <span className="ml-auto truncate text-[11px] font-normal text-cm-faint">
                  {selected ? "από το επιλεγμένο" : "διάλεξε Track A"}
                </span>
              </Button>
            )}
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
                    bumpMembership();
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
          </TabsContent>
          <TabsContent value="crates" forceMount className="data-[state=inactive]:hidden">
            <LibraryCrates
              active={tab === "crates"}
              revision={crateRevision}
              onOpen={runQuery}
              canSave={Boolean(query.trim())}
              onSave={saveCrate}
              onChanged={bumpMembership}
            />
          </TabsContent>
          <TabsContent value="sets" forceMount className="data-[state=inactive]:hidden">
            <LibrarySets
              sets={sets}
              activeSetId={activeSetId}
              onActiveSetChange={setActiveSetId}
              onCreateSet={newSetForCrate}
            />
          </TabsContent>
        </aside>
        {/* Outside the scroll mask: reserves space instead of covering editor fields. */}
        <div ref={setProfileFooter} hidden={!selected || tab !== "track"} role="group" aria-label="Αποθήκευση προφίλ"
          className="shrink-0 border-t border-cm-border bg-cm-bg-2/40 px-4 py-3 backdrop-blur-xl" />
      </Tabs>
      </div>
      {isDj && (
        <>
          <LibraryDrawer
            open={drawer === "tags"}
            id="library-tags-drawer"
            title="Ετικέτες"
            icon={Hash}
            width={`min(${rightPanelWidth}px, calc(100% - 48px))`}
            onClose={() => setDrawer(null)}
            returnFocus={() => tagsButtonRef.current}
            fallbackFocus={() => inspectorRef.current}
          >
            <TagsDrawerBody appliedQuery={appliedQuery} onPick={runQuery} />
          </LibraryDrawer>
          <LibraryDrawer
            open={drawer === "flow"}
            id="library-flow-drawer"
            title="Flow Finder"
            icon={Workflow}
            width={`min(${rightPanelWidth * 2}px, calc(100% - 48px))`}
            onClose={() => setDrawer(null)}
            returnFocus={() => flowButtonRef.current}
            fallbackFocus={() => inspectorRef.current}
          >
            <FlowFinderPanel seed={selected?.track ?? null} />
          </LibraryDrawer>
        </>
      )}
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
