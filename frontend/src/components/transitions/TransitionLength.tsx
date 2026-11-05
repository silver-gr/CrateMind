import { useId, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { ChevronLeft, ChevronRight } from "../../lib/icons";
import { CONTROL_COPY, MIX_COPY } from "../../lib/transitions/copy";
import { BAR_STEPS, barsLabel } from "../../lib/transitions/dualWaveform";
import { BARS_MAX, BARS_MIN } from "../../lib/transitions/types";
import { Button } from "../ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";

type Dir = 1 | -1;
type Unit = "bar" | "beat";

export const BAR_PRESETS = BAR_STEPS;

/** The preset lengths plus the current one, so a length reached with ±1 bar or a drag stays selectable. */
export function barOptions(bars: number): number[] {
  return [...new Set([...BAR_PRESETS, bars])].filter(b => b >= BARS_MIN && b <= BARS_MAX).sort((a, b) => a - b);
}

/** The incoming deck's playback rate as Greek percent text: 0.9524 → «95,2 %». */
export const formatRate = (rate: number | null) =>
  rate == null || !Number.isFinite(rate) ? "—" : `${(rate * 100).toFixed(1).replace(".", ",")} %`;

const press = "active:scale-[0.97] motion-reduce:active:scale-100";

function Nudge({ label, onClick, disabled, children }: { label: string; onClick(): void; disabled?: boolean; children: ReactNode }) {
  return (
    <Button type="button" variant="outline" size="sm" aria-label={label} title={label} disabled={disabled} onClick={onClick}
      className={cn("h-8 min-w-0 flex-1 gap-0.5 px-2 font-mono text-[11px] tabular-nums", press)}>
      {children}
    </Button>
  );
}

const Section = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex flex-col gap-1.5">
    <span className="text-[11px] font-medium text-cm-muted">{label}</span>
    <div className="flex items-center gap-1.5">{children}</div>
  </div>
);

/**
 * Window length, window and incoming-offset nudges, tempo match. Every drag on the waveform has a single-pointer
 * alternative here (WCAG 2.5.7): ±1 bar reaches every length 1..32, the nudges move by a bar or a beat.
 */
export function TransitionLength({ bars, onBars, onNudgeWindow, onNudgeIn, tempoMatch, onTempoMatch, rateText }: {
  bars: number;
  onBars(bars: number): void;
  onNudgeWindow(dir: Dir, unit: Unit): void;
  onNudgeIn(dir: Dir, unit: Unit): void;
  tempoMatch: boolean;
  onTempoMatch(on: boolean): void;
  rateText: string;
}) {
  const switchId = useId();
  const left = <ChevronLeft aria-hidden="true" className="size-3" />;
  const right = <ChevronRight aria-hidden="true" className="size-3" />;
  return (
    <div className="flex flex-col gap-2.5">
      <Section label={CONTROL_COPY.length}>
        <Nudge label={CONTROL_COPY.barsLess} disabled={bars <= BARS_MIN} onClick={() => onBars(Math.max(BARS_MIN, bars - 1))}>−1 bar</Nudge>
        <Select value={String(bars)} onValueChange={v => onBars(Number(v))}>
          <SelectTrigger size="sm" aria-label={CONTROL_COPY.bars} className="min-w-0 flex-[1.4] font-mono text-xs tabular-nums">
            <SelectValue>{barsLabel(bars)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {barOptions(bars).map(b => <SelectItem key={b} value={String(b)} className="font-mono tabular-nums">{barsLabel(b)}</SelectItem>)}
          </SelectContent>
        </Select>
        <Nudge label={CONTROL_COPY.barsMore} disabled={bars >= BARS_MAX} onClick={() => onBars(Math.min(BARS_MAX, bars + 1))}>+1 bar</Nudge>
      </Section>
      <Section label={CONTROL_COPY.window}>
        <Nudge label={CONTROL_COPY.windowBarBack} onClick={() => onNudgeWindow(-1, "bar")}>{left}bar</Nudge>
        <Nudge label={CONTROL_COPY.windowBeatBack} onClick={() => onNudgeWindow(-1, "beat")}>{left}beat</Nudge>
        <Nudge label={CONTROL_COPY.windowBeatFwd} onClick={() => onNudgeWindow(1, "beat")}>beat{right}</Nudge>
        <Nudge label={CONTROL_COPY.windowBarFwd} onClick={() => onNudgeWindow(1, "bar")}>bar{right}</Nudge>
      </Section>
      <Section label={CONTROL_COPY.incoming}>
        <Nudge label={CONTROL_COPY.inBeatBack} onClick={() => onNudgeIn(-1, "beat")}>{left}beat</Nudge>
        <Nudge label={CONTROL_COPY.inBeatFwd} onClick={() => onNudgeIn(1, "beat")}>beat{right}</Nudge>
      </Section>
      <div className="flex items-center gap-2 pt-0.5">
        <Switch id={switchId} checked={tempoMatch} onCheckedChange={onTempoMatch} />
        <label htmlFor={switchId} className="cursor-pointer text-xs font-medium text-cm-text">{MIX_COPY.tempoMatch}</label>
        <span title={CONTROL_COPY.rate} className={cn("ml-auto font-mono text-xs tabular-nums", tempoMatch ? "text-cm-cyan" : "text-cm-faint")}>{rateText}</span>
      </div>
    </div>
  );
}
