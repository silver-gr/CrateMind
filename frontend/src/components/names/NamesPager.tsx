import { Button } from "../ui/button";
import { rangeText } from "../../lib/names";
import { ChevronLeft, ChevronRight } from "../../lib/icons";

/** «‹ 101–200 από 1.234 ›» under a long list; nothing when everything fits on one page. */
export function NamesPager({ offset, limit, shown, total, onOffset, label }: {
  offset: number;
  limit: number;
  shown: number;
  total: number;
  onOffset: (offset: number) => void;
  label: string;
}) {
  if (total <= limit) return null;
  return (
    <nav aria-label={label} className="mt-3 flex items-center justify-end gap-2 text-xs text-cm-muted">
      <Button size="icon-sm" variant="ghost" aria-label="Προηγούμενη σελίδα" disabled={offset <= 0}
        onClick={() => onOffset(Math.max(0, offset - limit))}>
        <ChevronLeft />
      </Button>
      <span className="font-mono tabular-nums" aria-live="polite">{rangeText(offset, shown, total)}</span>
      <Button size="icon-sm" variant="ghost" aria-label="Επόμενη σελίδα" disabled={offset + limit >= total}
        onClick={() => onOffset(offset + limit)}>
        <ChevronRight />
      </Button>
    </nav>
  );
}
