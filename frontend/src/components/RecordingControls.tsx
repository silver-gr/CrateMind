import { pressStop, startRecording, useRecording, type RecordingState } from "../lib/recorder";
import { formatElapsed } from "../lib/recordingCore";
import { unlockPlaybackAudio } from "../lib/playbackAudio";

const dot = (live: boolean) => <span aria-hidden className={`size-1.5 shrink-0 rounded-full bg-cm-rose ${live ? "motion-safe:animate-pulse" : "opacity-70"}`} />;

function stopLabel(state: RecordingState) {
  if (state.status === "stopping") return "Αποθήκευση…";
  return state.status === "on" && state.armed ? "Πάτα ξανά για διακοπή" : "Διακοπή εγγραφής";
}

/** «REC» in the mixer strip: starts a set recording of the master output; while recording, it is the stop button. */
export function RecordChip() {
  const state = useRecording();
  const live = state.status === "on" || state.status === "stopping";
  const label = live ? stopLabel(state) : state.status === "starting" ? "Η εγγραφή ξεκινά…" : "Εγγραφή set (WAV στον φάκελο export)";
  const onClick = () => {
    if (live) { pressStop(); return; }
    void unlockPlaybackAudio();
    void startRecording();
  };
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} disabled={state.status === "starting" || state.status === "stopping"}
      className={`flex h-4 w-20 shrink-0 items-center justify-center gap-1 rounded-sm border px-1.5 text-[9px] font-bold tracking-wider tabular-nums transition focus-visible:outline-2 focus-visible:outline-cm-cyan disabled:opacity-60 ${live
        ? "border-cm-rose/60 bg-cm-rose/10 text-cm-rose shadow-[0_0_8px_-3px_var(--color-cm-rose)]"
        : "border-cm-line/20 text-cm-muted hover:text-cm-text dark:border-white/10"}`}>
      {dot(live)}
      {live && state.armed ? "Σίγουρα;" : live ? formatElapsed(state.seconds) : "REC"}
    </button>
  );
}

/** Top-centre status while recording, on every page and in both deck modes (the dock can be collapsed). */
export function RecordingPill() {
  const state = useRecording();
  if (state.status !== "on" && state.status !== "stopping") return null;
  const label = stopLabel(state);
  return (
    <div role="status" aria-live="off"
      // Fixed width, button pinned right: changing text never moves the stop button between two presses.
      className="fixed left-1/2 top-1.5 z-50 flex h-5 w-60 -translate-x-1/2 items-center gap-1.5 rounded-full border border-cm-rose/50 bg-cm-bg-2/85 pl-2 pr-0.5 text-[10px] font-semibold text-cm-rose tabular-nums shadow-sm backdrop-blur">
      {dot(true)}
      <span className="whitespace-nowrap">REC {formatElapsed(state.seconds)}</span>
      {state.clipped > 0 && <span className="whitespace-nowrap text-cm-amber" title="Κάποια σημεία ψαλιδίστηκαν· άνοιξε τον Maximizer ή χαμήλωσε λίγο τα faders ή το trim">· ψαλίδισμα</span>}
      <button type="button" onClick={pressStop} disabled={state.status === "stopping"} aria-label={label} title={label}
        className={`ml-auto h-4 w-[5.5rem] shrink-0 rounded-full text-center text-[10px] font-semibold transition focus-visible:outline-2 focus-visible:outline-cm-cyan disabled:opacity-60 ${state.armed
          ? "bg-cm-rose text-white" : "text-cm-text hover:bg-cm-rose/15"}`}>
        {state.status === "stopping" ? "Αποθήκευση…" : state.armed ? "Σίγουρα;" : "Διακοπή"}
      </button>
    </div>
  );
}
