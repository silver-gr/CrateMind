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
  notLoaded: "Η μίξη σταμάτησε: το επόμενο track δεν φορτώθηκε", pressAgain: "Πάτα ξανά για αντικατάσταση",
  unmixable: "χωρίς μίξη", previewTransition: "Προεπισκόπηση μετάβασης", savedTransition: "Αποθηκευμένη μετάβαση",
  editorTitle: "Επεξεργασία μετάβασης", save: "Αποθήκευση", close: "Κλείσιμο", preview: "Προεπισκόπηση",
  resetAuto: "Επαναφορά σε Αυτόματο", unsaved: "Μη αποθηκευμένες αλλαγές", discard: "Απόρριψη", tempoMatch: "Ταίριασμα tempo",
  volume: "Ένταση", eq: "EQ", filter: "Φίλτρο", loop: "Loop", saved: "Η μετάβαση αποθηκεύτηκε",
} as const;

export const loopLabel = (beats: LoopBeats | null) => (beats == null ? "Χωρίς loop" : `${beats} beat loop`);

export const reasonLabel = (code: string): string | null => (REASON_LABELS as Record<string, string>)[code] ?? null;

/** «ίδιο κλειδί · κοντινό BPM»: why Auto chose its preset. Unknown codes are dropped, never shown raw. */
export const describeAuto = (reasons: readonly string[]) =>
  reasons.map(reasonLabel).filter((label): label is string => label !== null).join(" · ");

/** «Αυτόματο · Ανάμειξη» for an Auto row, otherwise the preset's own name. */
export const presetLabel = (preset: Preset, resolved: NamedPreset | null) =>
  preset === "auto" && resolved ? `${PRESET_LABELS.auto} · ${PRESET_LABELS[resolved]}` : PRESET_LABELS[preset];
