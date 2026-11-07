import { useEffect, useState } from "react";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { SkipForward, X } from "../lib/icons";
import {
  canSkip, inTransitionWindow, mixClock, mixOutPlaying, skipToTransition, stopMixSession, useMixAnnouncement, useMixSession, type MixSession,
} from "../lib/mix/mixSession";
import { MIX_COPY, PRESET_LABELS, presetLabel } from "../lib/transitions/copy";
import type { Track } from "../lib/types";

/** Height of the strip (h-7); the shell adds it to the player height while a session runs. */
export const STRIP_H = 28;

const titleOf = (t: Track) => t.title || t.file_name;
const clockText = (s: number) => {
  const total = Math.max(0, Math.ceil(s));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

function statusText(s: MixSession, now: number): string {
  const entry = s.queue[s.index];
  const next = s.queue[s.index + 1];
  const t = entry?.transition;
  const label = s.forceCut ? MIX_COPY.cut : t ? presetLabel(t.preset, t.resolved_preset) : PRESET_LABELS.fade;
  switch (s.status) {
    case "loading": return "φόρτωση…";
    case "armed": return "ετοιμασία…";
    case "transitioning": return `μετάβαση · ${label}`;
    case "stopping": return "διακοπή…";
    default:
      if (!next) return "τελευταίο track";
      return s.transitionAt == null ? `σε αναμονή · ${label}` : `${MIX_COPY.transitionTo} ${clockText(s.transitionAt - now)} · ${label}`;
  }
}

/** The live session above the decks: what plays, what is next, the countdown, «Παράλειψη» and «Διακοπή». */
export default function MixStatusStrip() {
  const s = useMixSession();
  const [now, setNow] = useState(mixClock);
  useEffect(() => {
    const id = window.setInterval(() => setNow(mixClock()), 500);
    return () => window.clearInterval(id);
  }, []);
  const current = s.queue[s.index];
  const next = s.queue[s.index + 1];
  const skippable = canSkip(s, now, mixOutPlaying());

  return (
    <div role="region" aria-label="Μίξη set" className="glass relative z-20 flex h-7 shrink-0 items-center gap-2 border-t border-cm-line/20 px-3 text-xs dark:border-white/8">
      <span className="max-w-[28%] shrink-0 truncate font-medium text-cm-text">
        {s.mode === "preview" ? "Προεπισκόπηση" : `${MIX_COPY.mix}: ${s.setTitle}`}
      </span>
      {current && (
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 text-cm-muted">{MIX_COPY.now}</span>
          <span className="truncate text-cm-text">{titleOf(current.track)}</span>
        </span>
      )}
      {next && (
        <span className="hidden min-w-0 items-baseline gap-1.5 sm:flex">
          <span className="shrink-0 text-cm-muted">{MIX_COPY.next}</span>
          <span className="truncate text-cm-text">{titleOf(next.track)}</span>
        </span>
      )}
      <span aria-live="off" className="ml-auto shrink-0 font-mono tabular-nums text-cm-cyan">{statusText(s, now)}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* aria-disabled, not disabled: a disabled button gets no hover or focus, so its tooltip would be unreachable. */}
          <Button type="button" variant="ghost" size="icon-xs" aria-label={MIX_COPY.skip} aria-disabled={!skippable}
            onClick={skippable ? skipToTransition : undefined}
            className="motion-safe:active:scale-95 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:active:scale-100">
            <SkipForward />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Μετάβαση στο επόμενο track από την επόμενη μπάρα</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type="button" variant="ghost" size="icon-xs" aria-label={MIX_COPY.stop} onClick={() => stopMixSession("user")}
            className="motion-safe:active:scale-95">
            <X />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{s.mode === "preview" ? "Διακοπή προεπισκόπησης" : inTransitionWindow(s, now) ? MIX_COPY.stopHintWindow : MIX_COPY.stopHint}</TooltipContent>
      </Tooltip>
    </div>
  );
}

/** Polite announcements of session state changes; mounted permanently so they are heard even as the strip goes. */
export function MixAnnouncer() {
  const text = useMixAnnouncement();
  return <div role="status" aria-live="polite" className="sr-only">{text}</div>;
}
