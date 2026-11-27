import { useEffect, useRef, type RefObject } from "react";
import { openMasterMeter, type MasterMeter as BusMeter } from "@/lib/audio/masterBus";
import { DB_FLOOR } from "@/lib/deckTelemetry";
import { SILENT_CHANNEL, limUntil, meterShare, stepChannel } from "@/lib/masterMeter";
import { existingPlaybackContext } from "@/lib/playbackAudio";
import { cn } from "@/lib/cn";

const METER_TITLE = "Στάθμη master: πόσο δυνατά βγαίνει το σύνολο των δύο deck στα ηχεία και στην εγγραφή, αριστερά και δεξιά. Όσο ο ήχος περνά από plugins VST3 δεν δείχνει τίποτα.";
const LIM_TITLE = "LIM: ανάβει όταν ο ήχος φτάνει πάνω από το όριο και ο limiter ασφαλείας τον χαμηλώνει, για να μη βγει παραμόρφωση.";

interface MeterRefs {
  root: RefObject<HTMLDivElement | null>;
  fills: RefObject<(HTMLDivElement | null)[]>;
  holds: RefObject<(HTMLDivElement | null)[]>;
  lim: RefObject<HTMLSpanElement | null>;
  /** The held peak in dB, as text («κορυφή −2.4 dB»). */
  peak?: RefObject<HTMLSpanElement | null>;
  /** Read each frame: the single deck plays outside the master bus, so the meter is dim. */
  outside?: RefObject<boolean>;
}

/**
 * The meter's loop: left and right sample peaks of the bus output with a held peak marker, and «LIM» while the safety limiter
 * is turning the sound down. One rAF loop writes straight to the elements (no React state). It only reads the bus: it never
 * builds one. `live` false closes the meter, so its analysers leave the bus.
 */
function useMeterLoop(live: boolean, refs: MeterRefs) {
  useEffect(() => {
    if (!live) return;
    const { root, fills, holds, lim, peak, outside } = refs;
    let meter: BusMeter | null = null;
    let raf = 0;
    let last = performance.now();
    let limOff = 0;
    let channels = [SILENT_CHANNEL, SILENT_CHANNEL];
    const shown = { fill: ["", ""], hold: ["", ""], lim: false, dim: false, outside: false, peak: "" };
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (!meter) {
        const ctx = existingPlaybackContext();
        meter = ctx ? openMasterMeter(ctx) : null;
      }
      const levels = meter?.read() ?? { left: 0, right: 0, limiting: false, sunk: false };
      channels = [levels.left, levels.right].map((amp, i) => stepChannel(channels[i], amp, now, now - last));
      last = now;
      limOff = limUntil(limOff, levels.limiting, now);
      channels.forEach((channel, i) => {
        const empty = `${((1 - meterShare(channel.db)) * 100).toFixed(1)}%`;
        const fill = `inset(0 ${empty} 0 0)`;
        const fillEl = fills.current[i];
        if (fillEl && fill !== shown.fill[i]) fillEl.style.clipPath = shown.fill[i] = fill;
        const share = meterShare(channel.holdDb);
        // No marker at rest.
        const hold = share > 0 ? `calc(${(share * 100).toFixed(1)}% - 2px)` : "-4px";
        const holdEl = holds.current[i];
        if (holdEl && hold !== shown.hold[i]) holdEl.style.left = shown.hold[i] = hold;
      });
      const limOn = now < limOff;
      if (lim.current && limOn !== shown.lim) lim.current.toggleAttribute("data-on", (shown.lim = limOn));
      const away = outside?.current ?? false;
      const dim = levels.sunk || away;
      if (root.current && dim !== shown.dim) root.current.style.opacity = (shown.dim = dim) ? "0.4" : "";
      if (root.current && away !== shown.outside) root.current.toggleAttribute("data-outside", (shown.outside = away));
      if (peak?.current) {
        const held = Math.max(channels[0].holdDb, channels[1].holdDb);
        const text = held <= DB_FLOOR ? "κορυφή —" : `κορυφή ${held < -0.05 ? "−" : ""}${Math.abs(held).toFixed(1)} dB`;
        if (text !== shown.peak) peak.current.textContent = shown.peak = text;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      meter?.close();
    };
  }, [live, refs]);
}

function useMeterRefs(outside?: boolean): MeterRefs {
  const refs = useRef<MeterRefs | null>(null);
  refs.current ??= { root: { current: null }, fills: { current: [] }, holds: { current: [] }, lim: { current: null }, peak: { current: null }, outside: { current: false } };
  refs.current.outside!.current = outside ?? false;
  return refs.current;
}

/** Green up to −6 dBFS, amber up to −1, red above, on the meter's −40..0 dBFS scale. */
const BAR_COLOURS = `linear-gradient(to right, #10b981 0 ${meterShare(-6) * 100}%, var(--cm-amber) ${meterShare(-6) * 100}% ${meterShare(-1) * 100}%, #f43f5e ${meterShare(-1) * 100}% 100%)`;
/** Our segment rhythm, sideways: 3 px lit, 1 px gap. */
const BAR_SEGMENTS = "repeating-linear-gradient(to right, transparent 0 3px, var(--cm-bg-2) 3px 4px)";

/**
 * The master level lying down, for the top bar (160 × 12 px) and the «Ένταση ακρόασης» panel: L over R, a 2 px peak line held
 * 1 s, and in the bar the «LIM» lamp and «εκτός master» while the single deck plays outside the bus. `peak` writes the held peak.
 */
export function MasterMeterBar({ live, row = 5, className, lamp = true, outside = false, peak }: {
  live: boolean;
  /** Each row's height in px. */
  row?: number;
  /** Sets the width (the rows fill it). */
  className?: string;
  /** The «LIM» lamp after the rows. */
  lamp?: boolean;
  outside?: boolean;
  /** Receives «κορυφή −2.4 dB». */
  peak?: RefObject<HTMLSpanElement | null>;
}) {
  const refs = useMeterRefs(outside);
  refs.peak = peak;
  useMeterLoop(live, refs);
  return (
    <div ref={refs.root} className="group flex min-w-0 items-center gap-1.5">
      <div role="img" aria-label="Στάθμη master" title={METER_TITLE} className={cn("flex shrink-0 flex-col gap-0.5", className)}>
        {[0, 1].map(i => (
          <div key={i} className="relative overflow-hidden rounded-[1px] bg-cm-bg-2 shadow-[inset_0_0_0_0.5px_var(--cm-border-hi)]" style={{ height: row }}>
            <div ref={el => { refs.fills.current[i] = el; }} className="absolute inset-0" style={{ background: BAR_COLOURS, clipPath: "inset(0 100% 0 0)" }} />
            <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: BAR_SEGMENTS }} />
            <div ref={el => { refs.holds.current[i] = el; }} aria-hidden className="absolute inset-y-0 w-0.5 bg-cm-text" style={{ left: "-4px" }} />
          </div>
        ))}
      </div>
      {lamp && (
        <span ref={refs.lim} aria-hidden title={LIM_TITLE}
          className="flex h-4 shrink-0 items-center rounded-[3px] border border-cm-line/20 px-1 font-mono text-[10px] font-bold leading-none text-cm-faint dark:border-white/10 data-[on]:border-cm-amber/60 data-[on]:bg-cm-amber/15 data-[on]:text-cm-amber data-[on]:shadow-[0_0_8px_-1px_var(--color-cm-amber)]">
          LIM
        </span>
      )}
      {lamp && <span className="hidden whitespace-nowrap text-[10px] font-medium text-cm-faint group-data-[outside]:inline">εκτός master</span>}
    </div>
  );
}
