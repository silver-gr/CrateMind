/** «Καθαρά ονόματα»: the Greek words every surface shares (Settings, the why block, the /names page, the
 *  Library filters). The backend's own texts (rule sentences, questions) arrive already in Greek. */
import type { NameStatus } from "./types";

/** `sure` has no label on purpose: a sure name shows nothing. */
export const NAME_STATUS_LABEL: Record<NameStatus, string> = {
  sure: "",
  look: "Για ματιά",
  open: "Για απόφαση",
  none: "Χωρίς καλλιτέχνη",
  hand: "Δική σου διόρθωση",
};

/** The name of each status in a count list, where `sure` needs a word too. */
export const NAME_STATUS_COUNT_LABEL: Record<NameStatus, string> = {
  ...NAME_STATUS_LABEL,
  sure: "Σίγουρα",
};

export const NAME_STATUSES: readonly NameStatus[] = ["sure", "look", "open", "none", "hand"];

/** Shown for status `none`, whose artist is empty. */
export const UNKNOWN_ARTIST = "Άγνωστος καλλιτέχνης";

/** The search tokens of the feature (docs/README.md#search-syntax), for links and quick filters. */
export const NAMES_TOKENS = {
  look: "names:look",
  open: "names:open",
  changed: "names:changed",
  new: "names:new",
} as const;
