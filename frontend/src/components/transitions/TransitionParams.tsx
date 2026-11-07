import { useId } from "react";
import { cn } from "../../lib/cn";
import { EQ_LABELS, FILTER_LABELS, MIX_COPY, VOLUME_LABELS, loopLabel } from "../../lib/transitions/copy";
import { EQ_CURVES, FILTER_CURVES, LOOP_BEATS, VOLUME_CURVES, type LoopBeats, type TransitionParams as Params } from "../../lib/transitions/types";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

interface Option { value: string; label: string; disabled?: boolean }
type CurveKey = "volume_curve" | "eq_curve" | "filter_curve";

const opts = <K extends string>(keys: readonly K[], labels: Record<K, string>): Option[] => keys.map(k => ({ value: k, label: labels[k] }));

/** The three curve rows; `family` is the colour the waveform draws that curve in (volume blue, EQ amber, filter magenta). */
export const PARAM_FIELDS: readonly { key: CurveKey; label: string; family: string; options: Option[] }[] = [
  { key: "volume_curve", label: MIX_COPY.volume, family: "bg-cm-blue", options: opts(VOLUME_CURVES, VOLUME_LABELS) },
  { key: "eq_curve", label: MIX_COPY.eq, family: "bg-cm-amber", options: opts(EQ_CURVES, EQ_LABELS) },
  { key: "filter_curve", label: MIX_COPY.filter, family: "bg-cm-magenta", options: opts(FILTER_CURVES, FILTER_LABELS) },
];

/** «Χωρίς loop» then 1..16 beats; a loop longer than the window (4 beats per bar) is disabled, as the backend rejects it. */
export function loopOptions(bars: number): Option[] {
  return [
    { value: "none", label: loopLabel(null), disabled: false },
    ...LOOP_BEATS.map(b => ({ value: String(b), label: loopLabel(b), disabled: b > 4 * bars })),
  ];
}

function Field({ label, family, value, options, disabled, onValue }: {
  label: string; family: string; value: string; options: Option[]; disabled: boolean; onValue(v: string): void;
}) {
  const id = useId();
  const current = options.find(o => o.value === value)?.label ?? "";
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="flex items-center gap-1.5 text-[11px] font-medium text-cm-muted">
        <span aria-hidden="true" className={cn("h-3 w-[3px] rounded-full", family)}></span>{label}
      </label>
      <Select value={value} onValueChange={onValue} disabled={disabled}>
        <SelectTrigger id={id} size="sm" className="w-full min-w-0">
          <SelectValue>{current}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map(o => <SelectItem key={o.value} value={o.value} disabled={o.disabled}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Volume / EQ / filter curve and loop selects. Emits patches only; the editor decides when that makes the preset «Προσαρμογή». */
export function TransitionParams({ value, onChange }: { value: Params; onChange(patch: Partial<Params>): void }) {
  const cut = value.preset === "none";
  return (
    <div className="grid grid-cols-1 gap-x-3 gap-y-2.5 sm:grid-cols-2">
      {PARAM_FIELDS.map(f => (
        <Field key={f.key} label={f.label} family={f.family} value={value[f.key]} options={f.options} disabled={cut}
          onValue={v => onChange({ [f.key]: v } as Partial<Params>)} />
      ))}
      <Field label={MIX_COPY.loop} family="bg-cm-amber/50" value={value.loop_beats == null ? "none" : String(value.loop_beats)}
        options={loopOptions(value.bars)} disabled={cut}
        onValue={v => onChange({ loop_beats: v === "none" ? null : (Number(v) as LoopBeats) })} />
    </div>
  );
}
