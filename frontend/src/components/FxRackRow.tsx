import { useEffect, useRef, useSyncExternalStore } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Knob } from "./ui/Knob";
import { FxRackPicker } from "./FxRackPicker";
import { cn } from "@/lib/cn";
import { deckBeatsIndex, engage, getFxRack, latchHeld, release, saveFxRackNow, setAmount, setBeats, stepBeats, subscribe, useFxRackDeck } from "../lib/fxRack";
import { beatsLabel, beatsNote, beatsValue, needsBpm, presetById } from "../lib/fxRack/presets";
import { effectiveBpm } from "../lib/tempo";
import type { DeckId } from "../lib/player";
import type { Track } from "../lib/types";

/** A press shorter than this latches the effect; a longer one was a hold and releases on let-go. */
const LATCH_MS = 250;
const FX_TITLE = "Κλικ: μένει ανοιχτό · Κράτημα: μόνο όσο το κρατάς";
const UNAVAILABLE = "Τα εφέ δεν είναι διαθέσιμα.";
const NEEDS_BPM = "Χρειάζεται BPM";
const shell = "rounded-lg border border-cm-line/30 bg-cm-contrast/8";
const stepClass = "flex h-full w-5 items-center justify-center text-cm-muted outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cm-cyan disabled:opacity-35 enabled:hover:text-cm-text enabled:active:bg-cm-contrast/12 motion-safe:transition-colors motion-safe:duration-150";

/**
 * FX button: a press holds the effect; let go within 250 ms and it stays on (latch), later and it ends. A press while
 * latched turns it off (its let-go does nothing). Space/Enter do the same; blur, cancel or unmount end only a hold this
 * button started. A click with no pointer or key behind it (assistive tech) toggles a latch.
 */
function FxButton({ deck, on, held, releasing, disabled, title }: { deck: DeckId; on: boolean; held: boolean; releasing: boolean; disabled: boolean; title: string }) {
  const press = useRef<number | "release" | null>(null);
  const down = () => {
    if (press.current !== null) return;
    const d = getFxRack().decks[deck];
    if (d.on && !d.held) { press.current = "release"; release(deck); }
    else { press.current = performance.now(); engage(deck, "hold"); }
  };
  const up = () => {
    const started = press.current;
    press.current = null;
    if (typeof started !== "number") return;
    if (performance.now() - started < LATCH_MS) latchHeld(deck);
    else release(deck);
  };
  const cancel = () => {
    const started = press.current;
    press.current = null;
    if (typeof started === "number" && getFxRack().decks[deck].held) release(deck);
  };
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  useEffect(() => {
    const onBlur = () => cancelRef.current();
    window.addEventListener("blur", onBlur);
    return () => { window.removeEventListener("blur", onBlur); cancelRef.current(); };
  }, []);
  useEffect(() => { if (disabled) cancelRef.current(); }, [disabled]);
  const hold = (code: string) => code === "Space" || code === "Enter";
  return (
    <button type="button" data-hold-key disabled={disabled} aria-pressed={on} aria-label={`Εφέ, Deck ${deck}`} title={title}
      onPointerDown={e => { if (e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); down(); }}
      onPointerUp={up} onPointerCancel={cancel} onLostPointerCapture={cancel} onBlur={cancel}
      onKeyDown={e => { if (hold(e.code)) { e.preventDefault(); if (!e.repeat) down(); } }}
      onKeyUp={e => { if (hold(e.code)) { e.preventDefault(); up(); } }}
      onClick={e => { if (e.detail === 0 && press.current === null) { if (getFxRack().decks[deck].on) release(deck); else engage(deck, "latch"); } }}
      className={cn("flex h-8 shrink-0 touch-none items-center rounded-lg border px-2.5 font-mono text-[11px] font-semibold tracking-[0.06em] outline-none select-none @max-[215px]/deckinfo:px-2 focus-visible:ring-2 focus-visible:ring-cm-cyan disabled:opacity-40 ease-out motion-safe:transition-[color,background-color,border-color,box-shadow,scale] motion-safe:duration-150 motion-safe:enabled:active:scale-[0.96]",
        on ? "border-[color-mix(in_oklch,var(--deck)_60%,transparent)] bg-[color-mix(in_oklch,var(--deck)_24%,transparent)] text-[var(--deck)]"
          : "border-cm-line/30 bg-cm-contrast/8 text-cm-text/85 enabled:hover:border-cm-line/50 enabled:hover:text-cm-text",
        on && held && "ring-1 ring-[var(--deck)]",
        on && releasing && "border-dashed")}>
      FX
    </button>
  );
}

/** BEATS: ‹ value › on a roomy deck, one button that cycles through the choices on a narrow one. */
function BeatsStepper({ deck, presetId, index }: { deck: DeckId; presetId: string; index: number }) {
  const p = presetById(presetId);
  const value = p ? beatsValue(p, index) : null;
  const count = p?.beats?.options.length ?? 0;
  const label = value === null ? "—" : beatsLabel(value);
  const name = value === null ? "Αυτό το εφέ δεν έχει beats" : `Beats εφέ: ${label} (${beatsNote(value)})`;
  return (
    <>
      <div role="group" aria-label={name} title={name} className={cn("flex h-8 shrink-0 items-stretch overflow-hidden @max-[230px]/deckinfo:hidden", shell)}>
        <button type="button" aria-label="Λιγότερα beats" disabled={value === null || index <= 0} onClick={() => stepBeats(deck, -1)} className={stepClass}>
          <ChevronLeft aria-hidden className="size-3.5" />
        </button>
        <span aria-hidden className={cn("flex min-w-8 items-center justify-center px-0.5 font-mono text-[11px] font-semibold tabular-nums", value === null ? "text-cm-faint" : "text-cm-text")}>{label}</span>
        <button type="button" aria-label="Περισσότερα beats" disabled={value === null || index >= count - 1} onClick={() => stepBeats(deck, 1)} className={stepClass}>
          <ChevronRight aria-hidden className="size-3.5" />
        </button>
      </div>
      <button type="button" aria-label={name} title={name} disabled={value === null} onClick={() => setBeats(deck, (index + 1) % count)}
        className={cn("hidden h-8 min-w-8 shrink-0 items-center justify-center px-1 font-mono text-[11px] font-semibold tabular-nums text-cm-text outline-none select-none @max-[230px]/deckinfo:flex focus-visible:ring-2 focus-visible:ring-cm-cyan disabled:text-cm-faint enabled:active:bg-cm-contrast/12 motion-safe:transition-colors motion-safe:duration-150", shell)}>
        {label}
      </button>
    </>
  );
}

/**
 * One deck's FX row under the remaining time: preset picker (outer edge), FX button, BEATS and the WET knob (mixer side).
 * 48 px high: the 36 px WET knob with its name under it. Reads and writes only the fxRack store. States are static colour
 * changes, so the row never moves or resizes.
 */
export function FxRackRow({ deck, mirrored, track }: { deck: DeckId; mirrored: boolean; track: Track }) {
  const d = useFxRackDeck(deck);
  const available = useSyncExternalStore(subscribe, () => getFxRack().available, () => getFxRack().available);
  const preset = presetById(d.preset);
  const noBpm = effectiveBpm(track) == null;
  const blocked = !!preset && noBpm && needsBpm(preset);
  const title = !available ? UNAVAILABLE : blocked && !d.on ? NEEDS_BPM : d.releasing ? "Σβήνει στην επόμενη φράση" : FX_TITLE;
  return (
    <div role="group" aria-label={`Εφέ Deck ${deck}`} className={cn("flex h-12 min-w-0 shrink-0 items-center gap-1.5", mirrored && "flex-row-reverse")}>
      <FxRackPicker deck={deck} mirrored={mirrored} presetId={d.preset} noBpm={noBpm} disabled={!available} />
      <span className="relative shrink-0">
        {/* Pressable while on even without a BPM, so a running effect can always be turned off. */}
        <FxButton deck={deck} on={d.on} held={d.held} releasing={d.releasing} disabled={!available || (blocked && !d.on)} title={title} />
        {d.tail && <span role="img" aria-label="Ακούγεται ακόμα η ουρά του εφέ" title="Ακούγεται ακόμα η ουρά του εφέ"
          className={cn("pointer-events-none absolute -top-[3px] size-1.5 rounded-full bg-[var(--deck)]", mirrored ? "-left-[3px]" : "-right-[3px]")} />}
      </span>
      <BeatsStepper deck={deck} presetId={d.preset} index={deckBeatsIndex(d)} />
      {/* Saved at once when the knob is let go (pointer or key); otherwise the store saves after 500 ms idle. */}
      <div inert={!available} onPointerUp={saveFxRackNow} onKeyUp={saveFxRackNow} className={cn("shrink-0 [--cm-knob:36px]", !available && "opacity-40")}>
        <Knob unipolar label="WET" ariaLabel={`Ποσότητα εφέ, Deck ${deck}`} value={d.amount * 2 - 1}
          valueText={v => `${Math.round((v + 1) * 50)} %`} onChange={v => setAmount(deck, (v + 1) / 2)} />
      </div>
    </div>
  );
}
