import { useState, type MouseEvent } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { bpmChangeText, bpmFieldsOf, createOctaveController, notifyBpmUpdated, undoPlan, type BpmFactor } from "../lib/bpmUpdates";
import { cn } from "../lib/cn";
import { apiMessage } from "../lib/facets";
import { RotateCcw } from "../lib/icons";
import { effectiveBpm } from "../lib/tempo";
import type { BpmUpdate, Track } from "../lib/types";

const SAFE = "Αποθηκεύεται μόνο στο CrateMind, όχι στα tags ή στο djay";
type Action = BpmFactor | "reset";
type Request = { trackId: number; before: number | null; source: string | null; action: Action };

const send = ({ trackId, action }: Pick<Request, "trackId" | "action">): Promise<BpmUpdate> =>
  action === "reset" ? api.resetBpm(trackId) : api.setBpmOctave(trackId, action);

function publish(result: BpmUpdate) {
  notifyBpmUpdated(result.track_id, bpmFieldsOf(result));
}

/** Toast «Αναίρεση»: the inverse factor for a manual old value, else a reset. It works after the buttons unmount. */
function undo(request: Request) {
  if (request.action === "reset") return;
  const plan = undoPlan(request.source, request.action);
  send({ trackId: request.trackId, action: plan.kind === "reset" ? "reset" : plan.factor })
    .then(publish, error => { toast.error(apiMessage(error)); });
}

/** «×½ / ×2» and «Επαναφορά BPM» for one track: deck, «Ουρά tagging» and the Library card. */
export function BpmOctaveButtons({ track, compact = false }: { track: Track; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [controller] = useState(() => createOctaveController<Request>({
    send,
    onDone: (result, request) => {
      setBusy(false);
      publish(result);
      toast(bpmChangeText(request.before, result.effective_bpm), request.action === "reset" ? undefined : {
        action: { label: "Αναίρεση", onClick: () => undo(request) },
      });
    },
    onError: error => {
      setBusy(false);
      toast.error(apiMessage(error));
    },
  }));
  const bpm = effectiveBpm(track);
  const manual = !!track.bpm_consensus_sources?.startsWith("manual:");
  const trigger = (action: Action, event: MouseEvent) => {
    if (event.detail > 1) return; // the second click of a double click
    const request = { trackId: track.id, before: bpm, source: track.bpm_consensus_sources ?? null, action };
    if (controller.trigger(request)) setBusy(true);
  };
  const button = cn(
    "inline-flex cursor-pointer items-center justify-center rounded-md border border-cm-line/20 dark:border-white/10 bg-white/5 font-mono text-cm-muted transition",
    "hover:border-cm-cyan/40 hover:text-cm-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-cyan disabled:cursor-default disabled:opacity-40",
    compact ? "h-5 min-w-5 px-1 text-[10px]" : "h-6 min-w-7 px-1.5 text-xs",
  );
  return (
    <span className="inline-flex items-center gap-1">
      <button type="button" className={button} disabled={busy || bpm == null} onClick={e => trigger(0.5, e)} aria-label="Μισό BPM" title={SAFE}>×½</button>
      <button type="button" className={button} disabled={busy || bpm == null} onClick={e => trigger(2, e)} aria-label="Διπλό BPM" title={SAFE}>×2</button>
      {manual && (
        <button type="button" className={button} disabled={busy} onClick={e => trigger("reset", e)} aria-label="Επαναφορά BPM"
          title={`Επιστροφή στο αυτόματο BPM. ${SAFE}`}>
          {compact ? <RotateCcw aria-hidden="true" className="size-3" /> : "Επαναφορά BPM"}
        </button>
      )}
    </span>
  );
}
