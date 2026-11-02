import { cn } from "../lib/cn";
import { CHIP } from "../lib/tones";
import type { Facet, FacetValue } from "../lib/types";
import type { KeyboardEvent } from "react";

/** The radio to focus after a key in a radio group (wrapping), or null for keys the group does not handle. */
export function nextRadioIndex(key: string, index: number, count: number): number | null {
  if (key === "ArrowRight" || key === "ArrowDown") return (index + 1) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

/** Arrow keys move focus within a radio group; Space or Enter then chooses (each choice is a write). */
function onRadioKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
  const radios = [...(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])];
  const next = nextRadioIndex(event.key, radios.indexOf(event.currentTarget), radios.length);
  if (next === null) return;
  event.preventDefault();
  event.stopPropagation();
  radios[next].focus();
}

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
            {facet.values.map((value, index) => {
              const on = selected.has(value.id);
              // Roving tab stop: the checked radio, else the first one.
              const tabStop = on || (index === 0 && !facet.values.some(v => selected.has(v.id)));
              const a11y = facet.multi
                ? { "aria-pressed": on }
                : { role: "radio" as const, "aria-checked": on, tabIndex: tabStop ? 0 : -1, onKeyDown: onRadioKeyDown };
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
