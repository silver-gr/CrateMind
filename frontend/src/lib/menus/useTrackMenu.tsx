import { useMemo, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { AnalyzeBpmDialog } from "../../components/AnalyzeBpmDialog";
import { changeBpm } from "../../components/BpmOctaveButtons";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { api } from "../api";
import { useCapabilities } from "../capabilities";
import { copyText } from "../clipboard";
import { nativeAction } from "../desktopRuntime";
import { apiMessage, notifyFacetsChanged } from "../facets";
import { statusLabel } from "../labels";
import { getMixSession } from "../mix/mixSession";
import { deckIsPlaying, usePlayer, type DeckId } from "../player";
import { usePref } from "../prefs";
import { rememberSetTarget } from "../setTargets";
import type { DJSet, SoundCloudTrackDetail, Track } from "../types";
import { useSetTrackAddition } from "../useSetTrackAddition";
import { mapMenu, type MaybeEntry, type MenuEntry, type MenuSource } from "./entries";
import { selectionMenuEntries, trackLine, trackMenuEntries, type TrackMenuContext } from "./trackMenu";

/**
 * A loaded track, a track known only by id (recommendations, duplicates: loaded on open), or a Library selection.
 * `placeItems` go last, after a separator; `inOwnSet` (a set row) leaves out «Προσθήκη στο «…»».
 */
export type TrackMenuSubject =
  | { kind: "track"; track: Track; inOwnSet?: boolean; placeItems?: MaybeEntry[] }
  | { kind: "ref"; id: number; placeItems?: MaybeEntry[] }
  | { kind: "selection"; tracks: Track[] };

/** What a place adds or changes; everything else is the app's own action. */
export interface TrackMenuOptions {
  /** The place's play (Library also selects); default: routed play. */
  play?(track: Track): void;
  /** The place's own set: «Προσθήκη στο «…»». A null title shows it disabled. */
  ownSet?: { id: number | null; title: string | null; reason?: string; add(tracks: Track[]): void };
  /** A set the rows already belong to: left out of «Προσθήκη σε set». */
  currentSetId?: number | null;
  /** The place's set list; without it the list is fetched each time a menu opens. */
  sets?: DJSet[];
  /** A set was created from the menu. */
  onSetCreated?(): void;
  edit?(track: Track): void;
  flowFinder?(track: Track): void;
  /** Default: the Library filtered to this artist. */
  openArtist?(artist: string): void;
  artistFiltered?(artist: string): boolean;
  /** Default: writes the status and calls `onChanged`. */
  setStatus?(track: Track, status: string): void;
  statusKeys?: Partial<Record<string, string>>;
  editingTrackId?: number | null;
  /** Tracks whose profile or BPM analysis changed from the menu. */
  onChanged?(ids: number[]): void;
  bulkEdit?(): void;
  clearSelection?(): void;
}

const mixRunning = () => {
  const s = getMixSession();
  return s.mode === "set" && s.status !== "idle" && s.status !== "stopping";
};

/** The list summary carries the status; a fetched detail keeps it on its profile. */
const detailTrack = (d: SoundCloudTrackDetail): Track => ({ ...d.track, personal_status: d.profile?.personal_status ?? d.track.personal_status });

/**
 * The track menu for one place: call once, give `menu` to the place's ActionContextMenu (or TrackTable `rowMenu`)
 * and render `dialogs`. `menu` keeps its identity while nothing it shows changes, so memoised lists stay quiet.
 */
export function useTrackMenu(options: TrackMenuOptions): {
  menu: MenuSource<TrackMenuSubject>;
  /** The same menu for rows that each hold one loaded track. */
  trackRows: MenuSource<Track>;
  dialogs: React.ReactNode;
} {
  const { playRouted, load } = usePlayer();
  const capabilities = useCapabilities();
  const [profile] = usePref("libraryProfile");
  const navigate = useNavigate();
  const { addToSet, addManyToSet, duplicateDialog } = useSetTrackAddition();
  const [fetchedSets, setFetchedSets] = useState<DJSet[] | null>(null);
  const [lazy, setLazy] = useState<{ id: number; track?: Track; failed?: boolean } | null>(null);
  const [analyzeIds, setAnalyzeIds] = useState<number[] | null>(null);
  const [analyzeOpen, setAnalyzeOpen] = useState(false);
  const [naming, setNaming] = useState<Track[] | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const live = useRef({ options, playRouted, load, navigate, addToSet, addManyToSet });
  live.current = { options, playRouted, load, navigate, addToSet, addManyToSet };

  async function addTo(set: DJSet, tracks: Track[]) {
    const { addToSet, addManyToSet, navigate } = live.current;
    const added = tracks.length === 1
      ? (await addToSet(set.id, tracks[0].id) ? 1 : null)
      : await addManyToSet(set.id, tracks.map(track => track.id));
    if (added === null) return;
    if (added === 0) {
      toast(`Όλα υπάρχουν ήδη στο «${set.title}»`);
      return;
    }
    rememberSetTarget(set.id);
    toast.success(tracks.length === 1 ? `Προστέθηκε στο «${set.title}»` : `Προστέθηκαν ${added} στο «${set.title}»`, {
      action: { label: "Άνοιγμα", onClick: () => navigate(`/sets?id=${set.id}`) },
    });
  }

  async function createAndAdd(event: FormEvent) {
    event.preventDefault();
    const title = name.trim();
    if (!title || creating || !naming) return;
    setCreating(true);
    try {
      const created = await api.createSet(title);
      const tracks = naming;
      setNaming(null);
      live.current.options.onSetCreated?.();
      await addTo(created, tracks);
    } catch {
      toast.error("Δεν ήταν δυνατή η δημιουργία του set");
    } finally {
      setCreating(false);
    }
  }

  const menu = useMemo<MenuSource<TrackMenuSubject>>(() => {
    const context = (inOwnSet = false): TrackMenuContext => {
      const { options: o, playRouted, load, navigate } = live.current;
      return {
        profile,
        deckPlaying: { A: deckIsPlaying("A"), B: deckIsPlaying("B") },
        mixRunning: mixRunning(),
        sets: o.sets ?? fetchedSets,
        ownSetId: o.ownSet ? o.ownSet.id : o.currentSetId ?? null,
        ownSetTitle: o.ownSet?.title,
        ownSetReason: o.ownSet?.reason,
        editingTrackId: o.editingTrackId,
        statusKeys: o.statusKeys,
        artistFiltered: o.artistFiltered,
        play: o.play ?? playRouted,
        load: (deck: DeckId, track: Track) => {
          if (!load(deck, track, { play: false, ifIdle: true })) toast(`Το Deck ${deck} παίζει — δεν φορτώθηκε`);
        },
        addToOwnSet: inOwnSet ? undefined : o.ownSet?.add,
        addToSet: (set, tracks) => void addTo(set, tracks),
        newSet: tracks => { setName(""); setNaming(tracks); },
        edit: o.edit,
        setStatus: o.setStatus ?? ((track, status) => {
          api.updateProfile(track.id, { personal_status: status }).then(() => {
            notifyFacetsChanged();
            toast.success(`${trackLine(track)}: ${statusLabel(status, profile)}`);
            live.current.options.onChanged?.([track.id]);
          }, error => { toast.error(apiMessage(error)); });
        }),
        bpm: changeBpm,
        analyze: capabilities.analysis ? tracks => { setAnalyzeIds(tracks.map(track => track.id)); setAnalyzeOpen(true); } : undefined,
        flowFinder: o.flowFinder,
        openArtist: o.openArtist ?? (artist => navigate("/library?q=" + encodeURIComponent(`artist:"${artist}"`))),
        reveal: capabilities.native_dialogs ? track => {
          void nativeAction("reveal_path", { track_id: track.id }).catch(error => toast.error((error as Error).message));
        } : undefined,
        copy: text => void copyText(text),
        bulkEdit: o.bulkEdit,
        clearSelection: o.clearSelection,
      };
    };
    return {
      entries(subject): MenuEntry[] {
        if (subject.kind === "selection") return selectionMenuEntries(subject.tracks, context());
        const loaded = subject.kind === "ref" && lazy?.id === subject.id ? lazy : null;
        const track = subject.kind === "track" ? subject.track : loaded?.track;
        if (!track) return [{ type: "label", label: loaded?.failed ? "Δεν φορτώθηκε το κομμάτι" : "Φόρτωση…" }];
        return trackMenuEntries(track, context(subject.kind === "track" && subject.inOwnSet), subject.placeItems);
      },
      onOpenChange(open, subject) {
        if (!open) return;
        if (!live.current.options.sets) api.listSets().then(setFetchedSets).catch(() => setFetchedSets(current => current ?? []));
        if (subject.kind !== "ref") return;
        const id = subject.id;
        setLazy(current => (current?.id === id && current.track ? current : { id }));
        api.getTrack(id).then(
          detail => setLazy(current => (current?.id === id ? { id, track: detailTrack(detail) } : current)),
          () => setLazy(current => (current?.id === id && !current.track ? { id, failed: true } : current)),
        );
      },
    };
    // `addTo` and the options are read through `live`; the menu changes only with what it shows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, capabilities, fetchedSets, lazy]);
  const trackRows = useMemo(() => mapMenu(menu, (track: Track): TrackMenuSubject => ({ kind: "track", track })), [menu]);

  const dialogs = (
    <>
      {duplicateDialog}
      <Dialog open={naming !== null} onOpenChange={open => { if (!open && !creating) setNaming(null); }}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader><DialogTitle>Νέο set</DialogTitle></DialogHeader>
          <form onSubmit={createAndAdd} className="space-y-4">
            <label className="block space-y-2">
              Τίτλος set
              <Input autoFocus required value={name} disabled={creating} onChange={event => setName(event.target.value)} />
            </label>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" disabled={creating} onClick={() => setNaming(null)}>Ακύρωση</Button>
              <Button type="submit" disabled={creating || !name.trim()}>{creating ? "Δημιουργία…" : "Δημιουργία"}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      {capabilities.analysis && analyzeIds && (
        <AnalyzeBpmDialog
          scope={{ trackIds: analyzeIds }}
          open={analyzeOpen}
          onOpenChange={setAnalyzeOpen}
          onDone={() => live.current.options.onChanged?.(analyzeIds)}
        />
      )}
    </>
  );
  return { menu, trackRows, dialogs };
}
