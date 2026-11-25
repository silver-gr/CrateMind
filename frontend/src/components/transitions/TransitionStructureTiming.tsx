import { useId } from "react";
import { STRUCTURE_COPY } from "../../lib/transitions/copy";
import { Switch } from "../ui/switch";

/**
 * «Χρονισμός από τη δομή»: one switch for every transition (a preference, not part of the draft), so it stays usable
 * on a «Χωρίς μετάβαση» pair. `hint` says what the structure decided for this pair, per side.
 */
export function TransitionStructureTiming({ on, onChange, hint }: { on: boolean; onChange(on: boolean): void; hint: string | null }) {
  const switchId = useId();
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Switch id={switchId} checked={on} onCheckedChange={onChange} />
        <label htmlFor={switchId} className="cursor-pointer text-xs font-medium text-cm-text">
          {STRUCTURE_COPY.toggle}<span className="font-normal text-cm-muted"> · {STRUCTURE_COPY.scope}</span>
        </label>
      </div>
      {hint && <p className="text-[11px] text-cm-muted">{hint}</p>}
    </div>
  );
}
