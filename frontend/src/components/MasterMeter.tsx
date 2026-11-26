import { useEffect, useRef } from "react";
import { openMasterMeter, type MasterMeter as BusMeter } from "@/lib/audio/masterBus";
import { SILENT_CHANNEL, limUntil, meterShare, stepChannel } from "@/lib/masterMeter";
import { existingPlaybackContext } from "@/lib/playbackAudio";

const METER_TITLE = "Στάθμη master: πόσο δυνατά βγαίνει το σύνολο των δύο deck στα ηχεία και στην εγγραφή, αριστερά και δεξιά. Όσο ο ήχος περνά από plugins VST3 δεν δείχνει τίποτα.";
const LIM_TITLE = "LIM: ανάβει όταν ο ήχος φτάνει πάνω από το όριο και ο limiter ασφαλείας τον χαμηλώνει, για να μη βγει παραμόρφωση.";

/**
 * The master level: left and right sample peaks of the bus output with a held peak marker, and «LIM» while the safety limiter
 * is turning the sound down. One rAF loop writes straight to refs (no React state). `live` false (the dock is collapsed)
 * closes the meter, so its analysers leave the bus.
 */
export function MasterMeter({ live }: { live: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const fills = useRef<(HTMLDivElement | null)[]>([]);
  const holds = useRef<(HTMLDivElement | null)[]>([]);
  const lim = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!live) return;
    let meter: BusMeter | null = null;
    let raf = 0;
    let last = performance.now();
    let limOff = 0;
    let channels = [SILENT_CHANNEL, SILENT_CHANNEL];
    const shown = { fill: ["", ""], hold: ["", ""], lim: false, sunk: false };
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
        const fill = `inset(${((1 - meterShare(channel.db)) * 100).toFixed(1)}% 0 0 0)`;
        const fillEl = fills.current[i];
        if (fillEl && fill !== shown.fill[i]) fillEl.style.clipPath = shown.fill[i] = fill;
        const share = meterShare(channel.holdDb);
        const hold = share > 0 ? `${(share * 100).toFixed(1)}%` : "-2px"; // no marker at rest
        const holdEl = holds.current[i];
        if (holdEl && hold !== shown.hold[i]) holdEl.style.bottom = shown.hold[i] = hold;
      });
      const limOn = now < limOff;
      if (lim.current && limOn !== shown.lim) lim.current.toggleAttribute("data-on", (shown.lim = limOn));
      if (root.current && levels.sunk !== shown.sunk) root.current.style.opacity = (shown.sunk = levels.sunk) ? "0.4" : "";
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      meter?.close();
    };
  }, [live]);
  return (
    <div ref={root} className="flex w-3.5 shrink-0 flex-col items-center gap-0.5 py-1">
      <span ref={lim} aria-hidden title={LIM_TITLE}
        className="font-mono text-[7px] font-bold leading-none text-cm-faint data-[on]:text-cm-amber data-[on]:[text-shadow:0_0_6px_var(--color-cm-amber)]">
        LIM
      </span>
      <div role="img" aria-label="Στάθμη master" title={METER_TITLE} className="flex min-h-0 w-full flex-1 justify-center gap-px">
        {[0, 1].map(i => (
          <div key={i} className="relative w-[5px] overflow-hidden rounded-[1px] bg-cm-bg-2">
            <div ref={el => { fills.current[i] = el; }} className="absolute inset-0 bg-gradient-to-t from-emerald-500 via-cm-amber to-rose-500"
              style={{ clipPath: "inset(100% 0 0 0)" }} />
            <div aria-hidden className="cm-vu-segments pointer-events-none absolute inset-0" />
            <div ref={el => { holds.current[i] = el; }} aria-hidden className="absolute inset-x-0 h-px bg-cm-text" style={{ bottom: "-2px" }} />
          </div>
        ))}
      </div>
    </div>
  );
}
