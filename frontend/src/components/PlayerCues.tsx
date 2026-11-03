import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { cn } from "../lib/cn";
import { Loader2, Pin, SkipBack, SkipForward, Trash2 } from "../lib/icons";
import type { CuePadSlots } from "../lib/cuePads";
import type { useTrackCues } from "../lib/trackCues";
import type { TrackCue, TrackCueKind, TrackCueUpdate } from "../lib/types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

export type CueState = ReturnType<typeof useTrackCues>;

export const CUE_KIND_LABELS: Record<TrackCueKind, string> = {
  entry: "Entry",
  exit: "Exit",
  cue: "Cue",
};

const cueKinds: TrackCueKind[] = ["entry", "exit", "cue"];
const cueHints = { entry: "I", exit: "O", cue: "C" };
const cueDescriptions = {
  entry: "Σημείωσε το τρέχον σημείο για είσοδο στη μίξη",
  exit: "Σημείωσε το τρέχον σημείο για έξοδο από τη μίξη",
  cue: "Σημείωσε το τρέχον σημείο για να επιστρέψεις αργότερα",
};
const cuePointColors = [
  { colorClass: "text-cm-cyan", colorValue: "var(--color-cm-cyan)" },
  { colorClass: "text-cm-chartreuse", colorValue: "var(--color-cm-chartreuse)" },
  { colorClass: "text-cm-violet", colorValue: "var(--color-cm-violet)" },
];
export function cueColor(ordinal: number) {
  return cuePointColors[(ordinal - 1) % cuePointColors.length];
}

/** Big-waveform colours for cues on no pad, by kind. */
const CUE_KIND_COLORS: Record<string, string> = { entry: "#34d399", exit: "#fb7185", cue: "#22d3ee" };
/** A cue on a pad takes that pad's colour and number; any other cue keeps its kind colour and has no number. */
export function waveCueMarker(cue: TrackCue, slots?: CuePadSlots): { color: string; pad: number | null } {
  const slot = slots?.indexOf(cue.id) ?? -1;
  return slot >= 0 ? { color: cueColor(slot + 1).colorValue, pad: slot + 1 } : { color: CUE_KIND_COLORS[cue.kind] ?? CUE_KIND_COLORS.cue, pad: null };
}

/** Chronological reading order, with stable pad numbers when a layout is supplied.
 * Overflow begins at nine even when a lower pad is empty. */
export function cuePresentation(cues: TrackCue[], slots?: CuePadSlots) {
  let overflow = 9;
  return [...cues]
    .sort((a, b) => a.position_ms - b.position_ms || a.id - b.id)
    .map((cue, index) => {
      const slot = slots?.indexOf(cue.id) ?? -1;
      const ordinal = slots ? slot >= 0 ? slot + 1 : overflow++ : index + 1;
      return { cue, ordinal, colorClass: cueColor(ordinal).colorClass };
    });
}

export function formatCueTime(positionMs: number): string {
  const ms = Math.max(0, Math.round(positionMs));
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}

// Parse milliseconds as integers: 1:02.1 is 62,100ms, never a rounded float.
function parseCueTime(value: string): number | null {
  const match = /^(\d+):([0-5]\d)\.(\d{1,3})$/.exec(value);
  if (!match) return null;
  const ms = Number(match[1]) * 60_000 + Number(match[2]) * 1000 + Number(match[3].padEnd(3, "0"));
  return Number.isSafeInteger(ms) && ms >= 0 ? ms : null;
}

function CueGlyph({ kind, className }: { kind: TrackCueKind; className?: string }) {
  const Icon = kind === "entry" ? SkipBack : kind === "exit" ? SkipForward : Pin;
  return <Icon aria-hidden="true" className={cn("size-3 shrink-0", className)} />;
}

function cueDescription(cue: TrackCue, ordinal: number) {
  return `${ordinal} · ${CUE_KIND_LABELS[cue.kind]} ${formatCueTime(cue.position_ms)}${cue.label ? ` — ${cue.label}` : ""}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Δεν αποθηκεύτηκε η αλλαγή. Δοκίμασε ξανά.";
}

export function CueEditor({ cue, ordinal, state, onClose }: { cue: TrackCue; ordinal: number; state: CueState; onClose: () => void }) {
  const id = useId();
  const initialCue = useRef(cue).current;
  const [label, setLabel] = useState(initialCue.label ?? "");
  const [kind, setKind] = useState(initialCue.kind);
  const [timestamp, setTimestamp] = useState(formatCueTime(initialCue.position_ms));
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const pending = state.pendingCueIds.has(cue.id);

  function adjust(delta: number) {
    const ms = parseCueTime(timestamp);
    if (ms === null || !Number.isSafeInteger(ms + delta)) {
      setError("Γράψε χρόνο στη μορφή m:ss.SSS, π.χ. 1:02.350.");
      return;
    }
    setTimestamp(formatCueTime(Math.max(0, ms + delta)));
    setError(null);
  }

  async function save() {
    if (submitting.current || pending) return;
    const position_ms = parseCueTime(timestamp);
    if (position_ms === null) {
      setError("Γράψε χρόνο στη μορφή m:ss.SSS, π.χ. 1:02.350.");
      return;
    }
    const changes: TrackCueUpdate = {};
    if (position_ms !== initialCue.position_ms) changes.position_ms = position_ms;
    if (kind !== initialCue.kind) changes.kind = kind;
    const nextLabel = label === "" ? null : label;
    if (nextLabel !== (initialCue.label ?? null)) changes.label = nextLabel;
    if (!Object.keys(changes).length) {
      onClose();
      return;
    }
    submitting.current = true;
    setError(null);
    const notification = toast.loading("Αποθήκευση cue…");
    try {
      await state.updateCue(initialCue.id, changes);
      toast.success("Το cue αποθηκεύτηκε", { id: notification });
      onClose();
    } catch (failure) {
      const message = errorMessage(failure);
      setError(message);
      toast.error(message, { id: notification });
    } finally {
      submitting.current = false;
    }
  }

  return (
    <form
      className="space-y-3 border-t border-cm-line/15 px-2 pb-3 pt-3"
      aria-label={`Επεξεργασία ${cueDescription(cue, ordinal)}`}
      aria-busy={pending}
      onSubmit={(event) => { event.preventDefault(); void save(); }}
    >
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label className="text-xs text-cm-muted" htmlFor={`${id}-kind`}>Τύπος</label>
          <Select value={kind} disabled={pending} onValueChange={(value) => setKind(value as TrackCueKind)}>
            <SelectTrigger id={`${id}-kind`} size="sm" className="w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent data-player-cues>
              {cueKinds.map((value) => <SelectItem key={value} value={value}>{CUE_KIND_LABELS[value]}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-cm-muted" htmlFor={`${id}-time`}>Χρόνος m:ss.SSS</label>
          <Input
            id={`${id}-time`}
            value={timestamp}
            disabled={pending}
            onChange={(event) => { setTimestamp(event.target.value); setError(null); }}
            className="h-8 font-mono text-xs tabular-nums"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={parseCueTime(timestamp) === null}
            aria-describedby={error ? `${id}-error` : undefined}
          />
        </div>
      </div>
      <div className="flex justify-end gap-1">
        <Button type="button" variant="outline" size="xs" disabled={pending} onClick={() => adjust(-100)} aria-label="Μετακίνηση cue 0,1 δευτερόλεπτο νωρίτερα">−0.1s</Button>
        <Button type="button" variant="outline" size="xs" disabled={pending} onClick={() => adjust(100)} aria-label="Μετακίνηση cue 0,1 δευτερόλεπτο αργότερα">+0.1s</Button>
      </div>
      <div className="space-y-1">
        <label className="text-xs text-cm-muted" htmlFor={`${id}-label`}>Ετικέτα (προαιρετική)</label>
        <Input id={`${id}-label`} autoFocus value={label} maxLength={120} disabled={pending} onChange={(event) => setLabel(event.target.value)} className="h-8 text-xs" placeholder="π.χ. αρχή του break" />
      </div>
      {error && <p id={`${id}-error`} role="alert" className="text-xs text-cm-rose">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="xs" disabled={pending} onClick={onClose}>Άκυρο</Button>
        <Button type="submit" size="xs" disabled={pending}>
          {pending && <Loader2 aria-hidden="true" className="size-3 animate-spin" />}
          {pending ? "Αποθήκευση…" : "Αποθήκευση"}
        </Button>
      </div>
    </form>
  );
}

function CueRow({ cue, ordinal, colorClass, state, canSeek, onSeek }: { cue: TrackCue; ordinal: number; colorClass: string; state: CueState; canSeek: boolean; onSeek: (positionMs: number) => void }) {
  const [mode, setMode] = useState<"view" | "edit" | "delete">("view");
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const previousMode = useRef(mode);
  const pending = state.pendingCueIds.has(cue.id);

  useEffect(() => {
    if (mode === "view" && previousMode.current !== "view") editButton.current?.focus();
    previousMode.current = mode;
  }, [mode]);

  async function remove() {
    if (submitting.current || pending) return;
    submitting.current = true;
    setError(null);
    const notification = toast.loading("Διαγραφή cue…");
    try {
      await state.deleteCue(cue.id);
      toast.success("Το cue διαγράφηκε", { id: notification });
    } catch (failure) {
      const message = errorMessage(failure);
      setError(message);
      toast.error(message, { id: notification });
    } finally {
      submitting.current = false;
    }
  }

  return (
    <li data-cue-id={cue.id} data-cue-number={ordinal} className="border-b border-cm-line/10 last:border-b-0">
      <div className="flex items-center gap-1 py-1.5">
        <button
          type="button"
          disabled={!canSeek}
          onClick={() => onSeek(cue.position_ms)}
          title={`Μετάβαση: ${cueDescription(cue, ordinal)}`}
          aria-label={`Μετάβαση: ${cueDescription(cue, ordinal)}`}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none menu-item focus-visible:ring-2 focus-visible:ring-cm-cyan/50 disabled:opacity-50"
        >
          <CueGlyph kind={cue.kind} className={colorClass} />
          <span className="min-w-0">
            <span className="flex items-center gap-2 text-xs text-cm-text">
              <span className={cn("font-mono tabular-nums", colorClass)}>{ordinal}</span>
              <span>{CUE_KIND_LABELS[cue.kind]}</span>
              <span className="font-mono tabular-nums">{formatCueTime(cue.position_ms)}</span>
            </span>
            {cue.label && <span className="block truncate text-xs text-cm-muted">{cue.label}</span>}
          </span>
        </button>
        <Button ref={editButton} variant="ghost" size="xs" disabled={pending} onClick={() => { setMode(mode === "edit" ? "view" : "edit"); setError(null); }} aria-label={`Επεξεργασία ${cueDescription(cue, ordinal)}`}>Αλλαγή</Button>
        <Button variant="ghost" size="icon-xs" disabled={pending} onClick={() => { setMode("delete"); setError(null); }} title="Διαγραφή cue" aria-label={`Διαγραφή ${cueDescription(cue, ordinal)}`}><Trash2 className="size-3 text-cm-muted" /></Button>
      </div>
      {mode === "edit" && <CueEditor cue={cue} ordinal={ordinal} state={state} onClose={() => setMode("view")} />}
      {mode === "delete" && (
        <div role="group" aria-label="Επιβεβαίωση διαγραφής cue" className="space-y-2 border-t border-cm-line/15 px-2 pb-3 pt-2">
          <p className="text-xs text-cm-text">Να διαγραφεί το {cueDescription(cue, ordinal)};</p>
          {error && <p role="alert" className="text-xs text-cm-rose">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button autoFocus variant="ghost" size="xs" disabled={pending} onClick={() => setMode("view")}>Άκυρο</Button>
            <Button variant="destructive" size="xs" disabled={pending} onClick={() => void remove()}>
              {pending && <Loader2 aria-hidden="true" className="size-3 animate-spin" />}
              {pending ? "Διαγραφή…" : "Διαγραφή"}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

export function CueList({ state, canSeek, onSeek, slots }: {
  state: CueState;
  canSeek: boolean;
  onSeek: (positionMs: number) => void;
  slots?: CuePadSlots;
}) {
  return <ul className="mt-2 max-h-[min(360px,50vh)] overflow-y-auto overscroll-contain">
    {cuePresentation(state.cues, slots).map(({ cue, ordinal, colorClass }) => <CueRow key={cue.id} cue={cue} ordinal={ordinal} colorClass={colorClass} state={state} canSeek={canSeek} onSeek={onSeek} />)}
  </ul>;
}

export function PlayerCues({ trackId, state, canCapture, canSeek, onCapture, onSeek, slots }: {
  trackId: number;
  slots?: CuePadSlots;
  state: CueState;
  canCapture: boolean;
  canSeek: boolean;
  onCapture: (kind: TrackCueKind) => void;
  onSeek: (positionMs: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  return (
    <div data-player-cues data-track-id={trackId} className="grid w-36 shrink-0 grid-cols-2 gap-0.5">
      {cueKinds.map((kind) => {
        const pending = state.pendingKinds.has(kind);
        const description = `${cueDescriptions[kind]} (${cueHints[kind]})`;
        return (
          <Button key={kind} type="button" variant="outline" size="xs" className="h-5 gap-1 px-1 text-[10px]" disabled={!canCapture || pending} onClick={() => onCapture(kind)} title={description} aria-label={description} aria-busy={pending}>
            {pending ? <Loader2 aria-hidden="true" className="size-2.5 animate-spin" /> : <span aria-hidden="true">+</span>}
            {CUE_KIND_LABELS[kind]}
            <kbd aria-hidden="true" className="ml-auto font-mono text-[9px] text-cm-muted">{cueHints[kind]}</kbd>
          </Button>
        );
      })}
      <Popover open={open} onOpenChange={(next) => { if (next || !state.pendingCueIds.size) setOpen(next); }}>
        <PopoverTrigger asChild>
          <Button type="button" variant="secondary" size="xs" className="h-5 gap-1 px-1 text-[10px]" aria-label={`Προβολή cues (${state.cues.length})`} title="Αποθηκευμένα σημεία ακρόασης">
            <Pin className="size-2.5" aria-hidden="true" /> Cues <span className="font-mono tabular-nums">{state.cues.length}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent data-player-cues side="top" align="end" className="w-[min(360px,calc(100vw-24px))] p-3 text-cm-text" aria-labelledby={titleId}>
          <p id={titleId} className="text-sm font-semibold">Σημεία ακρόασης</p>
          <p className="mt-1 text-xs text-cm-muted">Πάτησε ένα cue για να επιστρέψεις στο σημείο του.</p>
          {state.loading && <p role="status" className="py-3 text-xs text-cm-muted">Φόρτωση cues…</p>}
          {state.error && (
            <div className="mt-2 space-y-2">
              <p role="alert" className="text-xs text-cm-rose">{state.error}</p>
              <Button type="button" variant="outline" size="xs" disabled={state.loading} onClick={() => { void state.refresh().catch(() => {}); }}>Δοκίμασε ξανά</Button>
            </div>
          )}
          {!state.loading && !state.error && !state.cues.length && <p role="status" className="py-3 text-xs text-cm-muted">Δεν υπάρχουν cues. Πρόσθεσε ένα με + Entry, + Exit ή + Cue όσο ακούς.</p>}
          <CueList state={state} canSeek={canSeek} onSeek={onSeek} slots={slots} />
        </PopoverContent>
      </Popover>
    </div>
  );
}

export function CueMarkers({ cues, duration, canSeek, onSeek, slots, compact = false }: {
  cues: TrackCue[];
  slots?: CuePadSlots;
  duration: number;
  canSeek: boolean;
  onSeek: (positionMs: number) => void;
  /** Small overview flags; cue identity, numbering and seek behaviour stay shared. */
  compact?: boolean;
}) {
  if (!Number.isFinite(duration) || duration <= 0) return null;
  return (
    <div className="pointer-events-none absolute inset-0">
      {cuePresentation(cues, slots).map(({ cue, ordinal, colorClass }) => {
        const pct = Math.min(100, Math.max(0, (cue.position_ms / (duration * 1000)) * 100));
        const description = `Μετάβαση: ${cueDescription(cue, ordinal)}`;
        return (
          <span key={cue.id}>
            <span aria-hidden="true" className={cn("pointer-events-none absolute inset-y-0 z-10 w-px bg-current opacity-80", colorClass)} style={{ left: `${pct}%` }} />
            <button
              type="button"
              data-player-cues
              data-cue-id={cue.id}
              data-cue-number={ordinal}
              title={description}
              aria-label={description}
              disabled={!canSeek}
              className={cn("pointer-events-auto absolute top-0 z-30 flex size-5 -translate-x-1/2 justify-center font-mono text-[10px] font-semibold tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-cm-cyan/60 disabled:pointer-events-none disabled:opacity-50", compact ? "items-start bg-transparent" : "items-center rounded-sm border border-cm-line/20 bg-cm-panel-2 hover:bg-cm-panel", colorClass)}
              style={{ left: `clamp(10px, ${pct}%, calc(100% - 10px))` }}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => { event.stopPropagation(); onSeek(cue.position_ms); }}
              onKeyDown={(event) => event.stopPropagation()}
              onKeyUp={(event) => event.stopPropagation()}
            >
              {compact
                ? <span aria-hidden="true" className="h-2.5 w-3 bg-current [clip-path:polygon(0_0,100%_0,50%_100%)]" />
                : <span aria-hidden="true">{ordinal}</span>}
            </button>
          </span>
        );
      })}
    </div>
  );
}
