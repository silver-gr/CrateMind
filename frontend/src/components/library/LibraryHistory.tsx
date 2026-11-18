import { memo, useId, useState, type KeyboardEvent, type MouseEvent } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { EmptyState } from "../ui/EmptyState";
import { Skeleton } from "../ui/skeleton";
import { formatKey, keyColor } from "../../lib/camelot";
import { cn } from "../../lib/cn";
import { ArrowRight, ChevronRight, HistoryIcon, ListMusic, Play, RotateCcw, TriangleAlert } from "../../lib/icons";
import { usePlayer } from "../../lib/player";
import {
  clock, groupSessionDays, playSourceLabel, playStartMs, playsLabel, trackName, tracksLabel, type PlaySession,
} from "../../lib/playHistory";
import { usePref } from "../../lib/prefs";
import { formatSetDuration } from "../../lib/setDuration";
import { effectiveBpm } from "../../lib/tempo";
import { endTrackDrag, startTrackDrag } from "../../lib/trackDrag";
import { formatClock } from "../../lib/trackStructure";
import { usePlayHistoryList } from "../../lib/usePlayHistoryList";
import type { KeyFormat } from "../../lib/camelot";
import type { PlayHistoryEntry, Track } from "../../lib/types";

const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cm-cyan/60";
/** A pointer click must not leave focus on the button: Space, J/K and the cue keys stay global. */
const blurAfterPointer = (event: MouseEvent<HTMLElement>) => { if (event.detail > 0) event.currentTarget.blur(); };
/** A native button clicks on Space keyup; Space stays the transport toggle. */
const keepSpace = (event: KeyboardEvent<HTMLElement>) => { if (event.key === " ") event.preventDefault(); };

/** The Library «Ιστορικό» tab: sessions under day headers, newest unfolded; deletes stay on the full page. */
function LibraryHistory({ active, selectedId, onSelect, onSetSaved }: {
  active: boolean;
  /** The inspector's track: its plays are marked. */
  selectedId?: number;
  onSelect(trackId: number): void;
  onSetSaved?(): void;
}) {
  const { plays, sessions, hasMore, failed, loadingMore, busy, loadOlder, saveAsSet, retry } = usePlayHistoryList({ enabled: active });
  const { playRouted } = usePlayer();
  const [keyFormat] = usePref("keyFormat");
  // Folding is a user override over the default (only the newest session open), so the default applies once rows arrive.
  const [folded, setFolded] = useState<ReadonlyMap<number, boolean>>(new Map());
  const isOpen = (session: PlaySession) => !(folded.get(session.key) ?? session !== sessions[0]);
  const toggle = (session: PlaySession) => setFolded(map => new Map(map).set(session.key, isOpen(session)));
  const oldest = sessions[sessions.length - 1];
  const dayId = useId();

  const loadOlderButton = hasMore && (
    <Button type="button" size="sm" variant="ghost" className="mt-2 w-full text-cm-muted" disabled={loadingMore}
      onClick={event => { blurAfterPointer(event); void loadOlder(); }}>
      {loadingMore ? "Φόρτωση…" : "Φόρτωσε παλιότερα"}
    </Button>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-cm-border/60 px-3">
        <p className="min-w-0 flex-1 truncate font-mono text-[11px] tabular-nums text-cm-muted">
          {plays ? playsLabel(plays.length, hasMore) : null}
        </p>
        <Link to="/history" title="Άνοιγμα της σελίδας «Ιστορικό»"
          className={cn("relative inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-cm-muted transition-colors duration-150 hover:bg-cm-contrast/6 hover:text-cm-text", FOCUS)}>
          Πλήρης σελίδα<ArrowRight aria-hidden="true" className="size-3" />
        </Link>
      </div>

      {plays === null && failed && (
        <div role="alert" className="mx-3 mt-2.5 flex shrink-0 items-start gap-2 rounded-lg border border-cm-amber/25 bg-cm-amber/8 px-2.5 py-2 text-xs text-cm-text">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-cm-amber" />
          <span className="min-w-0 flex-1 text-pretty">Δεν φορτώθηκε το ιστορικό.</span>
          <Button type="button" variant="outline" size="xs" onClick={retry}>
            <RotateCcw aria-hidden="true" />
            Δοκίμασε ξανά
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pt-1 pb-[calc(0.75rem+var(--cm-dock-clearance,0px))]">
        {plays === null && !failed ? (
          <div role="status" className="space-y-1 pt-2">
            <span className="sr-only">Φόρτωση ιστορικού…</span>
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} aria-hidden="true" className="flex h-10 items-center gap-2 px-2">
                <Skeleton className="h-3 w-8" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton className="h-3 w-3/4" />
                  <Skeleton className="h-2.5 w-1/2" />
                </div>
                <Skeleton className="h-3 w-10" />
              </div>
            ))}
          </div>
        ) : plays === null ? null : sessions.length === 0 ? (
          <>
            <EmptyState icon={HistoryIcon} title="Κανένα κομμάτι ακόμα" className="mt-2 px-4 py-8">
              Ό,τι παίζει σε ένα deck για 30″ καταγράφεται εδώ, εκτός από την «Ουρά tagging».
            </EmptyState>
            {loadOlderButton}
          </>
        ) : (
          <>
            {groupSessionDays(sessions).map((day, i) => (
              <div key={day.label}>
                <h3 id={`${dayId}-${i}`} className="sticky top-0 z-10 -mx-2 bg-cm-glass-strong px-4 pt-3 pb-1 text-[11px] font-medium tracking-wider text-cm-muted uppercase backdrop-blur-xl">{day.label}</h3>
                <ul aria-labelledby={`${dayId}-${i}`} className="space-y-0.5">
                  {day.sessions.map(session => (
                    <SessionItem key={session.key} session={session} open={isOpen(session)} onToggle={() => toggle(session)}
                      partial={hasMore && session === oldest} busy={busy} rowProps={{ keyFormat, selectedId, onSelect, onPlay: playRouted }}
                      onSave={async () => { if (await saveAsSet(session)) onSetSaved?.(); }} />
                  ))}
                </ul>
              </div>
            ))}
            {loadOlderButton}
          </>
        )}
      </div>
    </div>
  );
}

type RowProps = { keyFormat: KeyFormat; selectedId?: number; onSelect(trackId: number): void; onPlay(track: Track): void };

function SessionItem({ session, open, onToggle, partial, busy, rowProps, onSave }: {
  session: PlaySession;
  open: boolean;
  onToggle(): void;
  partial: boolean;
  busy: boolean;
  rowProps: RowProps;
  onSave(): void;
}) {
  const span = `${clock(session.startMs)}–${clock(session.endMs)}`;
  const count = tracksLabel(session.plays.length);
  const listId = `history-session-${session.key}`;
  const hintId = `${listId}-hint`;
  return (
    <li>
      <div className="flex items-center gap-0.5 rounded-md transition-colors duration-150 hover:bg-cm-contrast/4">
        <button type="button" aria-expanded={open} aria-controls={open ? listId : undefined}
          onClick={event => { blurAfterPointer(event); onToggle(); }} onKeyUp={keepSpace}
          className={cn("flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md pr-1 pl-1 text-left", FOCUS)}>
          <ChevronRight aria-hidden="true" className={cn("size-3.5 shrink-0 text-cm-faint motion-safe:transition-transform motion-safe:duration-150", open && "rotate-90")} />
          <span className="shrink-0 font-mono text-xs font-medium tabular-nums text-cm-text">{span}</span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-cm-muted" title={count}>{count}</span>
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-cm-muted">{formatSetDuration((session.endMs - session.startMs) / 1000)}</span>
        </button>
        <button type="button" disabled={busy || partial} aria-describedby={partial ? hintId : undefined}
          title={partial ? "Φόρτωσε παλιότερα για όλο το session" : "Αποθήκευση ως set"}
          aria-label={`Αποθήκευση ως set: ${span}`}
          onClick={event => { blurAfterPointer(event); onSave(); }} onKeyUp={keepSpace}
          className={cn("grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-cm-faint transition-[background-color,color,scale] duration-150 hover:bg-cm-cyan/10 hover:text-cm-text motion-safe:enabled:active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40", FOCUS)}>
          <ListMusic aria-hidden="true" className="size-3.5" />
        </button>
      </div>
      {partial && <p id={hintId} className="px-2 pb-1 pl-7 text-[11px] text-cm-faint">Φόρτωσε παλιότερα για όλο το session.</p>}
      {open && (
        <ul id={listId} aria-label={`Session ${span}`} className="pb-1">
          {session.plays.map(play => <PlayRow key={play.id} play={play} {...rowProps} />)}
        </ul>
      )}
    </li>
  );
}

function PlayRow({ play, keyFormat, selectedId, onSelect, onPlay }: RowProps & { play: PlayHistoryEntry }) {
  const { track } = play;
  const name = trackName(play);
  const start = clock(playStartMs(play));
  const bpm = effectiveBpm(track);
  const key = formatKey(track.key_text, track.key_analyzed, keyFormat);
  const selected = track.id === selectedId;
  const heard = play.deck == null ? playSourceLabel(play) : play.played_seconds != null ? formatClock(play.played_seconds) : "—";
  return (
    <li draggable={!track.missing} onDragStart={event => startTrackDrag(event, track)} onDragEnd={endTrackDrag}
      className={cn("group/play flex items-stretch rounded-md transition-colors duration-150",
        selected ? "bg-cm-cyan/12 shadow-[inset_2px_0_0_var(--color-cm-cyan)]" : "hover:bg-cm-contrast/5")}>
      <button type="button" data-playback-toggle title="Αναπαραγωγή" aria-label={`${start} · Αναπαραγωγή: ${name}`}
        onClick={event => { blurAfterPointer(event); onPlay(track); }} onKeyUp={keepSpace}
        className={cn("group/pb grid h-10 w-11 shrink-0 cursor-pointer place-items-center rounded-md text-cm-muted hover:text-cm-cyan", FOCUS)}>
        <span className="font-mono text-[11px] tabular-nums [grid-area:1/1] group-hover/play:opacity-0 group-focus-visible/pb:opacity-0">{start}</span>
        <Play aria-hidden="true" className="size-3.5 translate-x-px opacity-0 [grid-area:1/1] group-hover/play:opacity-100 group-focus-visible/pb:opacity-100" />
      </button>
      <button type="button" aria-current={selected || undefined} onClick={event => { blurAfterPointer(event); onSelect(track.id); }} onDoubleClick={() => onPlay(track)} onKeyUp={keepSpace}
        className={cn("flex h-10 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md pr-2 text-left", FOCUS)}>
        <span className="sr-only">{start} · </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] leading-tight font-medium text-cm-text" title={name}>{name}</span>
          <span className="block truncate text-[11px] leading-tight text-cm-muted" title={track.artist || undefined}>{track.artist || "—"}</span>
        </span>
        <span className="shrink-0 text-right font-mono text-[11px] leading-tight tabular-nums">
          <span className="block whitespace-nowrap text-cm-muted">
            {bpm != null ? bpm.toFixed(0) : "—"}
            {" "}<span style={{ color: keyColor(formatKey(track.key_text, track.key_analyzed)) }}>{key}</span>
          </span>
          <span className="block whitespace-nowrap text-cm-faint">{heard}</span>
        </span>
      </button>
    </li>
  );
}

export default memo(LibraryHistory);
