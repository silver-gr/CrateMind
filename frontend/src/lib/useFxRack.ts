import { useEffect } from "react";
import { camelotRoot, fallbackKey } from "./camelot";
import { setFxRackKey, startFxRack, stopFxRack } from "./fxRackHost";
import { usePlayer } from "./player";

/** Mounted once, in AppShell: the deck FX rack runs in two-deck mode only. It reads its stores imperatively, so a knob
 * or controller tick does not re-render the shell. */
export function useFxRack(twoDeck: boolean): void {
  const { slots } = usePlayer();
  const a = slots.A.track;
  const b = slots.B.track;
  const keyA = fallbackKey(a);
  const keyB = fallbackKey(b);
  useEffect(() => { setFxRackKey("A", camelotRoot(a?.key_text, keyA)); }, [a?.key_text, keyA]);
  useEffect(() => { setFxRackKey("B", camelotRoot(b?.key_text, keyB)); }, [b?.key_text, keyB]);
  useEffect(() => {
    if (!twoDeck) return;
    void startFxRack();
    return stopFxRack;
  }, [twoDeck]);
}
