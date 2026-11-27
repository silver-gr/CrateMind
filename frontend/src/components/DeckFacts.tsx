import { useEffect, type CSSProperties, type ReactNode } from "react";
import { KeyLabel } from "./ui/KeyBadge";
import { ActionContextMenu } from "./ui/context-menu";
import type { BeatGrid } from "../lib/beatGrid";
import { fallbackKey, keyColor, type KeyFormat } from "../lib/camelot";
import { NEXT_PART_SOON_BARS, keyRelation, lastSeconds, loopText, nextPart, publishDeckTempo, tempoGapText, timeLeftText, useDeckTempos } from "../lib/deckFacts";
import type { MenuSource } from "../lib/menus/entries";
import { pickDeck } from "../lib/menus/deckMenu";
import { useSyncLock } from "../lib/mixer";
import { usePlayer } from "../lib/player";
import { useTrackStructure } from "../lib/trackStructureStore";
import type { Track } from "../lib/types";
import { cn } from "../lib/cn";

/** The deck's letter at the outer end of its half, in the deck colour. */
export function FactsLetter({ deck }: { deck: "A" | "B" }) {
  return (
    <span aria-hidden className="flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-[color-mix(in_oklch,var(--deck)_22%,transparent)] font-mono text-xs font-bold leading-none text-[var(--deck)] ring-1 ring-inset ring-[color-mix(in_oklch,var(--deck)_55%,transparent)] light:text-black/80">{deck}</span>
  );
}

// Coloured numbers on the white Solar Void glass: the deck colour, darkened until it reads as ink.
const deckInk = "text-[var(--deck)] light:brightness-[0.62]";

const deckKey = (track: Track | null) => track?.key_text?.trim() || fallbackKey(track);

/**
 * The centre cell's two lines, under the playhead: whether the two keys mix («KEY ✓ 8A · 9A», only the mark is coloured), then
 * which deck follows the other while a Sync lock holds («B ακολουθεί A», in the follower's colour), else how far apart the
 * two tempos are («Δ 1.1 BPM»). Each line is left out while a deck has nothing to compare.
 */
export function FactsCentre() {
  const { slots } = usePlayer();
  const follower = useSyncLock();
  const tempos = useDeckTempos();
  const keys = keyRelation(deckKey(slots.A.track), deckKey(slots.B.track));
  const gap = tempoGapText(tempos.A, tempos.B);
  return (
    <div className="flex h-[30px] shrink-0 flex-col items-center justify-center gap-1 whitespace-nowrap font-mono text-[10px] font-bold leading-none">
      {keys && (
        <span className="text-cm-text/85" title={keys.fit ? "Τα δύο keys ταιριάζουν" : "Τα δύο keys δεν ταιριάζουν"}>
          KEY <span className={keys.fit ? "text-emerald-400 light:text-emerald-700" : "text-cm-rose"}>{keys.fit ? "✓" : "✕"}</span> {keys.a} · {keys.b}
          <span className="sr-only">{keys.fit ? " (ταιριάζουν)" : " (δεν ταιριάζουν)"}</span>
        </span>
      )}
      {follower
        ? <span style={{ "--deck": follower === "A" ? "var(--cm-deck-a)" : "var(--cm-deck-b)" } as CSSProperties} className={cn("font-sans", deckInk)}>{follower} ακολουθεί {follower === "A" ? "B" : "A"}</span>
        : gap && <span className="text-cm-muted">{gap}</span>}
    </div>
  );
}

/**
 * One deck's half of the facts row under the waveforms, drawn inside the deck's own tree (MiniPlayer portals it into the row),
 * so its numbers and its overview come from the same source. From the playhead outwards: time left, key, tempo with the
 * pitch, bars to the next part, the loop size, title and artist, the deck's letter. Deck B is mirrored, so both time-left
 * numbers and both keys flank the centre. A narrow half drops, in this order: title, «LOOP», the part's name, the pitch
 * (at 600, 540, 470 and 380 px of room inside the half: windows under about 1380, 1260, 1120 and 940 px); the time left, the
 * key, the tempo and the bars number never hide. The steps leave room for the widest texts («-10:00», «10A», «LOOP 16»).
 * `children` is the overview under the numbers; `compact` (a window too short for it) keeps the numbers alone. A right-click
 * anywhere on the half, the overview included (a right-click never seeks), opens the deck's `menu`.
 */
export function DeckFacts({ deck, mirrored = false, track, time, duration, tempo, pitch, grid, loop, keyFormat, compact = false, menu, children }: {
  deck: "A" | "B";
  mirrored?: boolean;
  track: Track;
  time: number;
  duration: number;
  /** The track's BPM at the pitch fader's rate; null without a BPM. */
  tempo: number | null;
  /** «-0.7%»; null on a deck that cannot change its tempo. */
  pitch: string | null;
  grid: BeatGrid | null;
  /** The length the next loop gets, in beats, and whether a loop runs now. */
  loop: { beats: number; on: boolean };
  keyFormat: KeyFormat;
  compact?: boolean;
  /** The deck's right-click menu (`useDeckMenu`). */
  menu?: MenuSource<true>;
  children?: ReactNode;
}) {
  useEffect(() => {
    publishDeckTempo(deck, tempo);
    return () => publishDeckTempo(deck, null);
  }, [deck, tempo]);
  const structure = useTrackStructure(track.id);
  const part = nextPart(grid, structure?.sections, time, duration);
  const color = keyColor(track.key_text, fallbackKey(track));
  const title = track.title || track.file_name;
  return (
    <ActionContextMenu pick={pickDeck} menu={menu}>
    <div data-deck-facts-half role="group" aria-label={`Στοιχεία Deck ${deck}`} className="flex min-w-0 flex-1 flex-col">
      <div className={cn("flex h-[30px] min-w-0 shrink-0 items-center gap-3 @max-[380px]/facts:gap-2", mirrored && "flex-row-reverse")}>
        {/* Once the title has dropped out, this takes its room, so the numbers stay beside the playhead. */}
        <span aria-hidden className="hidden min-w-0 flex-1 @max-[600px]/facts:block" />
        <span className={cn("min-w-0 flex-1 truncate text-xs text-cm-muted @max-[600px]/facts:hidden", mirrored && "text-right")} title={track.artist ? `${title} · ${track.artist}` : title}>
          <span className="font-semibold text-cm-text">{title}</span>{track.artist && ` · ${track.artist}`}
        </span>
        <span title={loop.on ? "Τρέχει loop" : "Το μήκος που θα πάρει το επόμενο loop, σε beats"}
          className={cn("shrink-0 rounded-[4px] border px-1.5 font-mono text-[11px] font-bold leading-5 @max-[540px]/facts:hidden",
            loop.on ? cn("border-[color-mix(in_oklch,var(--deck)_60%,transparent)] bg-[color-mix(in_oklch,var(--deck)_18%,transparent)]", deckInk) : "border-cm-line/20 text-cm-faint dark:border-white/10")}>
          {loopText(loop.beats)}
        </span>
        {part && (
          <span className="flex shrink-0 items-baseline gap-1.5 tabular-nums" title="Bars μέχρι το επόμενο μέρος του κομματιού">
            <span className={cn("font-mono text-2xl font-bold leading-none tracking-[-0.02em]", part.bars <= NEXT_PART_SOON_BARS ? "text-cm-amber" : deckInk)}>{part.bars}</span>
            <span className="text-xs font-medium text-cm-muted">bars<span className="@max-[470px]/facts:hidden"> → {part.to}</span></span>
          </span>
        )}
        <span className="flex shrink-0 items-baseline gap-1.5 font-mono tabular-nums">
          <span role="group" aria-label={`Tempo, Deck ${deck}`} className="text-xl font-bold leading-none text-cm-text">{tempo != null ? tempo.toFixed(1) : "—"}</span>
          {pitch && <span className={cn("text-[11px] font-semibold @max-[380px]/facts:hidden", pitch === "0.0%" ? "text-cm-muted" : deckInk)}>{pitch}</span>}
        </span>
        <span className="flex h-7 shrink-0 items-center rounded-md border border-cm-line/20 px-1.5 font-mono text-lg font-bold leading-none text-cm-muted"
          style={color ? { color, borderColor: `color-mix(in oklch, ${color} 40%, transparent)`, backgroundColor: `color-mix(in oklch, ${color} 12%, transparent)` } : undefined}>
          <KeyLabel track={track} format={keyFormat} />
        </span>
        <span role="group" aria-label={`Υπόλοιπο χρόνου, Deck ${deck}`} className={cn("shrink-0 font-mono text-[28px] font-bold leading-none tracking-[-0.03em] tabular-nums", lastSeconds(duration, time) ? "text-cm-rose" : "text-cm-text")}>
          {timeLeftText(duration, time)}
        </span>
        {/* The deck's letter closes the row at the centre side, beside the time left. */}
        <span className="flex shrink-0"><FactsLetter deck={deck} /></span>
      </div>
      {!compact && children}
    </div>
    </ActionContextMenu>
  );
}
