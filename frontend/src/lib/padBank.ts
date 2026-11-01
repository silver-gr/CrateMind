// What the controller's pad grid does per deck: hot cues (default), tag bank (Auto Loop button) or status bank (Sampler button).
import type { DeckId } from "./player";

export type PadBank = "cue" | "tag" | "status";
/** The value reported to the controller (numbers only in the snapshot). */
export const PAD_BANK_CODE: Record<PadBank, number> = { cue: 0, tag: 1, status: 2 };

const banks: Record<DeckId, PadBank> = { A: "cue", B: "cue" };
export const getPadBank = (deck: DeckId): PadBank => banks[deck];
export const setPadBank = (deck: DeckId, bank: PadBank) => { banks[deck] = bank; };
export const resetPadBanks = () => { banks.A = "cue"; banks.B = "cue"; };
