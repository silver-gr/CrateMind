import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { cn } from "../lib/cn";
import { formatBars, formatClock, mapBlocks, sectionKinds, SECTION_LABELS, structureSummary, type StructureSection } from "../lib/trackStructure";

/** Rows the hover card lists before it says how many more there are. */
const MAX_ROWS = 12;

/**
 * A track's shape in one line of a list: a full-height block where the bass plays, a low one where it does not.
 * Hover shows the summary and every part with its start and length.
 */
export function StructureStrip({ sections, duration, className }: { sections: StructureSection[]; duration: number; className?: string }) {
  const blocks = mapBlocks(sections, duration);
  const kinds = sectionKinds(sections);
  const summary = structureSummary(sections);
  return (
    <Tooltip delayDuration={250}>
      <TooltipTrigger asChild>
        <div role="img" aria-label={`Δομή: ${summary}`} className={cn("relative h-2.5 w-full", className)}>
          {blocks.map((b, i) => (
            <span key={i} aria-hidden className={cn("absolute bottom-0 rounded-[1.5px] transition-colors duration-150",
              b.bass ? "h-full bg-cm-text/40 group-hover/row:bg-cm-text/60" : "h-[3px] bg-cm-contrast/20 group-hover/row:bg-cm-contrast/30")}
              style={{ left: `${b.left * 100}%`, width: `max(1px, calc(${b.width * 100}% - 1px))` }} />
          ))}
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" className="max-w-none px-3 py-2 text-left text-wrap">
        <p className="font-medium text-cm-text">{summary}</p>
        <ol className="mt-1.5 grid grid-cols-[auto_auto_auto] justify-start gap-x-3 gap-y-0.5 font-mono text-[11px] tabular-nums">
          {sections.slice(0, MAX_ROWS).map((section, i) => (
            <li key={i} className="contents">
              <span className="text-cm-muted">{formatClock(section.start_s)}</span>
              <span className={section.bass ? "text-cm-text" : "text-cm-muted"}>{SECTION_LABELS[kinds[i]]}</span>
              <span className="text-right text-cm-muted">{formatBars(section.beats)}</span>
            </li>
          ))}
        </ol>
        {sections.length > MAX_ROWS && <p className="mt-1 text-[11px] text-cm-faint">+{sections.length - MAX_ROWS} ακόμη μέρη</p>}
      </TooltipContent>
    </Tooltip>
  );
}
