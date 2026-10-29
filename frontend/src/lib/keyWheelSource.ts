import { camelotCode, toCamelot } from "./camelot";
import type { Track } from "./types";

export type KeyWheelSource = "playing" | "selection" | "last";
export const KEY_WHEEL_SOURCES: KeyWheelSource[] = ["playing", "selection", "last"];

export const KEY_WHEEL_SOURCE_LABELS: Record<KeyWheelSource, string> = {
  playing: "Παίζει",
  selection: "Επιλογή",
  last: "Τελευταίο",
};

/** Keep recognized metadata first, then try analysis if the tag cannot be parsed. */
export function canonicalCamelot(track?: Pick<Track, "key_text" | "key_analyzed"> | null): string | null {
  if (!track) return null;
  const key = toCamelot(track.key_text?.trim().replace(/^~/, ""))
    ?? toCamelot(track.key_analyzed?.trim().replace(/^~/, ""));
  return key ? camelotCode(key) : null;
}

export function resolveKeyWheelSource(
  preferred: KeyWheelSource,
  keys: Record<KeyWheelSource, string | null>,
): KeyWheelSource | null {
  if (keys[preferred]) return preferred;
  return (["last", "selection", "playing"] as const).find(source => keys[source] !== null) ?? null;
}
