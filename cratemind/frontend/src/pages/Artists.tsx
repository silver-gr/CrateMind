import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../lib/api";
import type { ArtistProfile, Job } from "../lib/types";
import { parseQueryChips } from "../lib/queryChips";
import { GlassPanel } from "../components/ui/GlassPanel";
import { SectionHeader } from "../components/ui/SectionHeader";
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
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = useState<ArtistProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState(params.get("q") ?? "");
  const navigate = useNavigate();

  const view = params.get("view") ?? "";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.listArtists({ q: query || undefined, min_track_count: 1, limit: 5000 });
      setRows(data);
    } finally {
      setLoading(false);
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
    for (let i = 0; i < 600; i++) {
      st = await api.scanStatus(jobId);
      if (st && (st.status === "done" || st.status === "error")) {
        if (st.status === "error") toast.error(st.error || "Αποτυχία enrichment");
        else toast.success(st.message || "Ο εμπλουτισμός ολοκληρώθηκε");
        break;
      }
      await new Promise((r) => setTimeout(r, 700));
    }
    setBusy(false);
    load();
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
    setBusy(true);
    try {
      const job = await api.enrichArtists();
      poll(job.id);
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  }

  const filtered = useMemo(() => {
    let data = rows;
    if (view === "unenriched") data = data.filter((row) => !row.last_enriched_at);
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
          {filtered.length}
        </span>
        <div className="ml-auto flex gap-2">
          <Button onClick={runRebuild} disabled={busy} variant="outline" size="sm" className="gap-1.5">
            <Wrench className="h-3.5 w-3.5" />
            Rebuild
          </Button>
          <Button onClick={runEnrich} disabled={busy} variant="outline" size="sm" className="gap-1.5">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            Enrich
          </Button>
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
          Τρέξε rebuild ή enrichment για να εμφανιστούν προφίλ.
        </EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {filtered.map((row) => (
            <GlassPanel key={row.id} className="p-4">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-cm-text">{row.canonical_name}</div>
                  <div className="mt-1 text-xs text-cm-faint">
                    {displaySubgenre(row)} · {row.track_count} tracks
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
            </GlassPanel>
          ))}
        </div>
      )}
    </div>
  );
}
