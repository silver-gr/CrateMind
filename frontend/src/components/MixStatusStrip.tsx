import { useEffect, useState } from "react";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { SkipForward, X } from "../lib/icons";
import { mixClock, otherDeck, skipToTransition, stopMixSession, useMixAnnouncement, useMixSession, type MixSession } from "../lib/mix/mixSession";
import { PRESET_LABELS, presetLabel } from "../lib/transitions/copy";
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
  const label = s.forceCut ? PRESET_LABELS.slam : t ? presetLabel(t.preset, t.resolved_preset) : PRESET_LABELS.fade;
  switch (s.status) {
    case "loading": return "φόρτωση…";
    case "armed": return "ετοιμασία…";
    case "transitioning": return `μετάβαση · ${label}`;
    case "stopping": return "διακοπή…";
    default:
      if (!next) return "τελευταίο track";
      return s.transitionAt == null ? `σε αναμονή · ${label}` : `μετάβαση σε ${clockText(s.transitionAt - now)} · ${label}`;
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
  const canSkip = (s.status === "playing" || s.status === "armed") && !!next && !s.skipped && s.ready[otherDeck(s.currentDeck)];

  return (
    <div role="region" aria-label="Μίξη set" className="glass relative z-20 flex h-7 shrink-0 items-center gap-2 border-t border-cm-line/20 px-3 text-xs dark:border-white/8">
      <span className="max-w-[28%] shrink-0 truncate font-medium text-cm-text">
        {s.mode === "preview" ? "Προεπισκόπηση" : `Μίξη: ${s.setTitle}`}
      </span>
      {current && (
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 text-cm-muted">τώρα</span>
          <span className="truncate text-cm-text">{titleOf(current.track)}</span>
        </span>
      )}
      {next && (
        <span className="hidden min-w-0 items-baseline gap-1.5 sm:flex">
          <span className="shrink-0 text-cm-muted">επόμενο</span>
          <span className="truncate text-cm-text">{titleOf(next.track)}</span>
        </span>
      )}
      <span aria-live="off" className="ml-auto shrink-0 font-mono tabular-nums text-cm-cyan">{statusText(s, now)}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Παράλειψη" disabled={!canSkip} onClick={skipToTransition}
            className="motion-safe:active:scale-95">
            <SkipForward />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Μετάβαση στο επόμενο track από την επόμενη μπάρα</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Διακοπή" onClick={() => stopMixSession("user")}
            className="motion-safe:active:scale-95">
            <X />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{s.mode === "preview" ? "Διακοπή προεπισκόπησης" : "Διακοπή μίξης (τα decks συνεχίζουν)"}</TooltipContent>
      </Tooltip>
    </div>
  );
}

/** Polite announcements of session state changes; mounted permanently so they are heard even as the strip goes. */
export function MixAnnouncer() {
  const text = useMixAnnouncement();
  return <div role="status" aria-live="polite" className="sr-only">{text}</div>;
}
