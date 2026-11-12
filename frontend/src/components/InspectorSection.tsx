import type { ReactNode } from "react";
import { ChevronDown } from "../lib/icons";

export function InspectorSection({ title, description, children }: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <details className="group/inspector min-w-0">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-3 py-2.5 hover:bg-cm-contrast/5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-cm-cyan [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 wrap-anywhere">
          <span className="block text-xs font-semibold text-cm-text">{title}</span>
          {description && <span className="mt-0.5 block text-[11px] leading-snug text-cm-muted">{description}</span>}
        </span>
        <ChevronDown aria-hidden="true" className="size-4 shrink-0 -rotate-90 text-cm-muted group-open/inspector:rotate-0" />
      </summary>
      <div className="min-w-0 px-3 pb-3 pt-1">{children}</div>
    </details>
  );
}
