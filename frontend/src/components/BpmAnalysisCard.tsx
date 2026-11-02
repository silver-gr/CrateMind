import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import type {
  BpmAnalysisSummary,
  BpmCandidate,
  BpmReviewPage,
  Job,
} from "../lib/types";
import { cn } from "../lib/cn";
import { GlassPanel } from "./ui/GlassPanel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  AudioWaveform,
  CheckCircle2,
  CircleDot,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from "../lib/icons";

const sourceLabels: Record<BpmCandidate["source"], string> = {
  metadata: "Tag / filename",
  local: "Τοπική ανάλυση",
  essentia: "Essentia",
  reccobeats: "ReccoBeats",
  getsongbpm: "GetSongBPM",
  cyanite: "Cyanite",
};

function metric(value: number | undefined) {
  return new Intl.NumberFormat("el-GR").format(value ?? 0);
}

function bpm(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

interface Props {
  job: Job | null;
  busy: boolean;
  canAnalyze: boolean;
  onRunAnalyze: () => void;
}

export function BpmAnalysisCard({ job, busy, canAnalyze, onRunAnalyze }: Props) {
  const [summary, setSummary] = useState<BpmAnalysisSummary | null>(null);
  const [review, setReview] = useState<BpmReviewPage | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resolvingId, setResolvingId] = useState<number | null>(null);

  const loadSummary = useCallback(async () => {
    try {
      setSummary(await api.bpmAnalysisSummary());
    } catch {
      setSummary(null);
    }
  }, []);

  const loadReview = useCallback(async (offset = 0) => {
    setLoading(true);
    try {
      setReview(await api.bpmReview("conflicts", 40, offset));
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSummary();
  }, [loadSummary, job?.id, job?.status]);

  async function openReview() {
    setDrawerOpen(true);
    await loadReview(0);
  }

  async function recompute() {
    setLoading(true);
    try {
      const next = await api.recomputeBpmConsensus();
      setSummary(next);
      toast.success(`Επανυπολογίστηκε consensus για ${metric(next.total)} tracks`);
      if (drawerOpen) await loadReview(0);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function retryFailures() {
    setLoading(true);
    try {
      const result = await api.retryBpmFailures();
      toast.success(
        result.reccobeats_reset
          ? `${result.reccobeats_reset} αποτυχίες ReccoBeats είναι έτοιμες για retry`
          : "Δεν υπάρχουν αποτυχίες ReccoBeats",
      );
      await loadSummary();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function choose(trackId: number, source: BpmCandidate["source"]) {
    setResolvingId(trackId);
    try {
      await api.resolveBpm(trackId, source);
      setReview((current) =>
        current
          ? {
              ...current,
              total: Math.max(0, current.total - 1),
              items: current.items.filter((item) => item.id !== trackId),
            }
          : current,
      );
      await loadSummary();
      toast.success("Η επιλογή BPM αποθηκεύτηκε");
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setResolvingId(null);
    }
  }

  const analysisJob = job?.kind === "analyze" ? job : null;
  const running = analysisJob?.status === "running";
  const progress =
    running && analysisJob.total
      ? Math.min(100, Math.round((analysisJob.processed / analysisJob.total) * 100))
      : 0;

  return (
    <>
      <GlassPanel className="col-span-3 overflow-hidden p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/8 px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-cm-cyan/20 bg-cm-cyan/10">
              <AudioWaveform className="h-4 w-4 text-cm-cyan" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-semibold text-cm-text">Ανάλυση BPM</h2>
                <Badge
                  variant="outline"
                  className="border-cm-chartreuse/20 bg-cm-chartreuse/8 text-[10px] text-cm-chartreuse"
                >
                  Πρώτα τα metadata
                </Badge>
              </div>
              <p className="text-[11px] text-cm-faint">
                Consensus με προέλευση, conflicts και χειροκίνητη επιλογή.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              onClick={openReview}
              disabled={loading || !summary?.actionable_conflicts}
              variant="outline"
              size="sm"
              className="gap-1.5 border-cm-amber/25 bg-cm-amber/10 text-xs text-cm-amber hover:bg-cm-amber/18 hover:text-cm-amber"
            >
              <TriangleAlert className="h-3.5 w-3.5" />
              Έλεγχος διαφορών
            </Button>
            <Button
              onClick={recompute}
              disabled={loading || running}
              variant="outline"
              size="sm"
              className="gap-1.5 border-cm-chartreuse/25 bg-cm-chartreuse/10 text-xs text-cm-chartreuse hover:bg-cm-chartreuse/18 hover:text-cm-chartreuse"
            >
              {loading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Recompute consensus
            </Button>
            <Button
              onClick={onRunAnalyze}
              disabled={busy || running || !canAnalyze}
              variant="outline"
              size="sm"
              className="gap-1.5 border-cm-violet/25 bg-cm-violet/12 text-xs text-cm-violet hover:bg-cm-violet/20 hover:text-cm-violet"
            >
              {running ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <AudioWaveform className="h-3.5 w-3.5" />
              )}
              {running ? `${progress}%` : "Ανάλυση BPM + Key"}
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-[190px_1fr_260px] divide-x divide-white/8">
          <div className="flex flex-col justify-center px-4 py-4">
            <span className="text-[10px] uppercase tracking-[0.14em] text-cm-faint">
              Για έλεγχο
            </span>
            <strong className="mt-1 font-mono text-3xl font-semibold tabular-nums text-cm-amber">
              {metric(summary?.actionable_conflicts)}
            </strong>
            <span className="mt-1 text-[11px] text-cm-muted">
              {summary?.manual_resolutions
                ? `${metric(summary.manual_resolutions)} χειροκίνητες επιλογές`
                : "Καμία χειροκίνητη επιλογή"}
            </span>
          </div>

          <div className="grid grid-cols-4 gap-px bg-white/6">
            {[
              ["Έμπιστα metadata", summary?.trusted_metadata, "text-cm-chartreuse"],
              ["Consensus", summary?.consensus, "text-cm-cyan"],
              ["Τοπική ανάλυση", summary?.local_analyzed, "text-cm-violet"],
              ["Διαφωνίες παρόχων", summary?.provider_disagreements, "text-cm-amber"],
            ].map(([label, value, tone]) => (
              <div key={String(label)} className="bg-cm-panel/75 px-4 py-4">
                <div className={cn("font-mono text-xl font-semibold tabular-nums", tone)}>
                  {metric(value as number | undefined)}
                </div>
                <div className="mt-1 text-[10px] uppercase tracking-wider text-cm-faint">
                  {label}
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-2 px-4 py-3 text-[11px]">
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-1.5 text-cm-muted">
                <CheckCircle2 className="h-3.5 w-3.5 text-cm-cyan" />
                ReccoBeats
              </span>
              <span className="font-mono tabular-nums text-cm-text">
                {metric(summary?.reccobeats_analyzed)}
                {summary?.reccobeats_failed ? (
                  <span className="ml-1 text-cm-rose">
                    / {summary.reccobeats_failed} fail
                  </span>
                ) : null}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-1.5 text-cm-muted">
                <CircleDot className="h-3.5 w-3.5 text-cm-faint" />
                GetSongBPM
              </span>
              <span className="font-mono tabular-nums text-cm-faint">
                {metric(summary?.getsongbpm_matches)} matches · bulk off
              </span>
            </div>
            <Button
              onClick={retryFailures}
              disabled={loading || !summary?.reccobeats_failed}
              variant="ghost"
              size="sm"
              className="h-7 w-full justify-start gap-1.5 px-0 text-[11px] text-cm-faint hover:bg-transparent hover:text-cm-cyan"
            >
              <RefreshCw className="h-3 w-3" />
              Retry provider failures
            </Button>
          </div>
        </div>

        {running && (
          <div className="h-1 bg-white/5">
            <div
              className="h-full bg-cm-cyan transition-[width] duration-200"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}
      </GlassPanel>

      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent className="w-full p-0 sm:max-w-[760px]">
          <SheetHeader className="border-b border-white/8 px-5 py-4">
            <SheetTitle className="text-cm-text">Έλεγχος διαφωνιών BPM</SheetTitle>
            <SheetDescription className="text-xs text-cm-faint">
              Διάλεξε ανακαλυφθέν BPM. Η επιλογή αποθηκεύεται ως manual consensus χωρίς
              αλλαγή στο audio file ή στα embedded tags.
            </SheetDescription>
          </SheetHeader>

          <div className="flex items-center justify-between border-b border-white/8 px-5 py-2 text-[11px]">
            <span className="text-cm-muted">
              {metric(review?.total)} ανοιχτές διαφορές
            </span>
            <Button
              onClick={() => loadReview(review?.offset ?? 0)}
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-[11px] text-cm-faint hover:text-cm-cyan"
            >
              <RefreshCw className="h-3 w-3" />
              Ανανέωση
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading && !review ? (
              <div className="flex h-48 items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-cm-cyan" />
              </div>
            ) : review?.items.length ? (
              <div className="divide-y divide-white/8">
                {review.items.map((track) => (
                  <article key={track.id} className="px-5 py-4">
                    <div className="mb-3 flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <h3 className="truncate text-sm font-medium text-cm-text">
                          {track.artist || "Άγνωστος καλλιτέχνης"}
                        </h3>
                        <p className="truncate text-xs text-cm-muted">
                          {track.title || track.file_name}
                        </p>
                      </div>
                      {track.disagreement_percent != null && (
                        <Badge
                          variant="outline"
                          className="shrink-0 border-cm-amber/20 text-[10px] tabular-nums text-cm-amber"
                        >
                          Δ {track.disagreement_percent.toFixed(1)}%
                        </Badge>
                      )}
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {track.candidates.map((candidate) => (
                        <Button
                          key={candidate.source}
                          onClick={() => choose(track.id, candidate.source)}
                          disabled={resolvingId === track.id}
                          variant="outline"
                          size="sm"
                          className={cn(
                            "h-auto min-w-[118px] justify-between gap-3 px-3 py-2 text-left",
                            candidate.trusted
                              ? "border-cm-chartreuse/30 bg-cm-chartreuse/10 text-cm-chartreuse hover:bg-cm-chartreuse/18 hover:text-cm-chartreuse"
                              : "border-white/10 bg-white/4 text-cm-muted hover:border-cm-cyan/30 hover:bg-cm-cyan/8 hover:text-cm-cyan",
                          )}
                        >
                          <span>
                            <span className="block text-[10px] opacity-70">
                              {sourceLabels[candidate.source]}
                            </span>
                            <span className="font-mono text-sm font-semibold tabular-nums">
                              {bpm(candidate.value)}
                            </span>
                          </span>
                          {candidate.trusted && (
                            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                          )}
                        </Button>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="flex h-56 flex-col items-center justify-center gap-2 text-center">
                <CheckCircle2 className="h-7 w-7 text-cm-chartreuse" />
                <p className="font-medium text-cm-text">Δεν υπάρχουν ανοιχτές διαφορές</p>
                <p className="text-xs text-cm-faint">Όλα έχουν consensus ή manual επιλογή.</p>
              </div>
            )}
          </div>

          {review && review.total > review.limit && (
            <div className="flex items-center justify-between border-t border-white/8 px-5 py-3">
              <Button
                onClick={() => loadReview(Math.max(0, review.offset - review.limit))}
                disabled={review.offset === 0 || loading}
                variant="outline"
                size="sm"
                className="text-xs"
              >
                Προηγούμενα
              </Button>
              <span className="font-mono text-[10px] tabular-nums text-cm-faint">
                {review.offset + 1}–{Math.min(review.offset + review.limit, review.total)}
              </span>
              <Button
                onClick={() => loadReview(review.offset + review.limit)}
                disabled={review.offset + review.limit >= review.total || loading}
                variant="outline"
                size="sm"
                className="text-xs"
              >
                Επόμενα
              </Button>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
