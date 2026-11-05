// Greek UI copy for transitions (plan Appendix B). Never show a preset, curve or reason key: go through here.
import type { EqCurve, FilterCurve, LoopBeats, NamedPreset, Preset, ReasonCode, VolumeCurve } from "./types";

export const PRESET_LABELS: Record<Preset, string> = {
  auto: "Αυτόματο", custom: "Προσαρμογή", fade: "Ξεθώριασμα", rise: "Άνοδος", blend: "Ανάμειξη", wave: "Κύμα",
  melt: "Λιώσιμο", slam: "Κόψιμο", dissolve: "Διάλυση", surge: "Έκρηξη", afterglow: "Απόηχος", none: "Χωρίς μετάβαση",
};

export const VOLUME_LABELS: Record<VolumeCurve, string> = {
  smooth: "Ομαλό crossfade", overlap: "Επικάλυψη", fade_fade: "Fade in / fade out", cut_fade: "Cut in / fade out",
  fade_cut: "Fade in / cut out", center_cut: "Κεντρικό cut", linear: "Γραμμικό crossfade", fade_fast: "Fade in / γρήγορο out",
};

export const EQ_LABELS: Record<EqCurve, string> = {
  bass_swap_center: "Εναλλαγή μπάσων στο κέντρο", bass_swap_end: "Εναλλαγή μπάσων στο τέλος",
  bass_swap_start: "Εναλλαγή μπάσων στην αρχή", three_band: "Fade 3 ζωνών", bass_cut_quick: "Γρήγορο κόψιμο μπάσων",
  bass_cut_long: "Αργό κόψιμο μπάσων", fade_out_start: "Fade out από την αρχή", bass_fade_out: "Fade out μπάσων", none: "Καμία",
};

export const FILTER_LABELS: Record<FilterCurve, string> = {
  lpf_out: "LP έξοδος", lpf_in: "LP είσοδος", lpf_in_lpf_out: "LP είσοδος / LP έξοδος", lpf_in_hpf_out: "LP είσοδος / HP έξοδος",
  hpf_out: "HP έξοδος", hpf_in: "HP είσοδος", hpf_in_hpf_out: "HP είσοδος / HP έξοδος", hpf_in_lpf_out: "HP είσοδος / LP έξοδος",
  hpf_half_out: "HP μισή έξοδος", none: "Κανένα",
};

export const REASON_LABELS: Record<ReasonCode, string> = {
  same_key: "ίδιο κλειδί", adjacent_key: "γειτονικό κλειδί", relative_key: "σχετικό κλειδί", key_clash: "ασύμβατα κλειδιά",
  key_unknown: "άγνωστο κλειδί", bpm_close: "κοντινό BPM", bpm_far: "μακρινό BPM", bpm_out_of_range: "BPM εκτός εύρους pitch",
  bpm_unknown: "άγνωστο BPM", profile_cut: "το προφίλ επιτρέπει cut", profile_blend: "το προφίλ ζητά ανάμειξη",
  no_grid: "χωρίς beatgrid", no_room: "δεν χωρά παράθυρο", exit_cue: "από το exit cue", entry_cue: "στο entry cue",
  grid_estimated: "εκτιμώμενο grid",
};

/** Status strip, pill and editor strings. */
export const MIX_COPY = {
  mix: "Μίξη", now: "τώρα", next: "επόμενο", transitionTo: "μετάβαση σε", skip: "Παράλειψη", stop: "Διακοπή",
  started: "Η μίξη ξεκίνησε", stopped: "Η μίξη σταμάτησε", lateCut: "Το επόμενο track δεν φορτώθηκε εγκαίρως — απλό cut",
  cut: "απλό cut", stopHint: "Διακοπή μίξης (η αναπαραγωγή συνεχίζει)", stopHintWindow: "Διακοπή μίξης (συνεχίζει μόνο το επόμενο track)",
  notLoaded: "Η μίξη σταμάτησε: το επόμενο track δεν φορτώθηκε", pressAgain: "Πάτα ξανά για αντικατάσταση",
  unmixable: "χωρίς μίξη", previewTransition: "Προεπισκόπηση μετάβασης", savedTransition: "Αποθηκευμένη μετάβαση",
  editorTitle: "Επεξεργασία μετάβασης", save: "Αποθήκευση", close: "Κλείσιμο", preview: "Προεπισκόπηση",
  resetAuto: "Επαναφορά σε Αυτόματο", unsaved: "Μη αποθηκευμένες αλλαγές", discard: "Απόρριψη", tempoMatch: "Ταίριασμα tempo",
  volume: "Ένταση", eq: "EQ", filter: "Φίλτρο", loop: "Loop", saved: "Η μετάβαση αποθηκεύτηκε",
  playAsMix: "Αναπαραγωγή ως μίξη", stopMix: "Διακοπή μίξης",
  unplayable: "δεν παίζει στα decks", unplayableHint: "Το ένα track (AIFF) δεν παίζει στα decks: η μίξη το παραλείπει",
  tooFewPlayable: "Η μίξη δεν ξεκίνησε: χρειάζονται τουλάχιστον δύο tracks που παίζουν στα decks",
} as const;

/** The toast when «Αναπαραγωγή ως μίξη» skips tracks the decks cannot play; names at most three. */
export function skippedUnplayable(titles: readonly string[]): string {
  const named = titles.slice(0, 3).map(t => `«${t}»`).join(", ");
  if (titles.length === 1) return `Η μίξη παραλείπει το ${named}: δεν παίζει στα decks (AIFF)`;
  const more = titles.length > 3 ? " κ.ά." : "";
  return `Η μίξη παραλείπει ${titles.length} tracks που δεν παίζουν στα decks (AIFF): ${named}${more}`;
}

export const LOOP_LABELS: Record<LoopBeats | "none", string> = {
  1: "1 beat loop", 2: "2 beat loop", 4: "4 beat loop", 8: "8 beat loop", 16: "16 beat loop", none: "Χωρίς loop",
};

export const loopLabel = (beats: LoopBeats | null) => LOOP_LABELS[beats ?? "none"];

/** Editor controls (overview, presets row, length and nudge buttons). The nudge buttons' accessible names are full Greek sentences. */
export const CONTROL_COPY = {
  presets: "Τύπος μετάβασης", overview: "Επισκόπηση των δύο tracks", viewport: "Περιοχή προβολής",
  length: "Διάρκεια", window: "Παράθυρο", incoming: "Είσοδος", bars: "Διάρκεια σε bars",
  barsLess: "−1 bar · Μείωση διάρκειας", barsMore: "+1 bar · Αύξηση διάρκειας",
  windowBarBack: "Μετακίνηση παραθύρου 1 bar πίσω", windowBeatBack: "Μετακίνηση παραθύρου 1 beat πίσω",
  windowBeatFwd: "Μετακίνηση παραθύρου 1 beat μπροστά", windowBarFwd: "Μετακίνηση παραθύρου 1 bar μπροστά",
  inBeatBack: "Μετακίνηση εισόδου 1 beat αριστερά", inBeatFwd: "Μετακίνηση εισόδου 1 beat δεξιά",
  autoLocked: "Η μετάβαση είναι αποθηκευμένη: για Αυτόματο πάτα «Επαναφορά σε Αυτόματο»",
  rate: "Ρυθμός εισόδου",
} as const;

/** Editor dialog strings beyond MIX_COPY (toasts, lane labels, the no-grid notice, preview states). */
export const EDITOR_COPY = {
  saving: "Αποθήκευση…", saveFailed: "Δεν ήταν δυνατή η αποθήκευση της μετάβασης",
  resetDone: "Η μετάβαση επανήλθε σε Αυτόματο", resetFailed: "Δεν ήταν δυνατή η επαναφορά σε Αυτόματο",
  outgoing: "Έξοδος", incoming: "Είσοδος", stopPreview: "Διακοπή προεπισκόπησης",
  previewHint: "πλήκτρο διαστήματος", noGrid: "Ένα από τα δύο κομμάτια δεν έχει beatgrid: η μετάβαση θα γίνει cut.",
  loading: "Φόρτωση beatgrid…", cutNotice: "Χωρίς μετάβαση: το επόμενο track μπαίνει με cut στο τέλος.",
  unmixable: "Το ένα track δεν παίζει στη μηχανή μίξης: η μετάβαση θα γίνει cut και η προεπισκόπηση δεν είναι διαθέσιμη.",
  unplayable: "Το ένα track (AIFF) δεν παίζει στα decks: η μίξη το παραλείπει και η προεπισκόπηση δεν είναι διαθέσιμη.",
} as const;

export const reasonLabel = (code: string): string | null => (REASON_LABELS as Record<string, string>)[code] ?? null;

/** «ίδιο κλειδί · κοντινό BPM»: why Auto chose its preset. Unknown codes are dropped, never shown raw. */
export const describeAuto = (reasons: readonly string[]) =>
  reasons.map(reasonLabel).filter((label): label is string => label !== null).join(" · ");

/** «Αυτόματο · Ανάμειξη» for an Auto row, otherwise the preset's own name. */
export const presetLabel = (preset: Preset, resolved: NamedPreset | null) =>
  preset === "auto" && resolved ? `${PRESET_LABELS.auto} · ${PRESET_LABELS[resolved]}` : PRESET_LABELS[preset];
