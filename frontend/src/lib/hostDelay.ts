// The VST3 master host's measured added delay (mean fill + plugin + device), for the deck visuals only.
// Nothing that feeds audio or sync reads it.

const MAX_MS = 500;
/** A rise larger than this is the bigger reserve taking hold at an underrun's refill (audible anyway): it applies at once. */
const RISE_SNAP_MS = 25;
/** A new value this close to the current target leaves it unchanged. */
const DEADBAND_MS = 3;
/** Every other change moves at most this fast, so the one-window dip in the mean fill around an underrun barely shows. */
const SLEW_MS_PER_S = 20;

let target = 0;
let current = 0;
let lastNowMs: number | null = null;

/** Host's measured added delay. ms ≤ 0 or non-finite → 0 (host not in the path). Clamped to ≤ 500. */
export function setHostDelayMs(ms: number, nowMs = performance.now()): void {
  hostDelaySeconds(nowMs); // run the slew up to now on the old target, so it keeps wall time while no lane draws
  const v = Number.isFinite(ms) && ms > 0 ? Math.min(MAX_MS, ms) : 0;
  if (v === 0 || target === 0 || v - current > RISE_SNAP_MS) {
    target = current = v;
  } else if (Math.abs(v - target) > DEADBAND_MS) {
    target = v;
  }
}

/** Smoothed delay in seconds at performance.now() time `nowMs`. */
export function hostDelaySeconds(nowMs: number): number {
  const dt = lastNowMs != null && nowMs > lastNowMs ? (nowMs - lastNowMs) / 1000 : 0;
  if (lastNowMs == null || nowMs > lastNowMs) lastNowMs = nowMs;
  const step = SLEW_MS_PER_S * dt;
  current = current < target ? Math.min(target, current + step) : Math.max(target, current - step);
  return current / 1000;
}
