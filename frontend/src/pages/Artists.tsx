import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { useCapabilities } from "../lib/capabilities";
import { getPref } from "../lib/prefs";
import { api } from "../lib/api";
import { TASK_RESULT_TOAST, translateJobError } from "../lib/labels";
import { pollJob, type JobConnection } from "../lib/jobPolling";
import { useArtists } from "../lib/useArtists";
import type { ArtistStats, Job } from "../lib/types";
import { researchAgainDialog } from "../lib/researchAgain";
import { parseQueryChips } from "../lib/queryChips";
import { useMediaQuery } from "../lib/useMediaQuery";
import { dealColumns } from "../lib/masonry";
import { copyText } from "../lib/clipboard";
import { artistMenuEntries } from "../lib/menus/artistMenu";
import { ActionContextMenu } from "../components/ui/context-menu";
import { GlassPanel } from "../components/ui/GlassPanel";
import { SmartChip } from "../components/ui/SmartChip";
import { EmptyState } from "../components/ui/EmptyState";
import { canAcceptArtistCandidate } from "../components/ArtistResearchEvidence";
import { ArtistGenreResultCard } from "../components/ArtistGenreResultCard";
import { ArtistEnrichmentProgress } from "../components/ArtistEnrichmentProgress";
import { getLunaGenreResult, isUnknownArtist } from "../lib/artistGenreResults";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { PageHeader } from "../components/ui/PageHeader";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Loader2, RotateCcw, UserRound, Search, Tags, Wrench } from "../lib/icons";

const PRESETS = [
  { label: "Όλα", view: "" },
  { label: "Προς επιβεβαίωση", view: "needs_review" },
  { label: "Επιβεβαιωμένα", view: "confirmed" },
];

export default function Artists() {
  const capabilities = useCapabilities();
  // Therapy hides the genre research (DJ-genre taxonomy); the page remounts on a profile switch.
  const therapy = getPref("libraryProfile") === "therapy";
  // Same breakpoints as the old columns-1 / md:2 / xl:3 / 2xl:4.
  const md = useMediaQuery("(min-width: 768px)");
  const xl = useMediaQuery("(min-width: 1280px)");
  const xxl = useMediaQuery("(min-width: 1536px)");
  const columnCount = xxl ? 4 : xl ? 3 : md ? 2 : 1;
  const [params, setParams] = useSearchParams();
  const [savingReview, setSavingReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [enrichmentJob, setEnrichmentJob] = useState<Job | null>(null);
  const [connection, setConnection] = useState<JobConnection>("connecting");
  const [stopping, setStopping] = useState<number | null>(null);
  // «Νέα έρευνα για όλους»: the dialog shows the backend's count; null while it loads.
  const [againOpen, setAgainOpen] = useState(false);
  const [againStats, setAgainStats] = useState<ArtistStats | null>(null);
  const polling = useRef<AbortController | null>(null);
  const [query, setQuery] = useState(params.get("q") ?? "");
  const navigate = useNavigate();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; polling.current?.abort(); };
  }, []);

  const view = params.get("view") ?? "";

  const { rows, loading, load } = useArtists({ enabled: true, q: query, toastOnError: true });

  useEffect(() => {
    setQuery(params.get("q") ?? "");
  }, [params]);

  async function poll(initial: Job) {
    polling.current?.abort();
    const controller = new AbortController();
    polling.current = controller;
    setEnrichmentJob(initial);
    let lastProcessed = initial.processed;
    const terminal = await pollJob({
      jobId: initial.id,
      signal: controller.signal,
      read: api.scanStatus,
      onJob: job => {
        setEnrichmentJob(job);
        if (job.processed !== lastProcessed) {
          lastProcessed = job.processed;
          void load();
        }
      },
      onConnection: setConnection,
    });
    if (controller.signal.aborted || !mounted.current) return;
    setStopping(null);
    if (terminal?.status === "error") toast.error(translateJobError(terminal.error, "Αποτυχία έρευνας ειδών"), TASK_RESULT_TOAST);
    else toast.success(terminal?.message || "Ο εμπλουτισμός ολοκληρώθηκε", TASK_RESULT_TOAST);
    setBusy(false);
    await load();
  }

  async function runRebuild() {
    setBusy(true);
    setEnrichmentJob(null);
    try {
      await api.rebuildArtists();
      toast.success("Η λίστα καλλιτεχνών ενημερώθηκε");
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function runEnrich(again = false) {
    if (!capabilities.artist_enrichment) return;
    setAgainOpen(false);
    setBusy(true);
    setEnrichmentJob(null);
    try {
      const job = await api.enrichArtists(again ? { again: true } : {});
      await poll(job);
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  }

  async function openAgain() {
    if (!capabilities.artist_enrichment) return;
    setAgainStats(null);
    setAgainOpen(true);
    try {
      const stats = await api.artistStats();
      if (mounted.current) setAgainStats(stats);
    } catch (e) {
      setAgainOpen(false);
      toast.error((e as Error).message);
    }
  }

  async function stopEnrich(job: Job) {
    setStopping(job.id);
    try {
      await api.stopArtistEnrich(job.id);
      toast.info("Η έρευνα σταματά μόλις τελειώσουν οι κλήσεις που τρέχουν· τα ευρήματά τους κρατιούνται.");
    } catch (e) {
      setStopping(null);
      toast.error((e as Error).message);
    }
  }

  const running = enrichmentJob && ["pending", "running"].includes(enrichmentJob.status) ? enrichmentJob : null;
  const againText = againStats ? researchAgainDialog(againStats.research_again_artists, againStats.research_model) : null;

  async function choose(id: number, choice: "candidate" | "current" | "manual", genre?: string) {
    if (!capabilities.artist_enrichment) return;
    const row = rows.find(row => row.id === id);
    if (row?.review?.state === "confirmed" || (choice === "candidate" && !canAcceptArtistCandidate(row?.review?.candidate, row?.review?.state))) return;
    setSavingReview(true);
    try {
      await api.chooseArtistFinding(id, choice, genre);
      await load();
      toast.success("Η επιλογή επιβεβαιώθηκε");
    } catch (e) {
      toast.error((e as Error).message);
      throw e;
    } finally { setSavingReview(false); }
  }

  useEffect(() => {
    if (!capabilities.artist_enrichment) return;
    api.artistComparisonStatus().then(job => {
      if (mounted.current && job && ["pending", "running"].includes(job.status)) {
        setBusy(true);
        void poll(job);
      }
    }).catch(() => {});
  }, [capabilities.artist_enrichment]);

  const results = useMemo(() => rows.flatMap(artist => {
    const result = getLunaGenreResult(artist);
    return result ? [{ artist, result }] : [];
  }), [rows]);
  const filtered = useMemo(() => {
    if (view === "needs_review" || view === "unenriched") return results.filter(({ result }) => !result.confirmed);
    if (view === "confirmed") return results.filter(({ result }) => result.confirmed);
    return results;
  }, [results, view]);
  const unknownArtist = view ? undefined : rows.find(isUnknownArtist);

  // A right-click on a card: the artist's tracks in the Library (as «Βιβλιοθήκη») and the name; the card itself is the review.
  const artistMenu = {
    entries: (name: string) => artistMenuEntries(name, {
      openTracks: () => navigate("/library?q=" + encodeURIComponent(`artist:"${name}"`)),
      copy: text => void copyText(text),
    }),
  };

  const runQuery = (nextQ: string, nextView = view) => {
    const next: Record<string, string> = {};
    if (nextQ) next.q = nextQ;
    if (nextView) next.view = nextView;
    setParams(next);
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon={UserRound}
        title="Καλλιτέχνες"
        count={filtered.length}
        subtitle={therapy ? undefined : "Ευρήματα έρευνας ειδών με πηγές από το web."}
        actions={
          <>
            {enrichmentJob && <ArtistEnrichmentProgress job={enrichmentJob} connection={connection} />}
            {busy && !enrichmentJob && <p role="status" className="text-xs text-cm-muted">Η εργασία βρίσκεται σε εξέλιξη…</p>}
            <Button onClick={runRebuild} disabled={busy} variant="outline" size="sm">
              <Wrench />
              Ανανέωση λίστας
            </Button>
            {running && <Button onClick={() => void stopEnrich(running)} disabled={stopping === running.id} variant="outline" size="sm"
              title="Καμία νέα κλήση· όσες τρέχουν τελειώνουν και κρατιούνται">
              {stopping === running.id ? <><Loader2 className="animate-spin" />Σταματά…</> : "Διακοπή"}
            </Button>}
            {capabilities.artist_enrichment && !therapy && <Button onClick={() => void runEnrich()} disabled={busy} variant="outline" size="sm">
              {busy ? <Loader2 className="animate-spin" /> : <Search />}
              Έρευνα ειδών
            </Button>}
            {capabilities.artist_enrichment && !therapy && <Button onClick={() => void openAgain()} disabled={busy} variant="outline" size="sm"
              title="Ξανά έρευνα, με το μοντέλο που έχεις ρυθμίσει, για κάθε καλλιτέχνη που δεν έχεις επιβεβαιώσει">
              <RotateCcw />
              Νέα έρευνα για όλους
            </Button>}
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto p-5 scroll-fade-y">

        <div className="mb-4 flex gap-2">
          <div className="glass flex flex-1 items-center gap-2 rounded-xl px-3 py-2">
            <Search className="h-4 w-4 shrink-0 text-cm-faint" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") runQuery(query);
              }}
              placeholder="Αναζήτηση καλλιτέχνη…"
              wrapperClassName="flex-1"
              className="border-none bg-transparent p-0 text-sm text-cm-text shadow-none ring-0 placeholder:text-cm-faint focus-visible:ring-0"
            />
          </div>
        </div>

        <div className="mb-4 flex flex-wrap gap-1.5">
          {PRESETS.map((preset) => (
            <SmartChip
              key={preset.label}
              tone={preset.view ? "cyan" : "muted"}
              active={view === preset.view}
              onClick={() => runQuery(query, preset.view)}
            >
              {preset.label}
            </SmartChip>
          ))}
          {query.trim() &&
            parseQueryChips(`artist:"${query}"`).map((chip, idx) => (
              <SmartChip key={`${chip.label}-${idx}`} tone={chip.tone}>
                {chip.label}
              </SmartChip>
            ))}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-6 w-6 animate-spin text-cm-faint" />
          </div>
        ) : <>
          {filtered.length === 0 && (
            <EmptyState icon={Tags} title={view === "confirmed" ? "Δεν υπάρχουν επιβεβαιωμένα ευρήματα έρευνας" : view === "needs_review" || view === "unenriched" ? "Δεν υπάρχουν ευρήματα έρευνας προς επιβεβαίωση" : "Δεν υπάρχουν ακόμη ευρήματα έρευνας"}>
              {results.length === 0
                ? "Οι παλιότερες εκτιμήσεις δεν εμφανίζονται εδώ. Ξεκίνα έρευνα ειδών για νέα ευρήματα με πηγές."
                : "Δοκίμασε το φίλτρο Όλα ή άλλαξε την αναζήτηση."}
            </EmptyState>
          )}
          {/* Masonry without CSS columns: WebKit misplaces glass (backdrop-filter) cards inside multi-column layout.
              Cards are dealt left to right into independent column stacks. */}
          <ActionContextMenu menu={artistMenu} rowSelector="[data-artist-name]" pick={row => row.dataset.artistName}>
          <div className="grid items-start gap-3" style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }}>
            {dealColumns([
            ...filtered.map(({ artist, result }) => (
              <div key={artist.id} data-artist-name={artist.canonical_name} className="min-w-0">
              <ArtistGenreResultCard
                artist={artist}
                result={result}
                disabled={savingReview || therapy}
                onLibrary={() => navigate("/library?q=" + encodeURIComponent(`artist:"${artist.canonical_name}"`))}
                onConfirm={(choice, genre) => choose(artist.id, choice, genre)}
              />
              </div>
            )),
            unknownArtist && <GlassPanel key="unknown-artist" data-artist-name={unknownArtist.canonical_name} strong className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <h2 className="break-words text-sm font-semibold text-cm-text">{unknownArtist.canonical_name}</h2>
                  <p className="mt-1 text-xs text-cm-faint">{unknownArtist.track_count.toLocaleString("el-GR")} κομμάτια</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => navigate("/library?q=" + encodeURIComponent(`artist:"${unknownArtist.canonical_name}"`))}>Βιβλιοθήκη</Button>
              </div>
              <p className="mt-3 text-xs text-cm-muted">Κομμάτια χωρίς αναγνωρισμένο καλλιτέχνη.</p>
            </GlassPanel>,
            ], columnCount).map((column, index) => (
              <div key={index} className="flex min-w-0 flex-col gap-3">{column}</div>
            ))}
          </div>
          </ActionContextMenu>
        </>}
      </div>
      <Dialog open={againOpen} onOpenChange={setAgainOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Νέα έρευνα για όλους</DialogTitle>
            <DialogDescription className="sr-only">Επιβεβαίωση νέας έρευνας ειδών με το μοντέλο που έχεις ρυθμίσει.</DialogDescription>
          </DialogHeader>
          {againText ? (
            <ul className="space-y-2 text-sm text-cm-muted">
              {againText.lines.map(line => <li key={line} className="text-pretty">{line}</li>)}
            </ul>
          ) : (
            <p role="status" className="flex items-center gap-2 text-sm text-cm-muted"><Loader2 className="size-4 animate-spin" />Μέτρηση καλλιτεχνών…</p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setAgainOpen(false)}>Ακύρωση</Button>
            <Button type="button" disabled={!againText?.canStart || busy} onClick={() => void runEnrich(true)}>Έναρξη έρευνας</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
