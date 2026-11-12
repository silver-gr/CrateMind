import type { ComponentType, ReactNode } from "react";
import { Button } from "../ui/button";
import { PageHeader as SharedPageHeader } from "../ui/PageHeader";
import { ChevronLeft, ChevronRight } from "../../lib/icons";
import { CHIP } from "../../lib/tones";
import type { ChipTone } from "../../lib/queryChips";
import { cn } from "../../lib/cn";

/** Shared look for the «Συλλογές» screens: one page shell, glass panels, Greek-grouped counts.
 *  PAGE_SHELL holds the PageHeader above PAGE, the scrolling body. */
export const PAGE_SHELL = "flex h-full flex-col text-cm-text";
export const PAGE = "cm-collections scroll-fade-y h-full min-h-0 flex-1 space-y-5 overflow-y-auto p-5 text-cm-text";
export const PANEL = "glass rounded-2xl";
export const LINK = "text-cm-cyan underline-offset-2 hover:underline";
/** Header strip of a list panel: count on the left, pager on the right. */
export const PANEL_BAR =
  "flex min-h-11 items-center justify-between gap-3 border-b border-cm-border px-4 py-2 text-xs text-cm-muted [&>:first-child]:min-w-0";

/** Counts with Greek thousands separators (19.954). */
export const fmt = (value: number | null | undefined) => (value ?? 0).toLocaleString("el-GR");

/** ISO timestamps as a Greek date and time (8 Οκτ 2024, 07:33); text that is not a date is shown as given. */
export const fmtDate = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("el-GR", { dateStyle: "medium", timeStyle: "short" });
};

/** Service keys as the user knows them; unknown keys fall back to a neutral word, never the raw key. */
export const SERVICE_LABELS: Record<string, string> = {
  local: "Τοπικά αρχεία",
  spotify: "Spotify",
  soundcloud: "SoundCloud",
  cratemind: "CrateMind",
};
export const serviceLabel = (service: string | null | undefined) => (service && SERVICE_LABELS[service]) || "Πηγή";

/** The shared PageHeader; `children` is its subtitle. */
export function PageHeader({
  icon,
  title,
  actions,
  children,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return <SharedPageHeader icon={icon} title={title} actions={actions} subtitle={children} />;
}

/** Small tinted pill for a status word. */
export function Pill({ tone, children, className }: { tone: ChipTone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-1.5 py-px text-[10px] font-medium whitespace-nowrap",
        CHIP[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Previous/next with the visible range; `limit` is the page size the endpoint uses. */
export function Pager({
  offset,
  limit,
  total,
  onChange,
  disabled,
}: {
  offset: number;
  limit: number;
  total: number;
  onChange: (offset: number) => void;
  disabled?: boolean;
}) {
  const end = Math.min(offset + limit, total);
  return (
    <div className="flex shrink-0 items-center gap-1">
      <span className="mr-1 whitespace-nowrap font-mono text-[11px] tabular-nums text-cm-faint">
        {total ? `${fmt(offset + 1)}–${fmt(end)}` : "0"}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Προηγούμενα"
        title="Προηγούμενα"
        disabled={disabled || offset === 0}
        onClick={() => onChange(Math.max(0, offset - limit))}
      >
        <ChevronLeft />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Επόμενα"
        title="Επόμενα"
        disabled={disabled || offset + limit >= total}
        onClick={() => onChange(offset + limit)}
      >
        <ChevronRight />
      </Button>
    </div>
  );
}
