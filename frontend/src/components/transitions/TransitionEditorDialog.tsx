import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { barSeconds, buildBeatGrid, timeAfterBars, useBeatGridDto, type BeatGrid } from "../../lib/beatGrid";
import { cn } from "../../lib/cn";
import { Pause, Play, RotateCcw, X } from "../../lib/icons";
import { deckTransportOf } from "../../lib/mix/deckTransport";
import { getMixSession, stopMixSession, subscribeMix } from "../../lib/mix/mixSession";
import { createSecondPress, shouldRequireSecondPress, startTransitionPreview } from "../../lib/mix/mixStart";
import { getMixer } from "../../lib/mixer";
import { playbackContext, unlockPlaybackAudio } from "../../lib/playbackAudio";
import { usePlayer } from "../../lib/player";
import { effectiveBpm } from "../../lib/tempo";
import { useTrackCues } from "../../lib/trackCues";
import { useDownbeat } from "../../lib/trackDownbeat";
import { CONTROL_COPY, EDITOR_COPY, MIX_COPY } from "../../lib/transitions/copy";
import { sampleCurves } from "../../lib/transitions/curves";
import { nudgeInLane, snapWindow, stepBeat, windowAudioS, VIEW_MAX_BARS, type LaneSpec, type WindowState } from "../../lib/transitions/dualWaveform";
import { draftTransition, editorReducer, initEditor, isDirty, savePayload } from "../../lib/transitions/editorState";
import { isMixable } from "../../lib/transitions/mixable";
import { resolveAnchors, tempoMatchRate, type LaneInput } from "../../lib/transitions/planner";
import { pairKey, type SetTransition } from "../../lib/transitions/types";
import type { SetTrackRow, Track } from "../../lib/types";
import { Artwork } from "../ui/Artwork";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { KeyBadge } from "../ui/KeyBadge";
import { SmartChip } from "../ui/SmartChip";
import { TransitionLength, formatRate } from "./TransitionLength";
import { TransitionOverview } from "./TransitionOverview";
import { TransitionParams } from "./TransitionParams";
import { TransitionPresets } from "./TransitionPresets";
import { TransitionWaveform } from "./TransitionWaveform";

export interface TransitionEditorDialogProps {
  open: boolean;
  setId: number;
  from: SetTrackRow;
  to: SetTrackRow;
  transition: SetTransition;
  onClose(): void;
  onSaved(t: SetTransition): void;
}

const trackName = (t: Track) => t.title || t.file_name;
const beatOf = (grid: BeatGrid, t: number) => barSeconds(grid, t) / 4;
/** Space toggles the preview unless a control that owns Space (or typing) has focus. */
const OWNS_SPACE = 'button, input, textarea, select, a[href], [role="combobox"], [role="switch"], [role="slider"], [role="option"], [role="menuitem"], [contenteditable="true"]';

/** The grid a deck would build for this track: imported grid, else BPM + entry cue, with the user's downbeat. */
function useLaneData(track: Track) {
  const { cues } = useTrackCues(track.id);
  const dto = useBeatGridDto(track.id);
  const downbeat = useDownbeat(track.id).value;
  const bpm = effectiveBpm(track);
  const entryMs = cues.find(c => c.kind === "entry")?.position_ms;
  const grid = useMemo(() => buildBeatGrid(dto, bpm, entryMs != null ? entryMs / 1000 : null, downbeat), [dto, bpm, entryMs, downbeat]);
  return { grid, cues, bpm, duration: track.duration ?? 0 };
}

function LaneHeader({ label, track, bpm, tone }: { label: string; track: Track; bpm: number | null; tone: "out" | "in" }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <Artwork seed={track.id} className="size-8 shrink-0 rounded-md" />
      <div className="min-w-0 flex-1">
        <div className={cn("text-[10px] font-semibold uppercase tracking-wider", tone === "out" ? "text-cm-faint" : "text-cm-cyan/80")}>{label}</div>
        <div className="truncate text-[13px] leading-snug">
          <span className="font-medium text-cm-text">{trackName(track)}</span>
          {track.artist && <span className="text-cm-muted"> • {track.artist}</span>}
        </div>
      </div>
      <KeyBadge keyText={track.key_text} analyzed={track.key_analyzed} />
      <span className="shrink-0 font-mono text-xs tabular-nums text-cm-muted">{bpm != null ? `${bpm.toFixed(1)} BPM` : "— BPM"}</span>
    </div>
  );
}

/**
 * «Επεξεργασία μετάβασης»: one pair's transition, edited on a near-full-screen sheet. The draft lives in
 * `editorReducer`; the window is the saved anchors or, until the user moves it, the planner's own choice. Preview plays
 * the unsaved draft on the decks through a preview mix session.
 */
export function TransitionEditorDialog({ open, setId, from, to, transition, onClose, onSaved }: TransitionEditorDialogProps) {
  const [state, dispatch] = useReducer(editorReducer, transition, initEditor);
  const dirty = isDirty(state);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  // A reloaded row (save, reset, another view) replaces a clean draft; an edit in progress is kept.
  useEffect(() => { if (!dirtyRef.current) dispatch({ type: "load", row: transition }); }, [transition]);

  const [saving, setSaving] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const drawRef = useRef<(() => void) | null>(null);

  const out = useLaneData(from.track);
  const inn = useLaneData(to.track);
  const p = state.draft;
  const cut = p.preset === "none" || p.bars === 0;
  const grids = out.grid && inn.grid ? { out: out.grid, in: inn.grid } : null;

  const resolved = useMemo(() => {
    if (!grids) return null;
    const lane = (d: typeof out, grid: BeatGrid, id: number): LaneInput => ({ trackId: id, grid, duration: d.duration, cues: d.cues, rate: 1, onEngine: true });
    return resolveAnchors(lane(out, grids.out, from.track.id), lane(inn, grids.in, to.track.id), p);
  }, [grids?.out, grids?.in, out.duration, inn.duration, out.cues, inn.cues, p, from.track.id, to.track.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const outStartS = p.out_anchor_s ?? resolved?.outStartS ?? 0;
  const inStartS = p.in_anchor_s ?? resolved?.inStartS ?? 0;
  const bars = Math.max(1, p.bars);
  const rateIn = grids && p.tempo_match ? tempoMatchRate(60 / beatOf(grids.out, outStartS), 1, 60 / beatOf(grids.in, inStartS)) : null;

  const lanes = useMemo((): { out: LaneSpec; in: LaneSpec } | null => grids && {
    out: { trackId: from.track.id, revision: from.track.modified_time, grid: grids.out, duration: out.duration, rate: 1, anchorS: outStartS },
    in: { trackId: to.track.id, revision: to.track.modified_time, grid: grids.in, duration: inn.duration, rate: rateIn ?? 1, anchorS: inStartS },
  }, [grids?.out, grids?.in, from.track, to.track, out.duration, inn.duration, outStartS, inStartS, rateIn]); // eslint-disable-line react-hooks/exhaustive-deps

  const curves = useMemo(() => {
    if (!grids || cut) return null;
    const span = timeAfterBars(grids.out, outStartS, bars) - outStartS;
    return span > 0 ? sampleCurves(p, 128, beatOf(grids.out, outStartS) / span) : null;
  }, [grids?.out, cut, outStartS, bars, p.volume_curve, p.eq_curve, p.filter_curve]); // eslint-disable-line react-hooks/exhaustive-deps

  // The zoomed view: opens at twice the window, centred on it; the waveform pans and zooms it from there.
  const [viewState, setViewState] = useState<{ centerAudioS: number; bars: number } | null>(null);
  const view = viewState ?? {
    centerAudioS: grids ? windowAudioS(grids.out, outStartS, bars, 1) / 2 : 0,
    bars: Math.min(VIEW_MAX_BARS, Math.max(4, bars * 2)),
  };
  const setCenter = useCallback((centerAudioS: number) => setViewState(v => ({ bars: v?.bars ?? view.bars, centerAudioS })), [view.bars]);
  const setZoom = useCallback((zoomBars: number) => setViewState(v => ({ centerAudioS: v?.centerAudioS ?? view.centerAudioS, bars: zoomBars })), [view.centerAudioS]);

  /** Freeze the planner's anchors into the draft before the first window edit (a baseline, not an edit). */
  const ensureAnchors = () => {
    if ((p.out_anchor_s == null || p.in_anchor_s == null) && resolved) {
      dispatch({ type: "setAnchors", outStartS: resolved.outStartS, inStartS: resolved.inStartS });
    }
  };
  /** A window edit from the length controls: snapped onto both grids and kept inside both tracks. */
  const commitWindow = (w: WindowState, unit: "bar" | "beat") => {
    if (!grids) return;
    const next = snapWindow(w, { grid: grids.out, duration: out.duration, rate: 1 }, { grid: grids.in, duration: inn.duration, rate: rateIn ?? 1 }, unit);
    ensureAnchors();
    // The axis origin follows the window: shift the view so the waveforms stay put and the window moves.
    if (next.outStartS !== outStartS) setCenter(view.centerAudioS - (next.outStartS - outStartS));
    dispatch({ type: "window", ...next });
  };
  const setBars = (n: number) => {
    if (grids) commitWindow({ outStartS, bars: n, inStartS }, "beat");
    else dispatch({ type: "bars", bars: n });
  };

  // ---- save / reset / close ---------------------------------------------------------------------------------
  const announceSaved = (row: SetTransition) => {
    window.dispatchEvent(new Event("cratemind:set-transition"));
    onSaved(row);
  };
  const save = async (): Promise<boolean> => {
    if (saving || !dirty) return !dirty;
    setSaving(true);
    try {
      const row = await api.saveSetTransition(setId, savePayload(state));
      dispatch({ type: "saved", row });
      toast.success(MIX_COPY.saved);
      announceSaved(row);
      return true;
    } catch {
      toast.error(EDITOR_COPY.saveFailed);
      return false;
    } finally {
      setSaving(false);
    }
  };
  const resetToAuto = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await api.deleteSetTransition(setId, from.track.id, to.track.id);
      const row = (await api.getSetTransitions(setId)).find(t => pairKey(t.from_track_id, t.to_track_id) === pairKey(from.track.id, to.track.id));
      if (row) {
        dispatch({ type: "reset", row });
        setViewState(null);
        announceSaved(row);
      }
      toast.success(EDITOR_COPY.resetDone);
    } catch {
      toast.error(EDITOR_COPY.resetFailed);
    } finally {
      setSaving(false);
    }
  };
  const requestClose = () => { if (dirty) setConfirmClose(true); else onClose(); };
  useEffect(() => { if (!dirty) setConfirmClose(false); }, [dirty]);

  // ---- preview ------------------------------------------------------------------------------------------------
  const player = usePlayer();
  // Only this boolean re-renders the editor, not every mix-store tick of a running preview or set mix.
  const readPreviewing = useCallback(() => {
    const mix = getMixSession();
    return mix.mode === "preview" && mix.status !== "idle" && mix.queue[0]?.trackId === from.track.id && mix.queue[1]?.trackId === to.track.id;
  }, [from.track.id, to.track.id]);
  const previewing = useSyncExternalStore(subscribeMix, readPreviewing, readPreviewing);
  const previewingRef = useRef(previewing);
  previewingRef.current = previewing;
  const sampleRate = playbackContext()?.sampleRate ?? 48000;
  const mixable = isMixable(from.track, sampleRate) && isMixable(to.track, sampleRate);
  const gate = useRef(createSecondPress());

  const togglePreview = () => {
    if (previewing) { stopMixSession("preview-stop"); return; }
    if (!mixable) return;
    const pair = new Set([from.track.id, to.track.id]);
    if (shouldRequireSecondPress(player.slots, player.deckIsPlaying, pair, getMixSession()) && !gate.current.confirm(Date.now())) {
      toast(MIX_COPY.pressAgain);
      return;
    }
    gate.current.reset();
    // The preview plays exactly the window on screen: the unsaved draft with its anchors filled in.
    const row = grids ? { ...draftTransition(state), out_anchor_s: outStartS, in_anchor_s: inStartS } : draftTransition(state);
    startTransitionPreview({ load: player.load, unlock: () => { void unlockPlaybackAudio(); }, mixer: getMixer }, { from: from.track, to: to.track, transition: row });
  };

  const playhead = useCallback(() => {
    if (!previewingRef.current) return null;
    const a = deckTransportOf("A");
    const b = deckTransportOf("B");
    if (!a || !b || a.trackId !== from.track.id || b.trackId !== to.track.id) return null;
    return { outS: a.position(), inS: b.position() };
  }, [from.track.id, to.track.id]);

  // Playheads move on a rAF while the preview runs; one last frame clears them.
  useEffect(() => {
    if (!previewing) { drawRef.current?.(); return; }
    let id = requestAnimationFrame(function frame() { drawRef.current?.(); id = requestAnimationFrame(frame); });
    return () => cancelAnimationFrame(id);
  }, [previewing]);

  // Closing the editor ends its preview.
  useEffect(() => () => {
    const s = getMixSession();
    if (s.mode === "preview" && s.status !== "idle" && s.queue[0]?.trackId === from.track.id) stopMixSession("editor-closed");
  }, [from.track.id]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== " " || e.repeat || e.defaultPrevented) return;
    if (e.target instanceof Element && e.target.closest(OWNS_SPACE)) return;
    e.preventDefault();
    togglePreview();
  };

  const focusPresets = (e: Event) => {
    e.preventDefault();
    const group = contentRef.current?.querySelector<HTMLElement>("[data-transition-presets]");
    (group?.querySelector<HTMLElement>('[aria-pressed="true"]') ?? group?.querySelector<HTMLElement>("button"))?.focus();
  };

  const description = `${trackName(from.track)} → ${trackName(to.track)}`;
  const notice = !mixable ? EDITOR_COPY.unmixable : cut ? EDITOR_COPY.cutNotice : !grids ? EDITOR_COPY.noGrid : null;

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) requestClose(); }}>
      <DialogContent
        ref={contentRef}
        showCloseButton={false}
        onOpenAutoFocus={focusPresets}
        onKeyDown={onKeyDown}
        className={cn(
          // Viewport minus a 1 rem gutter and the native titlebar: insets, never a fixed height.
          "top-[calc(var(--cm-titlebar-height)+1rem)] right-4 bottom-4 left-4 flex w-auto max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-none",
          // Reduced motion: the sheet only fades.
          "motion-reduce:data-[state=open]:zoom-in-100 motion-reduce:data-[state=closed]:zoom-out-100",
        )}
      >
        <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-black/10 px-4 py-2.5 dark:border-white/10">
          <div className="flex min-w-0 items-center gap-2">
            <DialogTitle className="truncate text-base font-semibold tracking-tight">{MIX_COPY.editorTitle}</DialogTitle>
            <SmartChip tone="chartreuse" className="px-1.5 py-0 text-[10px] leading-4">Beta</SmartChip>
          </div>
          <DialogDescription className="sr-only">{description}</DialogDescription>
          <div className="ml-auto flex items-center gap-2">
            {confirmClose ? (
              <div role="alert" className="flex items-center gap-2">
                <span className="text-xs font-medium text-cm-amber">{MIX_COPY.unsaved}</span>
                <Button size="sm" autoFocus disabled={saving} onClick={async () => { if (await save()) onClose(); }}>
                  {saving ? EDITOR_COPY.saving : MIX_COPY.save}
                </Button>
                <Button size="sm" variant="outline" disabled={saving} onClick={onClose}>{MIX_COPY.discard}</Button>
              </div>
            ) : (
              <>
                {state.row.persisted && (
                  <Button size="sm" variant="ghost" disabled={saving} onClick={() => { void resetToAuto(); }} className="text-cm-muted">
                    <RotateCcw aria-hidden="true" />{MIX_COPY.resetAuto}
                  </Button>
                )}
                <Button size="sm" disabled={!dirty || saving} onClick={() => { void save(); }} className="min-w-28 active:scale-[0.97] motion-reduce:active:scale-100">
                  {saving ? EDITOR_COPY.saving : MIX_COPY.save}
                </Button>
              </>
            )}
            <Button size="icon" variant="ghost" aria-label={MIX_COPY.close} title={MIX_COPY.close} onClick={requestClose}>
              <X aria-hidden="true" />
            </Button>
          </div>
        </header>

        {/* Body: the waveform takes the free height; on short or narrow windows the body scrolls instead of overflowing. */}
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto py-3">
          {lanes && (
            <div className="shrink-0 px-4">
              <TransitionOverview out={lanes.out} in={lanes.in} window={{ outStartS, bars }} view={view} onViewChange={setCenter} />
            </div>
          )}
          <div className="grid shrink-0 grid-cols-1 gap-x-6 gap-y-2 px-4 md:grid-cols-2">
            <LaneHeader label={EDITOR_COPY.outgoing} track={from.track} bpm={out.bpm} tone="out" />
            <LaneHeader label={EDITOR_COPY.incoming} track={to.track} bpm={inn.bpm} tone="in" />
          </div>
          <div className="flex min-h-40 flex-1 flex-col px-4">
            {lanes && !cut ? (
              <TransitionWaveform
                className="flex-1"
                out={lanes.out}
                in={lanes.in}
                window={{ outStartS, bars }}
                view={view}
                curves={curves}
                loopBeats={p.loop_beats}
                playhead={playhead}
                drawRef={drawRef}
                onWindowChange={next => { ensureAnchors(); dispatch({ type: "window", ...next }); }}
                onViewChange={setCenter}
                onZoomChange={setZoom}
              />
            ) : (
              <div className="grid flex-1 place-items-center rounded-lg bg-black/5 px-6 text-center text-sm text-cm-muted ring-1 ring-black/10 dark:bg-white/[0.03] dark:ring-white/10">
                {notice ?? EDITOR_COPY.loading}
              </div>
            )}
            {notice && lanes && !cut && <p className="mt-1.5 text-[11px] text-cm-amber">{notice}</p>}
          </div>
          <div className="flex shrink-0 items-center justify-center gap-3">
            <Button
              size="icon-lg"
              className="rounded-full active:scale-[0.96] motion-reduce:active:scale-100"
              aria-label={previewing ? EDITOR_COPY.stopPreview : MIX_COPY.preview}
              aria-keyshortcuts="Space"
              title={`${previewing ? EDITOR_COPY.stopPreview : MIX_COPY.preview} (${EDITOR_COPY.previewHint})`}
              disabled={!mixable && !previewing}
              onClick={togglePreview}
            >
              {previewing ? <Pause aria-hidden="true" className="size-4" /> : <Play aria-hidden="true" className="ml-0.5 size-4" />}
            </Button>
          </div>
          <div className="shrink-0 px-4">
            <TransitionPresets
              value={p.preset}
              autoLocked={!state.auto}
              onChange={preset => {
                if (preset === "auto" && !state.auto) toast(CONTROL_COPY.autoLocked);
                else dispatch({ type: "preset", preset });
              }}
            />
          </div>
          <div className="grid shrink-0 grid-cols-1 items-start gap-x-6 gap-y-4 px-4 md:grid-cols-[1fr_320px]">
            <TransitionParams value={p} onChange={patch => dispatch({ type: "params", patch })} />
            <fieldset disabled={cut} className="min-w-0 disabled:opacity-50">
              <TransitionLength
                bars={bars}
                onBars={setBars}
                onNudgeWindow={(dir, unit) => {
                  if (!grids) return;
                  const t = unit === "bar" ? timeAfterBars(grids.out, outStartS, dir) : stepBeat(grids.out, outStartS, dir);
                  commitWindow({ outStartS: t, bars, inStartS }, unit);
                }}
                onNudgeIn={dir => {
                  if (grids) commitWindow({ outStartS, bars, inStartS: nudgeInLane(grids.in, inStartS, dir) }, "beat");
                }}
                tempoMatch={p.tempo_match}
                onTempoMatch={on => dispatch({ type: "tempoMatch", on })}
                rateText={formatRate(p.tempo_match ? rateIn : 1)}
              />
            </fieldset>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
