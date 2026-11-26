import { useCallback, useEffect, useState } from "react";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { TASK_RESULT_TOAST, translateDuplicateReason, translateJobError, translateJobMessage } from "../lib/labels";
import type { DuplicateGroup, Job, MovedPair, MovedTrack, MovedTracks } from "../lib/types";
import { keeperReasonLabel, loadDeclined, openPairs, pairKey, saveDeclined } from "../lib/relink";
import { GlassPanel } from "../components/ui/GlassPanel";
import { SectionHeader } from "../components/ui/SectionHeader";
import { PageHeader } from "../components/ui/PageHeader";
import { EmptyState } from "../components/ui/EmptyState";
import { Button } from "@/components/ui/button";
import { ActionContextMenu } from "../components/ui/context-menu";
import { useTrackMenu, type TrackMenuSubject } from "../lib/menus/useTrackMenu";
import { Boxes, CheckCircle2, Ban, Loader2, Crosshair } from "../lib/icons";

function fmtDur(s?: number | null) {
  if (!s) return "--:--";
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
}

function MovedRow({ label, track }: { label: string; track: MovedTrack }) {
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <span className="w-24 shrink-0 text-[11px] uppercase tracking-wide text-cm-faint">{label}</span>
        <span className="truncate text-sm text-cm-text">
          <span className="text-cm-muted">{track.artist}</span>
          {track.artist && track.title ? " — " : ""}
          {track.title}
        </span>
        <span className="font-mono text-xs tabular-nums text-cm-muted">{fmtDur(track.duration)}</span>
        <span className="font-mono text-[11px] uppercase tracking-wide text-cm-faint">{track.extension}</span>
      </div>
      <div className="truncate font-mono text-[11px] text-cm-faint" title={track.absolute_path}>
        {track.absolute_path}
      </div>
    </div>
  );
}

/** «Μετακινημένα κομμάτια»: missing tracks with the user's work, beside the file found with the same audio.
 *  Nothing is merged until the user confirms a pair (or all shown); the files are never touched. */
function MovedTracksSection({ moved, reload }: { moved: MovedTracks; reload: () => void }) {
  const [declined, setDeclined] = useState(loadDeclined);
  const [merging, setMerging] = useState(false);
  const pairs = openPairs(moved.pairs, declined);
  const hiddenCount = moved.pairs.length - pairs.length;
  const count = (n: number) => n.toLocaleString("el-GR");

  function setAnswers(next: string[]) {
    setDeclined(next);
    saveDeclined(next);
  }

  async function confirm(chosen: MovedPair[]) {
    setMerging(true);
    try {
      const done = await api.mergeMovedTracks(chosen.map(p => ({ old_id: p.old.track_id, new_id: p.new.track_id })));
      if (done.merged > 0) {
        toast.success(done.merged === 1 ? "Τα δεδομένα πέρασαν στο νέο αρχείο" : `Τα δεδομένα πέρασαν σε ${count(done.merged)} νέα αρχεία`);
      }
      if (done.skipped > 0) {
        toast.warning(done.skipped === 1 ? "1 ζευγάρι δεν ισχύει πια και έμεινε όπως ήταν" : `${count(done.skipped)} ζευγάρια δεν ισχύουν πια και έμειναν όπως ήταν`);
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setMerging(false);
      reload();
    }
  }

  if (moved.missing_with_data === 0) return null;
  return (
    <GlassPanel className="mb-4 p-4">
      <SectionHeader>Μετακινημένα κομμάτια</SectionHeader>
      <p className="mb-3 text-xs text-cm-muted">
        Tracks που λείπουν και έχουν δικά σου δεδομένα (προφίλ, tags, cues, sets, σημειώσεις, ιστορικό), δίπλα στο αρχείο που
        βρέθηκε με τον ίδιο ήχο και την ίδια διάρκεια. Αν επιβεβαιώσεις ένα ζευγάρι, τα δεδομένα περνούν στο νέο αρχείο και η
        παλιά εγγραφή φεύγει από τη βιβλιοθήκη. Τίποτα δεν γίνεται αυτόματα και τα αρχεία δεν αλλάζουν.
      </p>
      {pairs.length === 0 ? (
        <p className="text-xs text-cm-muted">
          Δεν υπάρχει ζευγάρι για έλεγχο. {count(moved.missing_with_data)} tracks που λείπουν έχουν δικά σου δεδομένα.
          Αν μόλις έκανες σάρωση, τρέξε «Fingerprint» στις Ρυθμίσεις, για να ελεγχθούν και τα νέα αρχεία.
        </p>
      ) : (
        <div className="space-y-1.5">
          {pairs.map(pair => (
            <div
              key={pairKey(pair)}
              className="grid grid-cols-[1fr_auto] items-center gap-x-4 rounded-xl border border-cm-contrast/8 bg-cm-contrast/[0.02] px-3 py-2"
            >
              <div className="min-w-0 space-y-1.5">
                <MovedRow label="Παλιό (λείπει)" track={pair.old} />
                <MovedRow label="Νέο αρχείο" track={pair.new} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Button
                  onClick={() => confirm([pair])}
                  disabled={merging}
                  variant="outline"
                  size="sm"
                  className="h-auto gap-1.5 border-cm-chartreuse/25 bg-cm-chartreuse/12 px-2.5 py-1 text-xs font-medium text-cm-chartreuse hover:bg-cm-chartreuse/20 hover:text-cm-chartreuse"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Είναι το ίδιο
                </Button>
                <Button
                  onClick={() => setAnswers([...declined, pairKey(pair)])}
                  disabled={merging}
                  variant="outline"
                  size="sm"
                  className="h-auto gap-1.5 border-cm-contrast/10 bg-cm-contrast/5 px-2.5 py-1 text-xs font-medium text-cm-muted hover:bg-cm-contrast/10 hover:text-cm-muted"
                >
                  <Ban className="h-3.5 w-3.5" />
                  Όχι
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-cm-muted">
        {pairs.length > 1 && (
          <Button onClick={() => confirm(pairs)} disabled={merging} variant="outline" size="sm" className="h-auto px-2.5 py-1 text-xs">
            {merging ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            Επιβεβαίωση και των {count(pairs.length)}
          </Button>
        )}
        {hiddenCount > 0 && (
          <Button onClick={() => setAnswers([])} variant="link" size="sm" className="h-auto p-0 text-xs text-cm-muted">
            Εμφάνιση όσων απέρριψα ({count(hiddenCount)})
          </Button>
        )}
        {moved.not_checked > 0 && (
          <span>Δεν ελέγχθηκαν {count(moved.not_checked)} tracks που λείπουν, γιατί δεν έχουν fingerprint ή διάρκεια.</span>
        )}
        {moved.ambiguous > 0 && (
          <span>{count(moved.ambiguous)} tracks έχουν πάνω από ένα πιθανό νέο αρχείο και δεν προτείνονται.</span>
        )}
      </div>
    </GlassPanel>
  );
}

export default function Duplicates() {
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [moved, setMoved] = useState<MovedTracks | null>(null);
  const [scanning, setScanning] = useState(false);
  const [animateRef] = useAutoAnimate<HTMLDivElement>();

  const load = useCallback(async () => {
    const [found, movedTracks] = await Promise.allSettled([api.listDuplicates(), api.listMovedTracks()]);
    if (found.status === "fulfilled") setGroups(found.value);
    if (movedTracks.status === "fulfilled") setMoved(movedTracks.value);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function runScan() {
    setScanning(true);
    toast.info("Έλεγχος για διπλότυπα…");
    const job = await api.startDuplicateScan();
    let st: Job | null = job;
    for (let i = 0; i < 120 && st && st.status !== "done" && st.status !== "error"; i++) {
      await new Promise((r) => setTimeout(r, 500));
      st = await api.scanStatus(job.id);
    }
    if (st?.status === "error") toast.error(translateJobError(st?.error, "Ο έλεγχος διπλοτύπων απέτυχε"), TASK_RESULT_TOAST);
    else toast.success(st?.message ? translateJobMessage(st.message) : "Ο έλεγχος διπλοτύπων ολοκληρώθηκε", TASK_RESULT_TOAST);
    setScanning(false);
    load();
  }

  async function resolve(g: DuplicateGroup, masterId: number | null, status: string) {
    await api.resolveDuplicate(g.id, {
      status,
      master_track_id: masterId ?? undefined,
    });
    load();
  }

  // A group's track: the track menu (loaded on open), then «master + επίλυση» as its button.
  const { menu: trackMenu, dialogs: trackMenuDialogs } = useTrackMenu({});
  function pickTrack(row: HTMLElement): TrackMenuSubject | null {
    const group = groups.find(g => g.id === Number(row.dataset.groupId));
    const id = Number(row.dataset.trackId);
    return group ? {
      kind: "ref",
      id,
      placeItems: [{ type: "item", icon: CheckCircle2, label: "Ορισμός ως master και επίλυση", onSelect: () => void resolve(group, id, "resolved") }],
    } : null;
  }

  return (
    <div className="flex h-full flex-col">
      {trackMenuDialogs}
      <PageHeader
        icon={Boxes}
        title="Έλεγχος διπλοτύπων"
        count={`${groups.length.toLocaleString("el-GR")} ομάδες`}
        subtitle="Τα αρχεία δεν διαγράφονται ούτε μετακινούνται. Διάλεξε master copy και σημείωσε την ομάδα ως λυμένη — το CrateMind καταγράφει μόνο την απόφαση."
        actions={
          <Button onClick={runScan} disabled={scanning} variant="soft" size="sm">
            {scanning ? <Loader2 className="animate-spin" /> : <Crosshair />}
            {scanning ? "Scan…" : "Εντοπισμός"}
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto p-5 scroll-fade-y">
        {moved && <MovedTracksSection moved={moved} reload={load} />}
        {groups.length === 0 ? (
          <EmptyState icon={Boxes} title="Δεν υπάρχουν ομάδες διπλοτύπων">
            Τρέξε εντοπισμό για scan της βιβλιοθήκης.
          </EmptyState>
        ) : (
          <ActionContextMenu menu={trackMenu} rowSelector="[data-track-id]" pick={pickTrack}>
          <div className="space-y-4" ref={animateRef}>
            {groups.map((g) => (
              <GlassPanel key={g.id} className="p-4">
                <SectionHeader>{g.reason ? translateDuplicateReason(g.reason) : "Πιθανό διπλότυπο"}</SectionHeader>
                <div className="space-y-1.5">
                  {g.tracks.map((t) => (
                    <div
                      key={t.track_id}
                      data-track-id={t.track_id}
                      data-group-id={g.id}
                      className="grid grid-cols-[1fr_auto] items-center gap-x-4 rounded-xl border border-cm-contrast/8 bg-cm-contrast/[0.02] px-3 py-2"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                          <span className="truncate text-sm text-cm-text">
                            <span className="text-cm-muted">{t.artist}</span>
                            {t.artist && t.title ? " — " : ""}
                            {t.title}
                          </span>
                          <span className="font-mono text-xs tabular-nums text-cm-muted">{fmtDur(t.duration)}</span>
                          {t.bpm ? (
                            <span className="font-mono text-xs tabular-nums text-cm-cyan">{t.bpm.toFixed(0)} BPM</span>
                          ) : null}
                          <span className="font-mono text-[11px] uppercase tracking-wide text-cm-faint">{t.extension}</span>
                          {g.suggested_keep?.track_id === t.track_id && (
                            <span className="rounded-full border border-cm-cyan/25 bg-cm-cyan/10 px-2 py-0.5 text-[11px] text-cm-cyan">
                              Προτεινόμενο για κράτημα
                              {keeperReasonLabel(g.suggested_keep.reason) ? `: ${keeperReasonLabel(g.suggested_keep.reason)}` : ""}
                            </span>
                          )}
                        </div>
                        <div className="truncate font-mono text-[11px] text-cm-faint" title={t.absolute_path}>
                          {t.absolute_path}
                        </div>
                      </div>
                      <Button
                        onClick={() => resolve(g, t.track_id, "resolved")}
                        variant="outline"
                        size="sm"
                        className="h-auto gap-1.5 border-cm-chartreuse/25 bg-cm-chartreuse/12 px-2.5 py-1 text-xs font-medium text-cm-chartreuse hover:bg-cm-chartreuse/20 hover:text-cm-chartreuse"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        master + επίλυση
                      </Button>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex">
                  <Button
                    onClick={() => resolve(g, null, "ignored")}
                    variant="outline"
                    size="sm"
                    className="h-auto gap-1.5 border-cm-contrast/10 bg-cm-contrast/5 px-2.5 py-1 text-xs font-medium text-cm-muted hover:bg-cm-contrast/10 hover:text-cm-muted"
                  >
                    <Ban className="h-3.5 w-3.5" />
                    Δεν είναι διπλότυπο (αγνόηση)
                  </Button>
                </div>
              </GlassPanel>
            ))}
          </div>
          </ActionContextMenu>
        )}
      </div>
    </div>
  );
}
