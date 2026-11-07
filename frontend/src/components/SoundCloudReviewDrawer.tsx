import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import type { SoundCloudReviewItem, SoundCloudReviewPage } from "../lib/types";
import { Ban, CheckCircle2, Loader2, Radio, RefreshCw } from "../lib/icons";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "./ui/sheet";

const PAGE_SIZE = 30;

function formatDuration(seconds?: number | null) {
  if (seconds == null) return "μη διαθέσιμη";
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

function formatProviderDuration(milliseconds?: number | null) {
  return formatDuration(milliseconds == null ? null : milliseconds / 1000);
}

function formatDate(value?: string | null) {
  if (!value) return "μη διαθέσιμη";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("el-GR");
}

function durationDelta(localDuration?: number | null, providerDuration?: number | null) {
  if (localDuration == null || providerDuration == null) return "μη διαθέσιμη";
  const seconds = Math.abs(localDuration - providerDuration / 1000);
  return `${seconds.toFixed(seconds < 10 ? 1 : 0)} δευτ.`;
}

function ProviderIdentity({ item }: { item: SoundCloudReviewItem }) {
  const provider = item.candidate.soundcloud_track;
  return (
    <div className="min-w-0 rounded-xl border border-cm-cyan/15 bg-cm-cyan/[0.04] p-3">
      <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-cm-cyan">SoundCloud</span>
      <p className="mt-1 truncate text-sm font-medium text-cm-text">
        {provider.title || "Άτιτλο SoundCloud track"}
      </p>
      <p className="truncate text-xs text-cm-muted">
        {provider.uploader_username || "Άγνωστος uploader"}
      </p>
      {provider.permalink_url ? (
        <a
          href={provider.permalink_url}
          target="_blank"
          rel="noreferrer"
          className="mt-2 block truncate text-[11px] text-cm-cyan hover:text-cm-blue"
          title={provider.permalink_url}
        >
          {provider.permalink_url}
        </a>
      ) : (
        <p className="mt-2 text-[11px] text-cm-faint">URL μη διαθέσιμο</p>
      )}
    </div>
  );
}

function ReviewItem({
  item,
  resolving,
  onAccept,
  onReject,
}: {
  item: SoundCloudReviewItem;
  resolving: boolean;
  onAccept: () => void;
  onReject: () => void;
}) {
  const { local_track: localTrack, candidate } = item;
  const provider = candidate.soundcloud_track;
  const providerDuration = provider.full_duration_ms ?? provider.duration_ms;
  const confidence = candidate.score <= 1 ? candidate.score * 100 : candidate.score;

  return (
    <article className="space-y-3 px-5 py-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="min-w-0 rounded-xl border border-cm-contrast/10 bg-cm-contrast/[0.025] p-3">
          <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-cm-faint">Τοπικό αρχείο</span>
          <p className="mt-1 truncate text-sm font-medium text-cm-text">
            {localTrack.title || localTrack.file_name}
          </p>
          <p className="truncate text-xs text-cm-muted">{localTrack.artist || "Άγνωστος καλλιτέχνης"}</p>
          <p className="mt-2 truncate font-mono text-[11px] text-cm-faint" title={localTrack.file_name}>
            {localTrack.file_name}
          </p>
        </div>
        <ProviderIdentity item={item} />
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2 border-y border-cm-contrast/8 py-3 text-[11px]">
        <div><span className="text-cm-faint">Τοπική διάρκεια</span><p className="font-mono text-cm-text">{formatDuration(localTrack.duration)}</p></div>
        <div><span className="text-cm-faint">SoundCloud διάρκεια</span><p className="font-mono text-cm-text">{formatProviderDuration(providerDuration)}</p></div>
        <div><span className="text-cm-faint">Διαφορά</span><p className="font-mono text-cm-text">{durationDelta(localTrack.duration, providerDuration)}</p></div>
        <div><span className="text-cm-faint">Score</span><p className="font-mono text-cm-amber">{confidence.toFixed(confidence % 1 === 0 ? 0 : 1)}%</p></div>
        <div><span className="text-cm-faint">Ανέβηκε</span><p className="text-cm-text">{formatDate(provider.display_date ?? provider.created_at)}</p></div>
        <div><span className="text-cm-faint">Στο likes</span><p className="text-cm-text">{formatDate(provider.liked_at)}</p></div>
      </div>

      <div>
        <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-cm-faint">Γιατί προτάθηκε</span>
        {candidate.reasons.length ? (
          <ul className="mt-1 space-y-1 text-xs text-cm-muted">
            {candidate.reasons.map((reason) => <li key={reason}>• {reason}</li>)}
          </ul>
        ) : (
          <p className="mt-1 text-xs text-cm-faint">Δεν δόθηκαν λόγοι από τον matcher.</p>
        )}
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <Button
          onClick={onReject}
          disabled={resolving}
          variant="outline"
          size="sm"
          className="gap-1.5 border-cm-rose/25 bg-cm-rose/8 text-cm-rose hover:bg-cm-rose/15 hover:text-cm-rose"
        >
          {resolving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}
          Απόρριψη
        </Button>
        <Button
          onClick={onAccept}
          disabled={resolving}
          variant="outline"
          size="sm"
          className="gap-1.5 border-cm-chartreuse/25 bg-cm-chartreuse/10 text-cm-chartreuse hover:bg-cm-chartreuse/18 hover:text-cm-chartreuse"
        >
          {resolving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
          Αποδοχή
        </Button>
      </div>
    </article>
  );
}

export function SoundCloudReviewDrawer({
  open,
  onOpenChange,
  onReviewChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReviewChange?: () => void;
}) {
  const [page, setPage] = useState<SoundCloudReviewPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolvingKey, setResolvingKey] = useState<string | null>(null);

  const load = useCallback(async (offset = 0) => {
    setLoading(true);
    setError(null);
    try {
      setPage(await api.soundCloudReview(PAGE_SIZE, offset));
    } catch (loadError) {
      setError((loadError as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load(0);
  }, [open, load]);

  async function resolve(item: SoundCloudReviewItem, decision: "accept" | "reject") {
    const { track_id: trackId, soundcloud_track_id: soundCloudTrackId } = item.candidate;
    const key = `${trackId}:${soundCloudTrackId}`;
    setResolvingKey(key);
    try {
      if (decision === "accept") {
        await api.acceptSoundCloudCandidate(trackId, soundCloudTrackId);
        toast.success("Η αντιστοίχιση SoundCloud επιβεβαιώθηκε");
      } else {
        await api.rejectSoundCloudCandidate(trackId, soundCloudTrackId);
        toast.success("Η πρόταση SoundCloud απορρίφθηκε");
      }
      await load(page?.offset ?? 0);
      onReviewChange?.();
    } catch (resolveError) {
      toast.error((resolveError as Error).message);
    } finally {
      setResolvingKey(null);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full p-0 sm:max-w-[760px]">
        <SheetHeader className="border-b border-cm-contrast/8 px-5 py-4">
          <SheetTitle className="flex items-center gap-2 text-cm-text">
            <Radio className="h-4 w-4 text-cm-cyan" />
            Έλεγχος SoundCloud
          </SheetTitle>
          <SheetDescription className="text-xs text-cm-faint">
            Επιβεβαίωσε μόνο τη σωστή ταυτότητα. Η απόφαση δεν αλλάζει audio αρχεία ή tags.
          </SheetDescription>
        </SheetHeader>

        <div className="flex items-center justify-between border-b border-cm-contrast/8 px-5 py-2 text-[11px]">
          <span className="text-cm-muted">
            {page ? `${page.total} προτάσεις σε αναμονή` : "Φόρτωση προτάσεων…"}
          </span>
          <Button
            onClick={() => void load(page?.offset ?? 0)}
            disabled={loading}
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-[11px] text-cm-faint hover:text-cm-cyan"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
            Ανανέωση
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading && !page ? (
            <div className="flex h-48 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-cm-cyan" /></div>
          ) : error ? (
            <div className="flex h-56 flex-col items-center justify-center gap-3 px-6 text-center">
              <p className="text-sm text-cm-rose">Η φόρτωση του ελέγχου απέτυχε</p>
              <p className="text-xs text-cm-faint">{error}</p>
              <Button onClick={() => void load(page?.offset ?? 0)} variant="outline" size="sm">Δοκίμασε ξανά</Button>
            </div>
          ) : page?.items.length ? (
            <div className="divide-y divide-cm-contrast/8">
              {page.items.map((item) => {
                const key = `${item.candidate.track_id}:${item.candidate.soundcloud_track_id}`;
                return (
                  <ReviewItem
                    key={key}
                    item={item}
                    resolving={resolvingKey === key}
                    onAccept={() => void resolve(item, "accept")}
                    onReject={() => void resolve(item, "reject")}
                  />
                );
              })}
            </div>
          ) : (
            <div className="flex h-56 flex-col items-center justify-center gap-2 text-center">
              <CheckCircle2 className="h-7 w-7 text-cm-chartreuse" />
              <p className="font-medium text-cm-text">Δεν υπάρχουν προτάσεις για έλεγχο</p>
              <p className="text-xs text-cm-faint">Οι πιθανές αντιστοιχίσεις έχουν ήδη αποφασιστεί.</p>
            </div>
          )}
        </div>

        {page && page.total > page.limit && (
          <div className="flex items-center justify-between border-t border-cm-contrast/8 px-5 py-3">
            <Button
              onClick={() => void load(Math.max(0, page.offset - page.limit))}
              disabled={page.offset === 0 || loading}
              variant="outline"
              size="sm"
              className="text-xs"
            >
              Προηγούμενα
            </Button>
            <Badge variant="outline" className="font-mono text-[10px] tabular-nums text-cm-faint">
              {page.offset + 1}–{Math.min(page.offset + page.limit, page.total)}
            </Badge>
            <Button
              onClick={() => void load(page.offset + page.limit)}
              disabled={page.offset + page.limit >= page.total || loading}
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
  );
}

export default SoundCloudReviewDrawer;
