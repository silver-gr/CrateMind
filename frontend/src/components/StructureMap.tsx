import { cn } from "../lib/cn";
import { formatBars, formatClock, mapBlocks, SECTION_LABELS, type StructureSection } from "../lib/trackStructure";

/**
 * A track's sections along its length: a filled block where the bass plays, a hollow one where it does not, each as
 * tall as that part is loud. With `phrases`, a hairline at every phrase line and a stronger one where the bass comes in.
 */
export function StructureMap({ sections, duration, phrases, anchors, className }: {
  sections: StructureSection[];
  duration: number;
  phrases?: readonly number[];
  anchors?: readonly number[];
  className?: string;
}) {
  const blocks = mapBlocks(sections, duration);
  const strong = new Set(anchors);
  return (
    <div role="img" aria-label="Δομή κομματιού: μέρη με και χωρίς μπάσο" className={cn("relative w-full overflow-hidden rounded-md bg-cm-contrast/5", className)}>
      {blocks.map((b, i) => (
        <div key={i} title={`${SECTION_LABELS[b.kind]} · ${formatClock(sections[i].start_s)} · ${formatBars(sections[i].beats)}`}
          className="absolute bottom-0 px-px" style={{ left: `${b.left * 100}%`, width: `${b.width * 100}%`, height: `${Math.round((0.3 + 0.7 * b.level) * 100)}%` }}>
          <div className={cn("size-full rounded-[3px]", b.bass ? "bg-cm-cyan/65" : "border border-cm-contrast/25 bg-cm-contrast/8")} />
        </div>
      ))}
      {duration > 0 && phrases?.map(t => (
        <span key={t} aria-hidden className={cn("pointer-events-none absolute inset-y-0 w-px", strong.has(t) ? "bg-cm-text/75" : "bg-cm-text/25")}
          style={{ left: `${Math.min(100, (t / duration) * 100)}%` }} />
      ))}
    </div>
  );
}
