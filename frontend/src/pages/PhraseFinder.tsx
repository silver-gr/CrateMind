import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "../components/ui/PageHeader";
import { GlossaryLink } from "../components/GlossaryLink";
import { GlassPanel } from "../components/ui/GlassPanel";
import { EmptyState } from "../components/ui/EmptyState";
import { Input } from "../components/ui/input";
import { Button } from "../components/ui/button";
import { StructureMap } from "../components/StructureMap";
import { ActionContextMenu } from "../components/ui/context-menu";
import { api } from "../lib/api";
import { buildBeatGrid, useBeatGridDto } from "../lib/beatGrid";
import { ANALYSIS_FINISHED } from "../lib/bpmUpdates";
import { cn } from "../lib/cn";
import { AudioWaveform, Search } from "../lib/icons";
import { useTrackMenu } from "../lib/menus/useTrackMenu";
import { deckTransportOf } from "../lib/mix/deckTransport";
import { usePlayer, type DeckId } from "../lib/player";
import { usePref } from "../lib/prefs";
import { effectiveBpm } from "../lib/tempo";
import { useDownbeat } from "../lib/trackDownbeat";
import { cueSuggestions, formatClock, mixPoints, padMixPoints, STRUCTURE_SURE, structureDuration, structureSummary, type StructureSummary, type TrackStructure } from "../lib/trackStructure";
import type { Track, TrackCue } from "../lib/types";

const LIST_SIZE = 100;
/** A saved cue this close (seconds) to a mix point is that point. */
const SAME_CUE_S = 0.05;

// One pending seek per deck: the newest load wins, and it survives leaving the page (the decks are global).
const pendingSeek: Partial<Record<DeckId, number>> = {};
/** Seek `deck` to `seconds` once it holds `trackId` with its source ready; gives up after 15 s. */
function seekWhenReady(deck: DeckId, trackId: number, seconds: number) {
  window.clearInterval(pendingSeek[deck]);
  const started = performance.now();
  pendingSeek[deck] = window.setInterval(() => {
    const transport = deckTransportOf(deck);
    if (transport?.trackId === trackId && transport.ready) { window.clearInterval(pendingSeek[deck]); transport.seekTo(seconds); }
    else if (performance.now() - started > 15_000) window.clearInterval(pendingSeek[deck]);
  }, 100);
}

const durationOf = (track: Track, structure: StructureSummary) =>
  track.duration != null && track.duration > 0 ? track.duration : structureDuration(structure.sections);

export default function PhraseFinder() {
  const { load } = usePlayer();
  const [query, setQuery] = useState("");
  const [tracks, setTracks] = useState<Track[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [summaries, setSummaries] = useState<Record<string, StructureSummary>>({});
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<{ id: number; structure: TrackStructure | null; cues: TrackCue[] } | null>(null);
  const [revision, setRevision] = useState(0);

  // An analysis measures structures: what is on screen is asked again when one finishes.
  useEffect(() => {
    const refresh = () => setRevision(n => n + 1);
    window.addEventListener(ANALYSIS_FINISHED, refresh);
    return () => window.removeEventListener(ANALYSIS_FINISHED, refresh);
  }, []);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(async () => {
      try {
        const found = await api.listTracks(query.trim() || undefined, LIST_SIZE);
        const maps = found.length ? await api.getTrackStructures(found.map(t => t.id)) : {};
        if (!active) return;
        setTracks(found); setSummaries(maps); setFailed(false);
      } catch {
        if (active) { setTracks([]); setFailed(true); }
      }
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [query, revision]);

  useEffect(() => {
    if (selectedId == null) return;
    let active = true;
    Promise.all([api.getTrackStructure(selectedId).catch(() => null), api.getTrackCues(selectedId).catch(() => [])])
      .then(([structure, cues]) => { if (active) setDetail({ id: selectedId, structure, cues }); });
    return () => { active = false; };
  }, [selectedId, revision]);

  const selected = useMemo(() => tracks?.find(t => t.id === selectedId) ?? null, [tracks, selectedId]);
  const shown = detail && detail.id === selectedId ? detail : null;
  const measured = tracks ? tracks.filter(t => summaries[t.id]).length : 0;
  // The track menu on the list; a status or BPM changed from it is read again.
  const { trackRows: trackMenu, dialogs: trackMenuDialogs } = useTrackMenu({ onChanged: () => setRevision(n => n + 1) });

  // «Προτεινόμενα cues από τη δομή»: the points a deck would suggest, on the grid a deck would build (asked for only with the switch on).
  const [suggest] = usePref("cueSuggestions");
  const gridDto = useBeatGridDto(suggest ? selectedId : null);
  const userDownbeat = useDownbeat(suggest ? selectedId : null).value;
  const suggestions = useMemo(() => {
    if (!suggest || !selected || !shown?.structure) return [];
    const entry = shown.cues.find(cue => cue.kind === "entry")?.position_ms;
    return cueSuggestions(shown.structure, buildBeatGrid(gridDto, effectiveBpm(selected), entry != null ? entry / 1000 : null, userDownbeat), durationOf(selected, shown.structure));
  }, [suggest, selected, shown, gridDto, userDownbeat]);

  function loadOnDeck(deck: DeckId, track: Track, seconds?: number) {
    const transport = deckTransportOf(deck);
    if (seconds != null && transport?.trackId === track.id && transport.ready && !transport.playing) { transport.seekTo(seconds); return; }
    if (!load(deck, track, { play: false, ifIdle: true })) { toast(`Το Deck ${deck} παίζει — δεν φορτώθηκε`); return; }
    if (seconds != null) seekWhenReady(deck, track.id, seconds);
  }

  async function saveCue(track: Track, seconds: number, label: string) {
    try {
      const cue = await api.createTrackCue(track.id, { position_ms: Math.round(seconds * 1000), kind: "cue", label });
      setDetail(d => (d && d.id === track.id ? { ...d, cues: [...d.cues, cue] } : d));
      toast.success(`Αποθηκεύτηκε cue στο ${formatClock(seconds)}`);
    } catch {
      toast.error("Το cue δεν αποθηκεύτηκε");
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {trackMenuDialogs}
      <PageHeader icon={AudioWaveform} title="Phrase Finder" count={tracks ? `${measured} από ${tracks.length} με δομή` : null}
        subtitle="Πού αλλάζει κάθε κομμάτι: μέρη με και χωρίς μπάσο, και φράσεις των 8 bars μετρημένες από εκεί που μπαίνει το μπάσο."
        actions={<GlossaryLink id="phrase" />} className="px-4 sm:px-6" />
      <div className="flex min-h-0 flex-1 flex-col gap-4 px-4 pt-4 pb-4 sm:px-6 lg:flex-row">
        <section aria-label="Κομμάτια" className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
          <label className="relative block">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-cm-muted" />
            <Input value={query} onChange={e => setQuery(e.target.value)} placeholder="Αναζήτηση, όπως στη Βιβλιοθήκη (π.χ. bpm:145-150 status:approved)"
              aria-label="Αναζήτηση κομματιών" className="pl-9" />
          </label>
          <div className="scroll-fade-b min-h-0 flex-1 overflow-y-auto pb-24" aria-busy={tracks === null}>
            {tracks === null ? <p role="status" className="py-8 text-center text-sm text-cm-muted">Φόρτωση…</p>
              : failed ? <EmptyState icon={Search} title="Δεν φορτώθηκαν τα κομμάτια">Έλεγξε την αναζήτηση και δοκίμασε ξανά.</EmptyState>
              : tracks.length === 0 ? <EmptyState icon={Search} title="Κανένα κομμάτι">Καμία αντιστοιχία με την αναζήτηση.</EmptyState>
              : (
                <ActionContextMenu menu={trackMenu} rowSelector="[data-track-id]"
                  pick={row => tracks.find(t => t.id === Number(row.dataset.trackId))}>
                <ul className="space-y-1">
                  {tracks.map(track => {
                    const summary = summaries[track.id];
                    const bpm = effectiveBpm(track);
                    return (
                      <li key={track.id} data-track-id={track.id}>
                        <button type="button" onClick={() => setSelectedId(track.id)} aria-pressed={track.id === selectedId}
                          className={cn("grid w-full grid-cols-[minmax(0,1fr)_minmax(160px,45%)] items-center gap-4 rounded-lg border px-3 py-2 text-left outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-cm-cyan",
                            track.id === selectedId ? "border-cm-cyan/40 bg-cm-cyan/8" : "border-transparent hover:bg-cm-contrast/5")}>
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium text-cm-text">{track.title || track.file_name}</span>
                            <span className="block truncate text-xs text-cm-muted">{[track.artist, bpm != null ? `${bpm.toFixed(bpm % 1 ? 1 : 0)} BPM` : null].filter(Boolean).join(" · ")}</span>
                          </span>
                          {summary ? (
                            <span className="min-w-0">
                              <StructureMap sections={summary.sections} duration={durationOf(track, summary)} className="h-6" />
                              <span className="mt-1 block truncate text-[11px] text-cm-muted" title={structureSummary(summary.sections)}>{structureSummary(summary.sections)}</span>
                            </span>
                          ) : <span className="text-xs text-cm-faint">Χωρίς δομή</span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
                </ActionContextMenu>
              )}
          </div>
        </section>

        <GlassPanel className="min-h-0 shrink-0 overflow-y-auto p-5 lg:w-[460px] xl:w-[540px]">
          {!selected ? (
            <EmptyState icon={AudioWaveform} title="Διάλεξε κομμάτι">
              Δες τα μέρη του, τις φράσεις του και τα σημεία όπου αξίζει να μπεις ή να βγεις.
            </EmptyState>
          ) : (
            <div className="space-y-5">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-base font-semibold text-cm-text" title={selected.title || selected.file_name}>{selected.title || selected.file_name}</h2>
                  <p className="truncate text-sm text-cm-muted">{selected.artist}</p>
                </div>
                <Button type="button" size="sm" variant="outline" onClick={() => loadOnDeck("A", selected)}>→ Deck A</Button>
                <Button type="button" size="sm" variant="outline" onClick={() => loadOnDeck("B", selected)}>→ Deck B</Button>
              </div>
              {!shown ? <p role="status" className="py-6 text-center text-sm text-cm-muted">Φόρτωση δομής…</p>
                : !shown.structure ? (
                  <EmptyState icon={AudioWaveform} title="Χωρίς δομή">
                    Είτε δεν έχει μετρηθεί ακόμα (τρέξε «BPM + Key · μόνο νέα» στις Ρυθμίσεις), είτε το μπάσο του δεν ξεχωρίζει καθαρά σε μέρη, είτε δεν έχει βέβαιο beatgrid.
                  </EmptyState>
                ) : (
                  <>
                    <div>
                      <StructureMap sections={shown.structure.sections} duration={durationOf(selected, shown.structure)}
                        phrases={shown.structure.phrases} anchors={shown.structure.anchors} className="h-24" />
                      <div className="mt-1 flex justify-between font-mono text-[10px] text-cm-faint tabular-nums">
                        <span>0:00</span><span>{formatClock(durationOf(selected, shown.structure))}</span>
                      </div>
                      <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-cm-muted">
                        <span className="inline-flex items-center gap-1.5"><span aria-hidden className="size-2.5 rounded-[3px] bg-cm-cyan/65" />με μπάσο</span>
                        <span className="inline-flex items-center gap-1.5"><span aria-hidden className="size-2.5 rounded-[3px] border border-cm-contrast/25 bg-cm-contrast/8" />χωρίς μπάσο</span>
                        <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-3 w-px bg-cm-text/75" />μπαίνει το μπάσο</span>
                        <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-3 w-px bg-cm-text/25" />φράση (8 bars)</span>
                      </p>
                      {shown.structure.quality < STRUCTURE_SURE && (
                        <p className="mt-2 text-xs text-cm-amber">Αβέβαιη δομή: το μπάσο αυτού του κομματιού δεν ξεχωρίζει καθαρά σε «παίζει» και «δεν παίζει».</p>
                      )}
                    </div>
                    <div>
                      <h3 className="mb-2 text-xs font-semibold tracking-wide text-cm-muted uppercase">Σημεία μίξης</h3>
                      <ul className="divide-y divide-cm-contrast/8">
                        {padMixPoints(mixPoints(shown.structure.sections), suggestions).map(point => {
                          const saved = shown.cues.some(cue => Math.abs(cue.position_ms / 1000 - point.time_s) <= SAME_CUE_S);
                          return (
                            <li key={`${point.kind}-${point.time_s}`} className="flex items-center gap-3 py-2">
                              <span className="w-12 shrink-0 font-mono text-sm text-cm-text tabular-nums">{formatClock(point.time_s)}</span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm text-cm-text">{point.label}</span>
                                <span className="block truncate text-xs text-cm-muted">{point.detail}</span>
                              </span>
                              {point.pad != null && <span title={`Προτείνεται στο pad ${point.pad} του deck`} className="shrink-0 rounded border border-dashed border-cm-contrast/30 px-1.5 py-0.5 text-[10px] text-cm-muted">pad {point.pad}</span>}
                              <Button type="button" size="xs" variant="outline" title={`Φόρτωση στο Deck A στο ${formatClock(point.time_s)}`} aria-label={`${point.label} ${formatClock(point.time_s)}: φόρτωση στο Deck A`}
                                onClick={() => loadOnDeck("A", selected, point.time_s)}>→ A</Button>
                              <Button type="button" size="xs" variant="outline" title={`Φόρτωση στο Deck B στο ${formatClock(point.time_s)}`} aria-label={`${point.label} ${formatClock(point.time_s)}: φόρτωση στο Deck B`}
                                onClick={() => loadOnDeck("B", selected, point.time_s)}>→ B</Button>
                              <Button type="button" size="xs" variant="ghost" disabled={saved} title={saved ? "Υπάρχει ήδη cue εδώ" : "Αποθήκευση ως cue (μόνο στο CrateMind)"}
                                aria-label={`${point.label} ${formatClock(point.time_s)}: αποθήκευση ως cue`} onClick={() => saveCue(selected, point.time_s, point.label)}>{saved ? "Cue ✓" : "+ Cue"}</Button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  </>
                )}
            </div>
          )}
        </GlassPanel>
      </div>
    </div>
  );
}
