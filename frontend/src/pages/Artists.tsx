import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { useCapabilities } from "../lib/capabilities";
import { api } from "../lib/api";
import type { ArtistProfile, Job } from "../lib/types";
import { parseQueryChips } from "../lib/queryChips";
import { GlassPanel } from "../components/ui/GlassPanel";
import { SmartChip } from "../components/ui/SmartChip";
import { EmptyState } from "../components/ui/EmptyState";
import { canAcceptArtistCandidate } from "../components/ArtistResearchEvidence";
import { ArtistGenreResultCard } from "../components/ArtistGenreResultCard";
import { getLunaGenreResult, isUnknownArtist } from "../lib/artistGenreResults";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { AudioWaveform, Loader2, Search, Sparkles, Tags, Wrench } from "../lib/icons";

const PRESETS = [
  { label: "Όλα", view: "" },
  { label: "Προς επιβεβαίωση", view: "needs_review" },
  { label: "Επιβεβαιωμένα", view: "confirmed" },
];

export default function Artists() {
  const capabilities = useCapabilities();
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = useState<ArtistProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingReview, setSavingReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [query, setQuery] = useState(params.get("q") ?? "");
  const navigate = useNavigate();
  const mounted = useRef(true);
  const requestId = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; requestId.current += 1; };
  }, []);

  const view = params.get("view") ?? "";

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    try {
      const data = await api.listArtists({ q: query || undefined, min_track_count: 2, limit: 5000 });
      if (id === requestId.current && mounted.current) setRows(data);
    } catch (e) {
      if (id === requestId.current && mounted.current) toast.error((e as Error).message);
    } finally {
      if (id === requestId.current && mounted.current) setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    setQuery(params.get("q") ?? "");
  }, [params]);

  useEffect(() => {
    load();
  }, [load]);

  async function poll(jobId: number) {
    let st: Job | null = null;
    while (mounted.current) {
      st = await api.scanStatus(jobId);
      if (mounted.current) setProgress(st?.message || "Η έρευνα ειδών βρίσκεται σε εξέλιξη…");
      if (st && (st.status === "done" || st.status === "error")) {
        if (st.status === "error") toast.error(st.error || "Αποτυχία έρευνας ειδών");
        else toast.success(st.message || "Ο εμπλουτισμός ολοκληρώθηκε");
        break;
      }
      await load();
      await new Promise((r) => setTimeout(r, 2500));
    }
    if (mounted.current) {
      setBusy(false);
      setProgress("");
      await load();
    }
  }

  async function runRebuild() {
    setBusy(true);
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

  async function runEnrich() {
    if (!capabilities.artist_enrichment) return;
    setBusy(true);
    try {
      const job = await api.enrichArtists();
      await poll(job.id);
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  }

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
        poll(job.id).catch(e => { if (mounted.current) { setBusy(false); toast.error(e.message); } });
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

  const runQuery = (nextQ: string, nextView = view) => {
    const next: Record<string, string> = {};
    if (nextQ) next.q = nextQ;
    if (nextView) next.view = nextView;
    setParams(next);
  };

  return (
    <div className="h-full overflow-auto p-5 scroll-fade-y">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <AudioWaveform className="h-5 w-5 text-cm-cyan" />
        <h1 className="text-lg font-semibold text-cm-text">Καλλιτέχνες</h1>
        <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-xs tabular-nums text-cm-muted">
          {filtered.length.toLocaleString("el-GR")}
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button onClick={runRebuild} disabled={busy} variant="outline" size="sm" className="gap-1.5">
            <Wrench className="h-3.5 w-3.5" />
            Ανανέωση λίστας
          </Button>
          {capabilities.artist_enrichment && <Button onClick={runEnrich} disabled={busy} variant="outline" size="sm" className="gap-1.5">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            Έρευνα ειδών
          </Button>}
        </div>
      </div>

      <p className="mb-4 text-xs text-cm-muted">Ολοκληρωμένα αποτελέσματα έρευνας από GPT-6 Luna.</p>

      {busy && <p role="status" className="mb-4 text-xs text-cm-muted">{progress || "Η εργασία βρίσκεται σε εξέλιξη…"}</p>}

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
          <EmptyState icon={Tags} title={view === "confirmed" ? "Δεν υπάρχουν επιβεβαιωμένα αποτελέσματα Luna" : view === "needs_review" || view === "unenriched" ? "Δεν υπάρχουν αποτελέσματα Luna προς επιβεβαίωση" : "Δεν υπάρχουν ακόμη αποτελέσματα Luna"}>
            {results.length === 0
              ? "Οι παλιότερες εκτιμήσεις δεν εμφανίζονται εδώ. Ξεκίνα έρευνα ειδών για νέα αποτελέσματα με πηγές."
              : "Δοκίμασε το φίλτρο Όλα ή άλλαξε την αναζήτηση."}
          </EmptyState>
        )}
        <div className="columns-1 gap-3 md:columns-2 xl:columns-3 2xl:columns-4">
          {filtered.map(({ artist, result }) => (
            <ArtistGenreResultCard
              key={artist.id}
              artist={artist}
              result={result}
              disabled={savingReview}
              onLibrary={() => navigate("/library?q=" + encodeURIComponent(`artist:"${artist.canonical_name}"`))}
              onConfirm={(choice, genre) => choose(artist.id, choice, genre)}
            />
          ))}
          {unknownArtist && <GlassPanel strong className="mb-3 block w-full break-inside-avoid p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="break-words text-sm font-semibold text-cm-text">{unknownArtist.canonical_name}</h2>
                <p className="mt-1 text-xs text-cm-faint">{unknownArtist.track_count.toLocaleString("el-GR")} κομμάτια</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => navigate("/library?q=" + encodeURIComponent(`artist:"${unknownArtist.canonical_name}"`))}>Βιβλιοθήκη</Button>
            </div>
            <p className="mt-3 text-xs text-cm-muted">Κομμάτια χωρίς αναγνωρισμένο καλλιτέχνη.</p>
          </GlassPanel>}
        </div>
      </>}
    </div>
  );
}
