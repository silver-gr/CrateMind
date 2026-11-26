import { useState } from "react";
import { PageHeader } from "../components/ui/PageHeader";
import { GlassPanel } from "../components/ui/GlassPanel";
import { EmptyState } from "../components/ui/EmptyState";
import { Button } from "../components/ui/button";
import { KeyLabel } from "../components/ui/KeyBadge";
import { formatKey, fallbackKey } from "../lib/camelot";
import { cn } from "../lib/cn";
import { HistoryIcon, ListMusic, Play, Trash2 } from "../lib/icons";
import { usePlayer } from "../lib/player";
import {
  clock, dayLabel, groupSessionDays, playEndMs, playSourceLabel, playStartMs, playsLabel, trackName, tracksLabel, type PlaySession,
} from "../lib/playHistory";
import { usePref } from "../lib/prefs";
import { formatSetDuration } from "../lib/setDuration";
import { effectiveBpm } from "../lib/tempo";
import { formatClock } from "../lib/trackStructure";
import { usePlayHistoryList } from "../lib/usePlayHistoryList";
import { ActionContextMenu } from "../components/ui/context-menu";
import { mapMenu } from "../lib/menus/entries";
import { useTrackMenu, type TrackMenuSubject } from "../lib/menus/useTrackMenu";
import { sessionMenuEntries } from "../lib/menus/historyMenu";
import type { PlayHistoryEntry } from "../lib/types";

export default function PlayHistory() {
  const { playRouted } = usePlayer();
  const [keyFormat] = usePref("keyFormat");
  const { plays, sessions, hasMore, failed, loadingMore, busy, loadOlder, remove: removePlays, saveAsSet } = usePlayHistoryList({ enabled: true });
  const [selectedKey, setSelectedKey] = useState<number | null>(null);
  const [confirmKey, setConfirmKey] = useState<number | null>(null);

  // By membership: a session's key (its first play) changes when that play is deleted or older plays load.
  const selected = sessions.find(s => s.plays.some(play => play.id === selectedKey)) ?? sessions[0] ?? null;
  // While older pages remain, the oldest loaded session may be cut at the page boundary.
  const partial = hasMore && selected === sessions[sessions.length - 1];

  async function remove(ids: number[], message: string) {
    // Keep the selection on what is left of the selected session (decided before the list changes).
    const gone = new Set(ids);
    const hit = selected?.plays.some(play => gone.has(play.id)) ?? false;
    const survivor = selected?.plays.find(play => !gone.has(play.id))?.id ?? null;
    if (!(await removePlays(ids, message))) return;
    if (hit) setSelectedKey(survivor);
    setConfirmKey(null);
  }

  // A play's menu: the track menu, then the row's own delete (as its trash button: no confirmation).
  const { menu: trackMenu, dialogs: trackMenuDialogs } = useTrackMenu({});
  // A play carries the plain track, without its profile's status: the menu loads the track by id.
  const playMenu = mapMenu(trackMenu, (play: PlayHistoryEntry): TrackMenuSubject => ({
    kind: "ref",
    id: play.track.id,
    placeItems: [{ type: "item", icon: Trash2, label: "Διαγραφή από το ιστορικό", danger: true, disabled: busy, onSelect: () => void remove([play.id], "Η εγγραφή διαγράφηκε") }],
  }));
  // A session in the list: save, or select it and show its own delete confirmation.
  const sessionMenu = {
    entries: (session: PlaySession) => sessionMenuEntries({
      partial: hasMore && session === sessions[sessions.length - 1],
      busy,
      saveAsSet: () => void saveAsSet(session),
      remove: () => { setSelectedKey(session.key); setConfirmKey(session.key); },
    }),
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {trackMenuDialogs}
      <PageHeader icon={HistoryIcon} title="Ιστορικό" count={plays ? playsLabel(plays.length, hasMore) : null}
        subtitle="Ό,τι ακούστηκε πραγματικά στα decks, ομαδοποιημένο σε sessions (νέο session μετά από 30′ σιωπής)."
        className="px-4 sm:px-6" />
      {plays === null && !failed ? <p role="status" className="py-8 text-center text-sm text-cm-muted">Φόρτωση…</p>
        : failed && plays === null ? (
          <div className="p-4 sm:p-6"><EmptyState icon={HistoryIcon} title="Δεν φορτώθηκε το ιστορικό">Δοκίμασε ξανά σε λίγο.</EmptyState></div>
        ) : !selected ? (
          <div className="p-4 sm:p-6">
            <EmptyState icon={HistoryIcon} title="Κανένα κομμάτι ακόμα">
              Ό,τι παίζει σε ένα deck για 30″ καταγράφεται εδώ, εκτός από την «Ουρά tagging».
            </EmptyState>
            {hasMore && (
              <Button type="button" size="sm" variant="ghost" className="mx-auto mt-2 flex" disabled={loadingMore} onClick={() => void loadOlder()}>
                {loadingMore ? "Φόρτωση…" : "Φόρτωσε παλιότερα"}
              </Button>
            )}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pt-4 pb-4 sm:px-6 lg:flex-row lg:overflow-hidden">
            <ActionContextMenu menu={sessionMenu} rowSelector="[data-session-key]" pick={row => sessions.find(s => s.key === Number(row.dataset.sessionKey))}>
            <nav aria-label="Sessions" className="shrink-0 lg:min-h-0 lg:w-72 lg:overflow-y-auto lg:pb-24">
              <SessionList sessions={sessions} selectedKey={selected.key} onSelect={setSelectedKey} />
              {hasMore && (
                <Button type="button" size="sm" variant="ghost" className="mt-2 w-full" disabled={loadingMore} onClick={() => void loadOlder()}>
                  {loadingMore ? "Φόρτωση…" : "Φόρτωσε παλιότερα"}
                </Button>
              )}
            </nav>
            </ActionContextMenu>

            <GlassPanel className="min-w-0 flex-1 p-5 lg:min-h-0 lg:overflow-y-auto">
              <div className="mb-4 flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <h2 className="text-base font-semibold text-cm-text">{dayLabel(selected.startMs)}</h2>
                  <p className="text-sm text-cm-muted tabular-nums">
                    {clock(selected.startMs)}–{clock(selected.endMs)} · {tracksLabel(selected.plays.length)} · {formatSetDuration((selected.endMs - selected.startMs) / 1000)}
                  </p>
                </div>
                {partial && <span className="w-full text-xs text-cm-muted">Φόρτωσε παλιότερα για όλο το session.</span>}
                <Button type="button" size="sm" variant="soft" disabled={busy || partial} onClick={() => void saveAsSet(selected)}>
                  <ListMusic />Αποθήκευση ως set
                </Button>
                {confirmKey === selected.key ? (
                  <span className="flex items-center gap-2">
                    <span className="text-xs text-cm-muted">Διαγραφή όλου του session;</span>
                    <Button type="button" size="sm" variant="destructive" disabled={busy}
                      onClick={() => void remove(selected.plays.map(play => play.id), "Το session διαγράφηκε")}>Επιβεβαίωση</Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmKey(null)}>Άκυρο</Button>
                  </span>
                ) : (
                  <Button type="button" size="sm" variant="ghost" disabled={busy || partial} onClick={() => setConfirmKey(selected.key)}>
                    <Trash2 />Διαγραφή session
                  </Button>
                )}
              </div>

              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="border-b border-cm-contrast/10 text-left text-[11px] font-semibold tracking-wide text-cm-muted uppercase">
                      <th scope="col" className="w-8 py-2 pr-2 font-semibold">#</th>
                      <th scope="col" className="py-2 pr-3 font-semibold">Κομμάτι</th>
                      <th scope="col" className="py-2 pr-3 text-right font-semibold">BPM</th>
                      <th scope="col" className="py-2 pr-3 font-semibold">Key</th>
                      <th scope="col" className="py-2 pr-3 font-semibold">Έναρξη</th>
                      <th scope="col" className="py-2 pr-3 font-semibold">Λήξη</th>
                      <th scope="col" className="py-2 pr-3 text-right font-semibold">Διάρκεια</th>
                      <th scope="col" className="py-2 pr-3 font-semibold">Deck</th>
                      <th scope="col" className="py-2"><span className="sr-only">Ενέργειες</span></th>
                    </tr>
                  </thead>
                  <ActionContextMenu menu={playMenu} rowSelector="[data-play-id]"
                    pick={row => selected.plays.find(play => play.id === Number(row.dataset.playId))}>
                  <tbody className="divide-y divide-cm-contrast/8">
                    {selected.plays.map((play, index) => {
                      const bpm = effectiveBpm(play.track);
                      const timed = play.deck != null;
                      return (
                        <tr key={play.id} data-play-id={play.id} className="group/row transition-colors duration-150 hover:bg-cm-contrast/4">
                          <td className="py-2 pr-2 font-mono text-xs text-cm-faint tabular-nums">{index + 1}</td>
                          <td className="max-w-0 py-2 pr-3">
                            <span className="block truncate font-medium text-cm-text" title={trackName(play)}>{trackName(play)}</span>
                            <span className="block truncate text-xs text-cm-muted">{play.track.artist || "—"}</span>
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums text-cm-text">{bpm != null ? bpm.toFixed(bpm % 1 ? 1 : 0) : "—"}</td>
                          <td className="py-2 pr-3 text-cm-text"><KeyLabel track={play.track} format={keyFormat} /></td>
                          <td className="py-2 pr-3 tabular-nums text-cm-text">{clock(playStartMs(play))}</td>
                          <td className="py-2 pr-3 tabular-nums text-cm-muted">{timed ? clock(playEndMs(play)) : "—"}</td>
                          <td className="py-2 pr-3 text-right tabular-nums text-cm-muted">{timed && play.played_seconds != null ? formatClock(play.played_seconds) : "—"}</td>
                          <td className="py-2 pr-3 whitespace-nowrap text-xs text-cm-muted">{playSourceLabel(play)}</td>
                          <td className="py-2 whitespace-nowrap text-right">
                            <Button type="button" size="icon-xs" variant="ghost" title="Αναπαραγωγή" aria-label={`Αναπαραγωγή: ${trackName(play)}`}
                              onClick={() => playRouted(play.track)}><Play /></Button>
                            <Button type="button" size="icon-xs" variant="ghost" disabled={busy} title="Διαγραφή από το ιστορικό" aria-label={`Διαγραφή από το ιστορικό: ${trackName(play)}`}
                              onClick={() => void remove([play.id], "Η εγγραφή διαγράφηκε")}><Trash2 /></Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  </ActionContextMenu>
                </table>
              </div>
            </GlassPanel>
          </div>
        )}
    </div>
  );
}

/** Sessions under day headers, newest first. */
function SessionList({ sessions, selectedKey, onSelect }: { sessions: PlaySession[]; selectedKey: number; onSelect: (key: number) => void }) {
  const days = groupSessionDays(sessions);
  return (
    <div className="space-y-4">
      {days.map(day => (
        <section key={day.label} aria-label={day.label}>
          <h3 className="mb-1.5 px-1 text-xs font-semibold tracking-wide text-cm-muted uppercase">{day.label}</h3>
          <ul className="space-y-1">
            {day.sessions.map(session => (
              <li key={session.key} data-session-key={session.key}>
                <button type="button" onClick={() => onSelect(session.key)} aria-pressed={session.key === selectedKey}
                  className={cn("flex w-full items-baseline gap-3 rounded-lg border px-3 py-2 text-left outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-cm-cyan",
                    session.key === selectedKey ? "border-cm-cyan/40 bg-cm-cyan/8" : "border-transparent hover:bg-cm-contrast/5")}>
                  <span className="font-mono text-sm font-medium text-cm-text tabular-nums">{clock(session.startMs)}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-cm-muted">{tracksLabel(session.plays.length)}</span>
                  <span className="text-xs text-cm-faint tabular-nums">{formatSetDuration((session.endMs - session.startMs) / 1000)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
