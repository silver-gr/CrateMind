import type { ComponentType } from "react";
import { cn } from "../../lib/cn";
import { ArrowRight, Ban, Blend, Play, WandSparkles } from "../../lib/icons";
import type { ChipTone } from "../../lib/queryChips";
import { CHIP } from "../../lib/tones";
import { MIX_COPY, describeAuto, presetLabel } from "../../lib/transitions/copy";
import type { SetTransition } from "../../lib/transitions/types";
import { Badge } from "../ui/badge";

interface Props {
  transition: SetTransition;
  /** Both tracks can play on the stretch engine; otherwise the pair is cut, never mixed. */
  mixable: boolean;
  onEdit?: () => void;
  /** Absent: no preview control is rendered. */
  onPreview?: () => void;
}

interface Look { label: string; title: string; tone: ChipTone; icon: ComponentType<{ className?: string }> }

/** Label, tooltip, tone and glyph for one pair. Every string comes from `copy.ts`; keys and reason codes never surface. */
function pillLook(t: SetTransition, mixable: boolean): Look {
  const label = presetLabel(t.preset, t.resolved_preset);
  if (!mixable) return { label: MIX_COPY.unmixable, title: `${MIX_COPY.unmixable} · ${label}`, tone: "rose", icon: Ban };
  if (t.preset === "auto") return { label, title: describeAuto(t.reasons) || label, tone: "cyan", icon: WandSparkles };
  if (t.preset === "none") return { label, title: t.persisted ? MIX_COPY.savedTransition : label, tone: "muted", icon: ArrowRight };
  return { label, title: t.persisted ? MIX_COPY.savedTransition : label, tone: "blue", icon: Blend };
}

/** The transition between two set rows: a preview button (revealed on row hover, keyboard focus and touch) and the pill that opens the editor. */
export function TransitionPill({ transition, mixable, onEdit, onPreview }: Props) {
  const { label, title, tone, icon: Icon } = pillLook(transition, mixable);
  return (
    <span className="inline-flex items-center gap-1">
      {onPreview && (
        <button
          type="button"
          onClick={onPreview}
          disabled={!mixable}
          aria-label={MIX_COPY.previewTransition}
          title={MIX_COPY.previewTransition}
          className={cn(
            // 20 px glyph, 32 px hit area via the pseudo-element.
            "relative grid h-5 w-5 shrink-0 cursor-pointer place-items-center rounded-full bg-cm-cyan/12 text-cm-cyan before:absolute before:-inset-1.5 before:content-['']",
            "opacity-0 transition-[opacity,transform,background-color] duration-150 ease-out hover:bg-cm-cyan/20 active:scale-[0.94] motion-reduce:active:scale-100",
            "group-hover/connector:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-cyan [@media(hover:none)]:opacity-100",
            "disabled:cursor-not-allowed disabled:bg-cm-line/5 disabled:text-cm-faint disabled:active:scale-100",
          )}
        >
          <Play aria-hidden="true" className="ml-px h-2.5 w-2.5" />
        </button>
      )}
      <Badge asChild variant="outline" className={cn("cursor-pointer px-2 py-0.5 transition-[filter,transform] duration-150 ease-out hover:brightness-125 active:scale-[0.97] motion-reduce:active:scale-100 disabled:cursor-default", CHIP[tone])}>
        <button
          type="button"
          data-transition-pill
          data-persisted={transition.persisted || undefined}
          onClick={onEdit}
          disabled={!onEdit}
          title={title}
          aria-label={`${MIX_COPY.editorTitle}: ${label}`}
        >
          <Icon aria-hidden="true" className="h-3 w-3" />
          {label}
        </button>
      </Badge>
    </span>
  );
}
