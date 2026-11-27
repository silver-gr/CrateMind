import { useRef, type MouseEvent, type PointerEvent } from "react";
import { CLIP_ADVICE, pressStop, startRecording, useRecording, type RecordingState } from "../lib/recorder";
import { Hint } from "./ui/tooltip";
import { formatElapsed } from "../lib/recordingCore";
import { unlockPlaybackAudio } from "../lib/playbackAudio";
import { useTwoDeck } from "../lib/player";
import { usePref } from "../lib/prefs";
import { cn } from "../lib/cn";

const FORMAT_LABELS = { wav: "WAV", aac256: "AAC 256 kbps", aac128: "AAC 128 kbps" } as const;

const dot = (live: boolean) => <span aria-hidden className={`size-1.5 shrink-0 rounded-full bg-cm-rose ${live ? "motion-safe:animate-pulse" : "opacity-70"}`} />;

function stopLabel(state: RecordingState) {
  if (state.status === "stopping") return "Αποθήκευση…";
  return state.status === "on" && state.armed ? "Πάτα ξανά για διακοπή" : "Διακοπή εγγραφής";
}

function startLabel(state: RecordingState, format: keyof typeof FORMAT_LABELS) {
  return state.status === "starting" ? "Η εγγραφή ξεκινά…"
    : `Εγγραφή set (${FORMAT_LABELS[format] ?? "WAV"} στον φάκελο export· η μορφή αλλάζει στις Ρυθμίσεις)`;
}

function start(twoDeck: boolean) {
  void unlockPlaybackAudio();
  void startRecording({ twoDeck });
}

/** A press that moved this far before the release was a drag, not a click. */
const DRAG_SLOP_PX = 4;

/** Clicks that did not start as a drag: a short drag that starts on the control does nothing. */
function useStillClick(action: () => void) {
  const down = useRef<{ x: number; y: number } | null>(null);
  return {
    onPointerDown: (e: PointerEvent) => { down.current = { x: e.clientX, y: e.clientY }; },
    onClick: (e: MouseEvent) => {
      const from = down.current;
      down.current = null;
      if (from && e.detail > 0 && Math.hypot(e.clientX - from.x, e.clientY - from.y) > DRAG_SLOP_PX) return;
      action();
    },
  };
}

export const barChip = "pointer-events-auto flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-cm-line/20 px-2 text-[11px] font-semibold text-cm-muted transition dark:border-white/10 focus-visible:outline-2 focus-visible:outline-cm-cyan";

/**
 * REC in the top bar, right of the meter. Idle: «● REC». Recording: «● REC 12:04», amber «· ψαλίδισμα» on clipping and
 * «Διακοπή» (then «Σίγουρα;», then «Αποθήκευση…»), at a fixed 228 px so the stop button never moves between two presses; it
 * grows to the right, so the meter never moves. Dim while a single deck plays outside the master bus: a press refuses.
 */
export function TopBarRecord({ outside }: { outside: boolean }) {
  const state = useRecording();
  const [format] = usePref("recordingFormat");
  const twoDeck = useTwoDeck();
  const live = state.status === "on" || state.status === "stopping";
  const startClick = useStillClick(() => start(twoDeck));
  const stopClick = useStillClick(pressStop);
  if (!live) {
    const label = outside ? "Εγγραφή set: δεν ξεκινά όσο το κομμάτι παίζει εκτός master" : startLabel(state, format);
    return (
      <button type="button" aria-label={label} title={label} disabled={state.status === "starting"} {...startClick}
        className={cn(barChip, "font-bold tracking-wider hover:text-cm-text disabled:opacity-60", outside && "opacity-45")}>
        {dot(false)}REC
      </button>
    );
  }
  const label = stopLabel(state);
  return (
    <div role="status" aria-live="off"
      className={cn(barChip, "pointer-events-none w-[228px] border-cm-rose/60 bg-cm-rose/10 pr-0.5 font-bold text-cm-rose tabular-nums shadow-[0_0_8px_-3px_var(--color-cm-rose)] dark:border-cm-rose/60")}>
      {dot(true)}
      <span className="whitespace-nowrap tracking-wider">REC {formatElapsed(state.seconds)}</span>
      {state.clipped > 0 && (
        <Hint side="bottom" text={`Κάποια σημεία ψαλιδίστηκαν· ${CLIP_ADVICE}`}>
          <span className="pointer-events-auto whitespace-nowrap font-semibold text-cm-amber">· ψαλίδισμα</span>
        </Hint>
      )}
      <button type="button" disabled={state.status === "stopping"} aria-label={label} title={label} {...stopClick}
        className={cn("pointer-events-auto ml-auto flex h-[18px] w-[4.5rem] shrink-0 items-center justify-center rounded-[4px] text-[10px] font-semibold transition focus-visible:outline-2 focus-visible:outline-cm-cyan disabled:opacity-60",
          state.armed ? "bg-cm-rose text-white" : "bg-cm-contrast/8 text-cm-text hover:bg-cm-rose/15")}>
        {state.status === "stopping" ? "Αποθήκευση…" : state.armed ? "Σίγουρα;" : "Διακοπή"}
      </button>
    </div>
  );
}

