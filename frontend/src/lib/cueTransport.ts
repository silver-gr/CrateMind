// CDJ-style Cue button for one deck. Pure state machine over a small I/O facade (MiniPlayer supplies it),
// so MIDI, the UI and tests drive the same logic. Session state only: nothing is written to the DB.

/** "At the cue" means within this many seconds. */
export const CUE_TOLERANCE_S = 0.02;

export type CueIo = {
  position(): number;
  playing(): boolean;
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  /** Drops a pending jog scrub, which would otherwise re-seek/resume over the Cue action. */
  clearJog(): void;
  /** Entry cue in seconds (the default main cue), or null. */
  entryCue(): number | null;
  /** Load token + source key: a preview that outlives its load must not seek the next one. */
  identity(): string;
};

export type CueCancelReason = "disconnect" | "replace" | "eject";

export function createCueMachine(io: CueIo) {
  let session: number | null = null;
  let preview: { identity: string } | null = null;
  const mainCue = () => session ?? io.entryCue() ?? 0;

  // Back to the cue, paused. Pause first: the engine's pause rewrites its anchor, so a seek must follow it.
  function returnToCue() {
    io.clearJog();
    io.pause();
    io.seek(mainCue());
  }
  function endPreview(returnHome: boolean) {
    const current = preview;
    preview = null;
    if (current && returnHome && current.identity === io.identity()) returnToCue();
  }

  return {
    mainCue,
    /** A main cue is set (by the user this load, or an entry cue). */
    hasCue: () => session !== null || io.entryCue() !== null,
    previewing: () => preview !== null,
    /** Cue pressed; `shift` = Shift + Cue (0:00). */
    press(shift: boolean) {
      io.clearJog();
      if (preview) return;
      if (shift) { io.pause(); io.seek(0); return; }
      const cue = mainCue();
      if (io.playing()) { io.pause(); io.seek(cue); }
      else if (Math.abs(io.position() - cue) <= CUE_TOLERANCE_S) { preview = { identity: io.identity() }; io.play(); }
      else session = io.position();
    },
    /** Release of Cue or Shift + Cue: ends a preview, so Shift pressed mid-hold can't leave it stuck. */
    release() { endPreview(true); },
    /** The preview's owner went away. Only a disconnect returns to the cue; a replaced/ejected load is already paused. */
    cancel(reason: CueCancelReason) { endPreview(reason === "disconnect"); },
    /** Play/pause pressed while previewing: keep playing and let the release do nothing. True = consumed. */
    latch(): boolean {
      if (!preview) return false;
      preview = null;
      return true;
    },
    /** New track on the deck: the user's cue belongs to the old load. */
    resetSession() { session = null; },
  };
}
