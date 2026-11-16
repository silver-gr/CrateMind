import { cn } from "../../lib/cn";
import { ChevronLeft, ChevronRight } from "../../lib/icons";
import { visiblePages } from "../../lib/paging";

const BUTTON = "inline-flex h-7 min-w-7 cursor-pointer items-center justify-center rounded-md px-1.5 font-mono text-xs tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-cyan/60 disabled:cursor-not-allowed disabled:opacity-40";
const IDLE = "text-cm-muted hover:bg-cm-contrast/8 hover:text-cm-text";

/** Numbered pages (at most 8, no ellipsis) with ‹ ›; nothing when there is a single page. */
export function Pager({ page, pageCount, onPage, className }: {
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
  className?: string;
}) {
  if (pageCount <= 1) return null;
  return (
    <nav aria-label="Σελίδες προτάσεων" className={cn("flex items-center gap-0.5", className)}>
      <button type="button" aria-label="Προηγούμενη σελίδα" disabled={page <= 1}
        onClick={() => onPage(page - 1)} className={cn(BUTTON, IDLE)}>
        <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {visiblePages(page, pageCount).map(n => (
        <button key={n} type="button" aria-current={n === page ? "page" : undefined}
          onClick={() => onPage(n)}
          className={cn(BUTTON, n === page ? "bg-cm-cyan/15 font-semibold text-cm-cyan ring-1 ring-cm-cyan/30" : IDLE)}>
          {n}
        </button>
      ))}
      <button type="button" aria-label="Επόμενη σελίδα" disabled={page >= pageCount}
        onClick={() => onPage(page + 1)} className={cn(BUTTON, IDLE)}>
        <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </nav>
  );
}
