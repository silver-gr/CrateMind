import { SlidersHorizontal, WandSparkles } from "../../lib/icons";
import { CONTROL_COPY, PRESET_LABELS } from "../../lib/transitions/copy";
import type { Preset } from "../../lib/transitions/types";
import { SmartChip } from "../ui/SmartChip";

/** Spotify's order: Custom (only while custom), Auto, the named presets, No transition last. */
export const PRESET_ORDER = ["custom", "auto", "fade", "rise", "blend", "wave", "melt", "slam", "dissolve", "surge", "afterglow", "none"] as const satisfies readonly Preset[];

const ICONS: Partial<Record<Preset, typeof WandSparkles>> = { auto: WandSparkles, custom: SlidersHorizontal };

/** The preset row: one toggle chip per preset, the active one cyan. `data-transition-presets` is the editor's initial-focus target.
 *  `autoLocked` (a saved non-Auto row): the Auto chip is aria-disabled with a hint; its click still reaches `onChange`. */
export function TransitionPresets({ value, onChange, autoLocked = false }: { value: Preset; onChange(p: Preset): void; autoLocked?: boolean }) {
  return (
    <div role="group" aria-label={CONTROL_COPY.presets} data-transition-presets className="flex flex-wrap items-center gap-1.5">
      {PRESET_ORDER.filter(p => p !== "custom" || value === "custom").map(p => (
        <SmartChip
          key={p}
          tone={p === value ? "cyan" : "muted"}
          icon={ICONS[p]}
          pressed={p === value}
          ariaDisabled={p === "auto" && autoLocked}
          title={p === "auto" && autoLocked ? CONTROL_COPY.autoLocked : undefined}
          onClick={() => { if (p !== value) onChange(p); }}
          className="h-7 active:scale-[0.97] motion-reduce:active:scale-100"
        >
          {PRESET_LABELS[p]}
        </SmartChip>
      ))}
    </div>
  );
}
