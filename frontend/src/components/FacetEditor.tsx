import { cn } from "../lib/cn";
import { CHIP } from "../lib/tones";
import type { Facet, FacetValue } from "../lib/types";

/**
 * One row of chips per vocabulary. Single-value vocabularies are radio groups
 * (choosing a value replaces the old one on the server); multi-value ones are
 * toggle buttons. Only labels and values are shown, never the internal key.
 */
export function FacetEditor({
  facets,
  selected,
  onToggle,
  disabled,
}: {
  facets: Facet[];
  selected: ReadonlySet<number>;
  onToggle(facet: Facet, value: FacetValue, next: boolean): void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-3">
      {facets.map(facet => (
        <div key={facet.id}>
          <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-cm-faint">{facet.label}</div>
          <div
            role={facet.multi ? "group" : "radiogroup"}
            aria-label={facet.label}
            className="flex flex-wrap gap-1.5"
          >
            {facet.values.length === 0 && <span className="text-xs text-cm-faint">Καμία τιμή ακόμη</span>}
            {facet.values.map(value => {
              const on = selected.has(value.id);
              const a11y = facet.multi
                ? { "aria-pressed": on }
                : { role: "radio" as const, "aria-checked": on };
              return (
                <button
                  key={value.id}
                  type="button"
                  {...a11y}
                  disabled={disabled}
                  onClick={() => onToggle(facet, value, !on)}
                  className={cn(
                    "cursor-pointer rounded-full border px-2.5 py-1 text-xs transition hover:brightness-125 disabled:cursor-not-allowed disabled:opacity-50",
                    on ? CHIP.violet : CHIP.muted,
                    on && "ring-1 ring-cm-violet/50",
                  )}
                >{value.value}</button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
