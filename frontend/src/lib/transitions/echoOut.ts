// «Έξοδος με echo» (pure): where in the window the outgoing deck's Echo rises. The volume curve `echo_out` cuts at the
// middle; the echo comes up over the last beats before that cut and its tail rings over the second half.

/** The cut, as a fraction of the window. */
export const ECHO_CUT_U = 0.5;
/** The echo rises over this many beats before the cut (less when the first half is shorter). */
export const ECHO_RISE_BEATS = 8;
/** The FX rack amount the echo reaches (the rack's default amount). */
export const ECHO_AMOUNT = 0.7;

/** The rise as fractions of the window: silent before `fromU`, full from `toU` (the cut). */
export interface EchoWindow { fromU: number; toU: number }

/** `beatFraction` = one beat as a fraction of the window. */
export const echoWindow = (beatFraction: number): EchoWindow =>
  ({ fromU: Math.max(0, ECHO_CUT_U - ECHO_RISE_BEATS * beatFraction), toU: ECHO_CUT_U });

/** The echo's level 0..1 at `u`: 0 before the rise, linear through it, 1 from the cut on. */
export function echoLevel(e: EchoWindow, u: number): number {
  if (u >= e.toU) return 1;
  return u <= e.fromU ? 0 : (u - e.fromU) / (e.toU - e.fromU);
}
