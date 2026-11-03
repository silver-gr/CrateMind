import { getPrefs } from "./prefs";

/** BPM analysis windows; mirrors backend/app/services/tempo_ranges.py. */
export type TempoRangeKey = "psy" | "mixed" | "slow" | "therapy";
export type DjRangeKey = Exclude<TempoRangeKey, "therapy">;

export const DJ_RANGE_KEYS: readonly DjRangeKey[] = ["psy", "mixed", "slow"];
export const DEFAULT_DJ_RANGE: DjRangeKey = "psy";

export const TEMPO_RANGE_LABELS: Record<TempoRangeKey, string> = {
  psy: "Psy / hi-tech (133–286)",
  mixed: "Μικτό 4/4 (118–250)",
  slow: "Αργά / downtempo (70–125)",
  therapy: "Μουσικοθεραπεία (40–240)",
};

export function isTempoRangeKey(value: unknown): value is TempoRangeKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(TEMPO_RANGE_LABELS, value);
}

export function isDjRangeKey(value: unknown): value is DjRangeKey {
  return isTempoRangeKey(value) && value !== "therapy";
}

/** Folder windows with stale keys dropped, so a request never gets a 422. */
export function validRootRanges(ranges: unknown): Record<string, DjRangeKey> {
  if (!ranges || typeof ranges !== "object") return {};
  return Object.fromEntries(Object.entries(ranges).filter(([, key]) => isDjRangeKey(key))) as Record<string, DjRangeKey>;
}

export function activeTempoRange(): TempoRangeKey {
  const prefs = getPrefs();
  if (prefs.libraryProfile === "therapy") return "therapy";
  return isDjRangeKey(prefs.djTempoRange) ? prefs.djTempoRange : DEFAULT_DJ_RANGE;
}

export function activeRootRanges(): Record<string, DjRangeKey> {
  const prefs = getPrefs();
  return prefs.libraryProfile === "therapy" ? {} : validRootRanges(prefs.tempoRangeByRoot);
}

export const THERAPY_METHOD = "librosa-onset-wide-v1@40-240";

const DJ_WINDOW_TEXT: Record<DjRangeKey, [span: string, text: string]> = {
  psy: ["133-286", "psy 133–286"],
  mixed: ["118-250", "μικτό 118–250"],
  slow: ["70-125", "αργά 70–125"],
};
const METHOD_LABELS: Record<string, string> = {
  // Before Phase B: one window, no "@lo-hi" suffix.
  "librosa-onset-multilag-v2": "Ανάλυση BPM (135–286)",
  "ffmpeg+onset-autocorr-v1": "Εναλλακτική ανάλυση BPM (135–286)",
  [THERAPY_METHOD]: "Ανάλυση BPM (μουσικοθεραπεία 40–240)",
  ...Object.fromEntries(Object.values(DJ_WINDOW_TEXT).flatMap(([span, text]) => [
    [`librosa-onset-multilag-v2@${span}`, `Ανάλυση BPM (${text})`],
    [`ffmpeg+onset-autocorr-v1@${span}`, `Εναλλακτική ανάλυση BPM (${text})`],
  ])),
};

/** Greek label for a stored `bpm_analyzed_method`; never the raw string. */
export function methodLabel(method?: string | null): string | null {
  if (!method) return null;
  return Object.prototype.hasOwnProperty.call(METHOD_LABELS, method) ? METHOD_LABELS[method] : "Ανάλυση BPM";
}
