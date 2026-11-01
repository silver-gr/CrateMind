import { useEffect, useRef } from "react";
import { Slider } from "./ui/slider";
import { cn } from "@/lib/cn";
import { faderRate, formatPitchPercent, setDeckBend, setDeckPitch, type DeckFx } from "../lib/mixer";
import type { DeckId } from "../lib/player";

const REPLAY_HINT = "Φόρτωσε ξανά το track για pitch/key lock";
const btnClass = "flex h-6 w-full items-center justify-center rounded border border-cm-line/20 bg-white/5 font-mono text-xs leading-none text-cm-muted select-none touch-none hover:bg-cm-cyan/10 hover:text-cm-cyan focus-visible:outline-2 focus-visible:outline-cm-cyan cursor-pointer active:bg-cm-cyan/20 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10";

/** Momentary bend: held by pointer or Space/Enter, always released on leave, cancel, blur or unmount. */
function BendButton({ deck, dir, disabled }: { deck: DeckId; dir: -1 | 1; disabled: boolean }) {
  const held = useRef(false);
  const press = () => { if (!held.current) { held.current = true; setDeckBend(deck, dir, performance.now()); } };
  const release = () => { if (held.current) { held.current = false; setDeckBend(deck, 0, 0); } };
  const releaseRef = useRef(release);
  releaseRef.current = release;
  useEffect(() => {
    const onBlur = () => releaseRef.current();
    window.addEventListener("blur", onBlur);
    return () => { window.removeEventListener("blur", onBlur); releaseRef.current(); };
  }, []);
  useEffect(() => { if (disabled) releaseRef.current(); }, [disabled]);
  const sign = dir < 0 ? "−" : "+";
  return (
    <button type="button" data-hold-key disabled={disabled} title={disabled ? REPLAY_HINT : `Bend ${sign}`}
      aria-label={`Bend ${sign} Deck ${deck}`} className={btnClass}
      onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); press(); }}
      onPointerUp={release} onBlur={release} onPointerCancel={release} onPointerLeave={release} onLostPointerCapture={release}
      onKeyDown={e => { if (e.code === "Space" || e.code === "Enter") { e.preventDefault(); if (!e.repeat) press(); } }}
      onKeyUp={e => { if (e.code === "Space" || e.code === "Enter") { e.preventDefault(); release(); } }}>
      {sign}
    </button>
  );
}

/** Pitch fader, ± range label, signed readout, bend buttons and KEY badge for one deck. */
export function PitchStrip({ deck, fx, active, className }: { deck: DeckId; fx: DeckFx; active: boolean; className?: string }) {
  return (
    <div className={cn("flex h-full w-11 shrink-0 flex-col items-center justify-center gap-1 py-1", className)} title={active ? undefined : REPLAY_HINT}>
      <span className="font-mono text-[9px] leading-none text-cm-faint">±{Math.round(fx.range * 100)}%</span>
      <Slider orientation="vertical" min={-1} max={1} step={0.005} value={[fx.pitch]} disabled={!active}
        onValueChange={([v]) => setDeckPitch(deck, v)} onDoubleClick={() => setDeckPitch(deck, 0)}
        className="min-h-0 flex-1 cursor-pointer data-[orientation=vertical]:min-h-0 [&_[data-slot=slider-track]]:bg-cm-border-hi [&_[data-slot=slider-range]]:bg-transparent [&_[data-slot=slider-thumb]]:h-2 [&_[data-slot=slider-thumb]]:w-4 [&_[data-slot=slider-thumb]]:rounded-sm [&_[data-slot=slider-thumb]]:border-cm-cyan [&_[data-slot=slider-thumb]]:bg-cm-cyan"
        aria-label={`Pitch Deck ${deck}`} aria-valuetext={formatPitchPercent(faderRate(fx))} />
      <span className="font-mono text-[10px] leading-none tabular-nums text-cm-text">{formatPitchPercent(faderRate(fx))}</span>
      <div className="flex w-full gap-0.5">
        <BendButton deck={deck} dir={-1} disabled={!active} />
        <BendButton deck={deck} dir={1} disabled={!active} />
      </div>
      <span className={cn("rounded bg-cm-cyan/15 px-1 font-mono text-[9px] font-semibold leading-4 text-cm-cyan", !(active && fx.keylock) && "invisible")}>KEY</span>
    </div>
  );
}
