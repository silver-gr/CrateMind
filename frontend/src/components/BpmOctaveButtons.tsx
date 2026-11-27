import { useRef, useState, type MouseEvent } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { bpmChangeText, bpmFieldsOf, createOctaveController, notifyBpmUpdated, undoPlan, type BpmFactor } from "../lib/bpmUpdates";
import { cn } from "../lib/cn";
import { Hint } from "./ui/tooltip";
import { apiMessage } from "../lib/facets";
import { RotateCcw } from "../lib/icons";
import { effectiveBpm } from "../lib/tempo";
import type { BpmUpdate, Track } from "../lib/types";

const SAFE = "Αποθηκεύεται μόνο στο CrateMind, όχι στα tags ή στο djay";
type Action = BpmFactor | "reset";
type Request = { trackId: number; name: string; before: number | null; source: string | null; action: Action };

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

function requestFor(track: Track, action: Action): Request {
  const name = `${track.artist ? `${track.artist} – ` : ""}${track.title || track.file_name}`;
  return { trackId: track.id, name, before: effectiveBpm(track), source: track.bpm_consensus_sources ?? null, action };
}

/** Publishes a finished change and toasts it, with «Αναίρεση» for ×½ / ×2. */
function announce(result: BpmUpdate, request: Request) {
  const reset = request.action === "reset";
  publish(result);
  toast(bpmChangeText(request.action, request.before, result.effective_bpm), {
    description: (
      <>
        <span className="block truncate text-cm-text/80">{request.name}</span>
        <span className="block">{reset ? "Ισχύει ξανά το αυτόματο BPM." : "Αποθηκεύτηκε μόνο στο CrateMind, όχι στα tags ή στο djay."}</span>
      </>
    ),
    action: reset ? undefined : { label: "Αναίρεση", onClick: () => undo(request) },
  });
}

/** The buttons' change for one press elsewhere (the track menu): same request, toast and «Αναίρεση». */
export function changeBpm(track: Track, action: Action, onDone?: () => void): void {
  const request = requestFor(track, action);
  send(request).then(result => announce(result, request)).then(() => onDone?.(), error => { toast.error(apiMessage(error)); });
}

/** «×½ / ×2» and «Επαναφορά BPM» for one track: deck, «Ουρά tagging» and the Library card. */
export function BpmOctaveButtons({ track, compact = false }: { track: Track; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const halfRef = useRef<HTMLButtonElement>(null);
  const resetRef = useRef<HTMLButtonElement>(null);
  const [controller] = useState(() => createOctaveController<Request>({
    send,
    onDone: (result, request) => {
      setBusy(false);
      // The reset button unmounts once the BPM is automatic again; keep the keyboard focus nearby.
      if (request.action === "reset" && document.activeElement === resetRef.current) halfRef.current?.focus();
      announce(result, request);
    },
    onError: error => {
      setBusy(false);
      toast.error(apiMessage(error));
    },
  }));
  const bpm = effectiveBpm(track);
  const manual = !!track.bpm_consensus_sources?.startsWith("manual:");
  const trigger = (action: Action, event: MouseEvent) => {
    if (busy || event.detail > 1) return; // in flight, or the second click of a double click
    if (controller.trigger(requestFor(track, action))) setBusy(true);
  };
  const button = cn(
    "inline-flex cursor-pointer items-center justify-center rounded-md border border-cm-contrast/10 bg-cm-contrast/5 font-mono text-cm-muted transition",
    "hover:border-cm-cyan/40 hover:text-cm-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-cyan disabled:cursor-default disabled:opacity-40 aria-disabled:cursor-default aria-disabled:opacity-40",
    compact ? "h-5 min-w-5 px-1 text-[10px]" : "h-6 min-w-7 px-1.5 text-xs",
  );
  // In flight: aria-disabled, not `disabled`, which would drop the keyboard focus from the pressed button.
  const inFlight = busy || undefined;
  return (
    <span className="inline-flex items-center gap-1">
      <Hint text={SAFE}><button ref={halfRef} type="button" className={button} disabled={bpm == null} aria-disabled={inFlight} onClick={e => trigger(0.5, e)} aria-label="Μισό BPM">×½</button></Hint>
      <Hint text={SAFE}><button type="button" className={button} disabled={bpm == null} aria-disabled={inFlight} onClick={e => trigger(2, e)} aria-label="Διπλό BPM">×2</button></Hint>
      {manual && (
        <Hint text={`Επιστροφή στο αυτόματο BPM. ${SAFE}`}>
          <button ref={resetRef} type="button" className={button} aria-disabled={inFlight} onClick={e => trigger("reset", e)} aria-label="Επαναφορά BPM">
            {compact ? <RotateCcw aria-hidden="true" className="size-3" /> : "Επαναφορά BPM"}
          </button>
        </Hint>
      )}
    </span>
  );
}
