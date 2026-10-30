import { useState } from "react";
import { cn } from "../lib/cn";
import { SettingsIcon } from "../lib/icons";
import type { CuePadSlots } from "../lib/cuePads";
import { CUE_KIND_LABELS, cueColor, CueEditor, formatCueTime, PlayerCues, type CueState } from "./PlayerCues";
import type { TrackCueKind } from "../lib/types";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

export function CuePads({ trackId, state, slots, canCapture, canSeek, onCapture, onSeek, onAssign, onCreate, className }: {
  className?: string;
  trackId: number;
  state: CueState;
  slots: CuePadSlots;
  canCapture: boolean;
  canSeek: boolean;
  onCapture: (kind: TrackCueKind) => void;
  onSeek: (positionMs: number) => void;
  onAssign: (slot: number, cueId: number | null) => void;
  onCreate: (slot: number) => Promise<void>;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [pendingSlot, setPendingSlot] = useState<number | null>(null);
  return (
    <div data-player-cues data-cue-pad-bank className={cn("flex h-[128px] max-h-full min-h-0 min-w-[240px] max-w-[664px] flex-[1_1_664px] self-center flex-col", className)}>
      <div className="grid min-h-0 flex-1 grid-cols-4 grid-rows-2 gap-2 @max-4xl/player:gap-1.5" role="group" aria-label="Cue pads 1–8">
        {slots.map((id, index) => {
          const cue = state.cues.find(cue => cue.id === id);
          const pending = pendingSlot === index || (cue ? state.pendingCueIds.has(cue.id) : state.pendingKinds.has("cue"));
          return (
            <div key={index} data-cue-id={cue?.id} data-cue-number={index + 1} style={{ "--pad-color": cueColor(index + 1).colorValue } as React.CSSProperties}
              className={cn("relative isolate rounded-lg border border-[var(--pad-color)]/40 bg-cm-panel-2 shadow-[0_3px_0_color-mix(in_srgb,var(--pad-color)_25%,var(--color-cm-panel)),0_5px_9px_#0002] transition-[opacity,box-shadow]", !cue && "opacity-45 hover:opacity-80")}>
              <button data-cue-pad type="button" disabled={pending || (!cue ? !canCapture || !state.loaded : !canSeek)}
                aria-label={cue ? `Pad ${index + 1}: ${CUE_KIND_LABELS[cue.kind]} ${formatCueTime(cue.position_ms)}` : `Ανάθεση pad ${index + 1} στο τρέχον σημείο`}
                title={cue ? `${cue.label || CUE_KIND_LABELS[cue.kind]} · πλήκτρο ${index + 1}` : "Πάτησε για cue στο τρέχον σημείο"}
                onClick={() => {
                  if (cue) onSeek(cue.position_ms);
                  else { setPendingSlot(index); Promise.resolve(onCreate(index)).finally(() => setPendingSlot(null)); }
                }}
                className="flex h-full min-h-0 w-full flex-col items-start justify-between rounded-lg bg-[linear-gradient(145deg,color-mix(in_srgb,var(--pad-color)_22%,transparent),transparent)] p-2 text-[var(--pad-color)] outline-none transition-transform active:translate-y-0.5 focus-visible:ring-2 focus-visible:ring-cm-cyan disabled:cursor-default @max-4xl/player:p-1.5">
                <span className="max-w-full truncate pr-4 text-[11px] font-bold leading-none">{index + 1}<span className="ml-1 text-[8px] font-medium">{cue ? cue.kind !== "cue" ? CUE_KIND_LABELS[cue.kind] : "" : "+"}</span></span>
                <span className="font-mono text-[10px] leading-none tabular-nums @max-4xl/player:text-[8px]">{cue ? formatCueTime(cue.position_ms) : "—:—.———"}</span>
              </button>
              <Popover open={editing === index} onOpenChange={open => setEditing(open ? index : null)}>
                <PopoverTrigger asChild>
                  <button type="button" disabled={pending} title={`Ρυθμίσεις pad ${index + 1}`} aria-label={`Ρυθμίσεις pad ${index + 1}`} className="absolute right-0 top-0 rounded-md p-1.5 text-cm-muted hover:text-cm-text focus-visible:outline-2 focus-visible:outline-cm-cyan"><SettingsIcon className="size-2.5" /></button>
                </PopoverTrigger>
                <PopoverContent data-player-cues side="top" align="end" className="w-[320px] max-w-[calc(100vw-24px)] p-3">
                  <p className="mb-2 text-sm font-semibold">Pad {index + 1}</p>
                  {cue && <CueEditor key={cue.id} cue={cue} ordinal={index + 1} state={state} onClose={() => setEditing(null)} />}
                  <label className="mt-2 block text-xs text-cm-muted">Ανάθεση αποθηκευμένου cue
                    <Select value={cue ? String(cue.id) : "empty"} disabled={state.loading}
                      onValueChange={value => { onAssign(index, value === "empty" ? null : Number(value)); setEditing(null); }}>
                      <SelectTrigger aria-label={`Ανάθεση cue στο pad ${index + 1}`} size="sm" className="mt-1 w-full text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent data-player-cues>
                        <SelectItem value="empty">Κενό pad (το cue διατηρείται)</SelectItem>
                        {state.cues.map(item => <SelectItem key={item.id} value={String(item.id)}>{CUE_KIND_LABELS[item.kind]} {formatCueTime(item.position_ms)}{item.label ? ` · ${item.label}` : ""}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </label>
                  <div className="mt-3 border-t border-cm-line/15 pt-3">
                    <p className="mb-2 text-xs text-cm-muted">Διαχείριση σημείων ακρόασης</p>
                    <PlayerCues slots={slots} trackId={trackId} state={state} canCapture={canCapture} canSeek={canSeek} onCapture={onCapture} onSeek={onSeek} />
                  </div>
                </PopoverContent>
              </Popover>
            </div>
          );
        })}
      </div>
    </div>
  );
}
