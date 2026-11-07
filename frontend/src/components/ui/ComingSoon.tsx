import { type ComponentType } from "react";
import { Sparkles } from "@/lib/icons";
import { GlassPanel } from "./GlassPanel";

/**
 * Placeholder page for sidebar sections that aren't backed by data/DSP yet
 * (Smart Folders, Phrase Finder). Honest "σύντομα" stub — never fakes data.
 */
export function ComingSoon({
  title,
  description,
  icon: Icon = Sparkles,
}: {
  title: string;
  description?: string;
  icon?: ComponentType<{ className?: string }>;
}) {
  return (
    <div className="grid h-full place-items-center p-8">
      <GlassPanel strong className="max-w-md p-8 text-center">
        <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-cm-violet/15 text-cm-violet glow-violet">
          <Icon className="h-7 w-7" />
        </div>
        <div className="mb-1 text-xl font-semibold tracking-tight text-cm-text">{title}</div>
        <div className="mb-4 inline-flex items-center gap-1.5 rounded-full border border-cm-contrast/10 bg-cm-contrast/5 px-2.5 py-0.5 text-[11px] uppercase tracking-wider text-cm-faint">
          <Sparkles className="h-3 w-3" /> σύντομα
        </div>
        {description && <p className="text-sm leading-relaxed text-cm-muted">{description}</p>}
      </GlassPanel>
    </div>
  );
}

export default ComingSoon;
