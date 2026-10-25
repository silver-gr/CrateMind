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
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { AudioWaveform, Loader2, Search, Sparkles, Tags, Wrench } from "../lib/icons";

const PRESETS = [
  { label: "Όλα", view: "" },
  { label: "Χωρίς enrichment", view: "unenriched" },
  { label: "Θέλουν έλεγχο", view: "needs_review" },
];

function displaySubgenre(row: ArtistProfile) {
  return row.primary_subgenre || row.scene_cluster || "—";
}

function showSceneCluster(row: ArtistProfile) {
  return !!row.scene_cluster && row.scene_cluster !== "unknown / mixed";
}

function showConfidence(row: ArtistProfile) {
  return !!row.confidence_label && row.confidence_label !== "unknown";
}

export default function Artists() {
  const capabilities = useCapabilities();
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = useState<ArtistProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [corrections, setCorrections] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
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
      if (st && (st.status === "done" || st.status === "error")) {
        if (st.status === "error") toast.error(st.error || "Αποτυχία enrichment");
        else toast.success(st.message || "Ο εμπλουτισμός ολοκληρώθηκε");
        break;
      }
      await load();
      await new Promise((r) => setTimeout(r, 2500));
    }
    if (mounted.current) {
      setBusy(false);
      await load();
    }
  }

  async function runRebuild() {
    setBusy(true);
    try {
      await api.rebuildArtists();
      toast.success("Έγινε rebuild καλλιτεχνών");
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

  async function runComparison() {
    if (!capabilities.artist_enrichment) return;
    setBusy(true);
    try {
      const result = await api.compareArtists();
      toast.success("Αποθηκεύτηκε αντίγραφο · ξεκίνησε η σύγκριση");
      await load();
      await poll(result.job.id);
    } catch (e) { toast.error((e as Error).message); setBusy(false); }
  }

  async function choose(id: number, choice: string) {
    if (!capabilities.artist_enrichment) return;
    try {
      await api.chooseArtistFinding(id, choice, corrections[id]);
      await load();
      toast.success("Η επιλογή επιβεβαιώθηκε");
    } catch (e) { toast.error((e as Error).message); }
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

  const filtered = useMemo(() => {
    let data = rows;
    if (view === "unenriched") data = data.filter((row) => !row.last_enriched_at && !["unknown artist", "unknown", "various artists", "va", "misc", "downloaded by mediahuman"].includes(row.normalized_name));
    if (view === "needs_review") data = data.filter((row) => row.needs_review);
    return data;
  }, [rows, view]);

  const runQuery = (nextQ: string, nextView = view) => {
    const next: Record<string, string> = {};
    if (nextQ) next.q = nextQ;
    if (nextView) next.view = nextView;
    setParams(next);
  };

  return (
    <div className="h-full overflow-auto p-5">
      <div className="mb-4 flex items-center gap-3">
        <AudioWaveform className="h-5 w-5 text-cm-cyan" />
        <h1 className="text-lg font-semibold text-cm-text">Καλλιτέχνες</h1>
        <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-xs tabular-nums text-cm-muted">
          {filtered.length.toLocaleString("el-GR")}
        </span>
        <div className="ml-auto flex gap-2">
          {capabilities.artist_enrichment && <Button onClick={runComparison} disabled={busy} variant="outline" size="sm">Σύγκριση προφίλ</Button>}
          <Button onClick={runRebuild} disabled={busy} variant="outline" size="sm" className="gap-1.5">
            <Wrench className="h-3.5 w-3.5" />
            Rebuild
          </Button>
          {capabilities.artist_enrichment && <Button onClick={runEnrich} disabled={busy} variant="outline" size="sm" className="gap-1.5">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            Enrich
          </Button>}
        </div>
      </div>

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
            className="min-w-0 flex-1 border-none bg-transparent p-0 text-sm text-cm-text shadow-none ring-0 placeholder:text-cm-faint focus-visible:ring-0"
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
      ) : filtered.length === 0 ? (
        <EmptyState icon={Tags} title="Δεν υπάρχουν καλλιτέχνες">
          {capabilities.artist_enrichment ? "Τρέξε rebuild ή enrichment για να εμφανιστούν προφίλ." : "Πάτησε Rebuild για να δημιουργηθούν τα προφίλ από τα tracks σου."}
        </EmptyState>
      ) : (
        <div className="columns-1 gap-3 md:columns-2 xl:columns-3 2xl:columns-4">
          {filtered.map((row) => (
            <GlassPanel key={row.id} className="mb-3 inline-block w-full break-inside-avoid p-4">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-cm-text">{row.canonical_name}</div>
                  <div className="mt-1 text-xs text-cm-faint">
                    {displaySubgenre(row)} · {row.track_count.toLocaleString("el-GR")} {row.track_count === 1 ? "track" : "tracks"}
                  </div>
                </div>
                <div className="flex shrink-0 items-start gap-2 self-center md:self-start">
                  <div className="flex max-w-52 flex-wrap justify-end gap-1.5">
                    {showSceneCluster(row) && <SmartChip tone="violet">{row.scene_cluster}</SmartChip>}
                    {showConfidence(row) && <SmartChip tone="chartreuse">{row.confidence_label}</SmartChip>}
                    {row.needs_review && <SmartChip tone="amber">Θέλει έλεγχο</SmartChip>}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      navigate("/library?q=" + encodeURIComponent(`artist:"${row.canonical_name}"`))
                    }
                  >
                    Library
                  </Button>
                </div>
              </div>
              {capabilities.artist_enrichment && row.review && (
                <div className="mt-3 space-y-2 border-t border-cm-line/20 pt-3 text-xs">
                  {row.review.state === "confirmed" ? <p className="text-center text-cm-cyan">Επιβεβαιωμένο · προστατεύεται από enrichment</p> : <>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="min-w-0 space-y-2">
                        <Button className="h-auto w-full whitespace-normal" variant="outline" onClick={() => choose(row.id, "current")}>
                          Διατήρηση: {row.primary_subgenre || "—"}
                        </Button>
                        <p className="text-cm-faint">{row.scene_cluster || "—"} · {row.confidence_label || "unknown"}</p>
                        <p className="text-cm-faint">BPM {row.typical_bpm_min ?? "—"}–{row.typical_bpm_max ?? "—"} · Ενέργεια {row.energy_min ?? "—"}–{row.energy_max ?? "—"}</p>
                        <p className="text-cm-muted">{row.notes}</p>
                      </div>
                      <div className="min-w-0 space-y-2">
                        <Button className="h-auto w-full whitespace-normal" variant="outline" disabled={!row.review.candidate} onClick={() => choose(row.id, "candidate")}>
                          Νέο: {row.review.candidate?.primary_subgenre || (row.review.state === "pending" ? "Αναμονή…" : "—")}
                        </Button>
                        {row.review.candidate && <>
                          <p className="text-cm-faint">{row.review.candidate.scene_cluster || "—"} · {row.review.candidate.confidence_label || "unknown"}</p>
                          <p className="text-cm-faint">BPM {row.review.candidate.typical_bpm_min ?? "—"}–{row.review.candidate.typical_bpm_max ?? "—"} · Ενέργεια {row.review.candidate.energy_min ?? "—"}–{row.review.candidate.energy_max ?? "—"}</p>
                        </>}
                        <p className="text-cm-muted">{row.review.candidate?.notes || row.review.error}</p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Input aria-label={`Διόρθωση ${row.canonical_name}`} placeholder="Άλλο substyle…" value={corrections[row.id] || ""} onChange={e => setCorrections(v => ({...v, [row.id]: e.target.value}))} />
                      <Button variant="outline" disabled={!corrections[row.id]?.trim()} onClick={() => choose(row.id, "manual")}>Επιβεβαίωση</Button>
                    </div>
                  </>}
                </div>
              )}
            </GlassPanel>
          ))}
        </div>
      )}
    </div>
  );
}
