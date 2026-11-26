// Greek UI copy for transitions (plan Appendix B). Never show a preset, curve or reason key: go through here.
import type { TransitionFlags } from "./flags";
import { MAX_TEMPO_DEVIATION, STRETCH_WARN } from "./planner";
import type { EqCurve, FilterCurve, LoopBeats, NamedPreset, Preset, ReasonCode, TransitionParams, VolumeCurve } from "./types";

export const PRESET_LABELS: Record<Preset, string> = {
  auto: "Αυτόματο", custom: "Προσαρμογή", fade: "Ξεθώριασμα", rise: "Άνοδος", blend: "Ανάμειξη", wave: "Κύμα",
  melt: "Λιώσιμο", slam: "Κόψιμο", dissolve: "Διάλυση", surge: "Έκρηξη", afterglow: "Απόηχος",
  echo_out: "Έξοδος με echo", long_blend: "Μακριά ανάμειξη", none: "Χωρίς μετάβαση",
};

export const VOLUME_LABELS: Record<VolumeCurve, string> = {
  smooth: "Ομαλό crossfade", overlap: "Επικάλυψη", fade_fade: "Fade in / fade out", cut_fade: "Cut in / fade out",
  fade_cut: "Fade in / cut out", center_cut: "Κεντρικό cut", linear: "Γραμμικό crossfade", fade_fast: "Fade in / γρήγορο out",
  echo_out: "Echo και cut στη μέση",
};

export const EQ_LABELS: Record<EqCurve, string> = {
  bass_swap_center: "Εναλλαγή μπάσων στο κέντρο", bass_swap_end: "Εναλλαγή μπάσων στο τέλος",
  bass_swap_start: "Εναλλαγή μπάσων στην αρχή", three_band: "Fade 3 ζωνών", bass_cut_quick: "Γρήγορο κόψιμο μπάσων",
  bass_cut_long: "Αργό κόψιμο μπάσων", fade_out_start: "Fade out από την αρχή", bass_fade_out: "Fade out μπάσων",
  bass_swap_staged: "Σταδιακά: μπάσα στη μέση, μεσαία και πρίμα στο τέλος", none: "Καμία",
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
  grid_estimated: "εκτιμώμενο grid", structure_out: "έξοδος από τη δομή", structure_in: "είσοδος από τη δομή",
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
  echoOut: "Το track που φεύγει παίζει μόνο του, η ηχώ του δυναμώνει στα τελευταία beats και στη μέση του παραθύρου κόβεται: το επόμενο track ακούγεται από εκεί, πάνω στην ουρά της ηχούς",
  echoNoFx: "Τα εφέ δεν είναι διαθέσιμα: αυτή η μετάβαση θα παίξει ως απλό cut στη μέση του παραθύρου, χωρίς ηχώ",
  longBlend: "Μεγάλη επικάλυψη 32 bars: το επόμενο track μπαίνει χωρίς μπάσα, τα μπάσα αλλάζουν στη μέση και τα μεσαία και τα πρίμα του track που φεύγει σβήνουν τελευταία",
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

/** «Χρονισμός από τη δομή»: the switch, its per-pair hint and the two lane markers. */
export const STRUCTURE_COPY = {
  toggle: "Χρονισμός από τη δομή", scope: "για όλες τις μεταβάσεις",
  outPhrase: "Έξοδος: σε γραμμή φράσης", outSame: "Έξοδος: όπως πριν",
  inBass: "Είσοδος: το πρώτο μπάσο στην εναλλαγή", inSame: "Είσοδος: όπως πριν",
  anchored: "Η μετάβαση έχει δικό της παράθυρο", firstBass: "Πρώτο μπάσο", bassEnd: "Τέλος μπάσου",
} as const;

/** What the structure decided for a pair, from the planner's reasons; `anchored`: the draft holds both anchors. */
export const structureHint = (reasons: readonly string[], anchored: boolean): string => anchored ? STRUCTURE_COPY.anchored
  : `${reasons.includes("structure_out") ? STRUCTURE_COPY.outPhrase : STRUCTURE_COPY.outSame} · ${reasons.includes("structure_in") ? STRUCTURE_COPY.inBass : STRUCTURE_COPY.inSame}`;

export interface StretchChip { tone: "amber" | "rose"; label: string; title: string }
/**
 * The warning chip for a pair whose tempos are `dev` apart (`tempoDeviation`): rose above the 16 % limit, where no
 * tempo match happens; amber above 8 % when the match is on. None for «Χωρίς μετάβαση».
 */
export function stretchChip(dev: number | null, params: Pick<TransitionParams, "preset" | "tempo_match">): StretchChip | null {
  if (dev == null || params.preset === "none") return null;
  const pct = Math.round(dev * 100);
  if (dev > MAX_TEMPO_DEVIATION) return { tone: "rose", label: "Χωρίς ταίριασμα tempo", title: `Τα tempo απέχουν ${pct} %, πάνω από το όριο 16 %: κάθε track παίζει στο δικό του tempo` };
  if (params.tempo_match && dev > STRETCH_WARN) return { tone: "amber", label: `Stretch ${pct} %`, title: `Το επόμενο track αλλάζει tempo κατά ${pct} % για να ταιριάξει` };
  return null;
}

const bars = (n: number) => `${Math.round(n)} bars`;
/** The checker's chips (`transitionFlags`), in the stretch chip's look: each title says what it means and what to do. */
export function flagChips(f: Partial<TransitionFlags>): StretchChip[] {
  const chips: StretchChip[] = [];
  if (f.bassBars != null) chips.push({ tone: "amber", label: "Δύο μπάσα μαζί", title: `Για περίπου ${bars(f.bassBars)} ακούγονται μαζί τα μπάσα και των δύο tracks και το μείγμα θολώνει: διάλεξε στο EQ μια «Εναλλαγή μπάσων» ή μίκρυνε τη μετάβαση` });
  if (f.offPhrase) chips.push({ tone: "amber", label: "Εκτός φράσης", title: "Οι φράσεις των δύο tracks (ανά 8 bars) δεν ξεκινούν μαζί μέσα στη μετάβαση: μετακίνησε την είσοδο ή το παράθυρο ή άναψε «Χρονισμός από τη δομή»" });
  if (f.keyBars != null) chips.push({ tone: "amber", label: "Απότομη αλλαγή τονικότητας", title: `Τα κλειδιά των δύο tracks δεν ταιριάζουν στον τροχό Camelot και ακούγονται μαζί για περίπου ${bars(f.keyBars)}: μίκρυνε τη μετάβαση, διάλεξε τύπο με λιγότερη επικάλυψη ή βάλε ανάμεσα ένα track-γέφυρα` });
  return chips;
}

export const reasonLabel =(code: string): string | null => (REASON_LABELS as Record<string, string>)[code] ?? null;

/** «ίδιο κλειδί · κοντινό BPM»: why Auto chose its preset. Unknown codes are dropped, never shown raw. */
export const describeAuto = (reasons: readonly string[]) =>
  reasons.map(reasonLabel).filter((label): label is string => label !== null).join(" · ");

/** «Αυτόματο · Ανάμειξη» for an Auto row, otherwise the preset's own name. */
export const presetLabel = (preset: Preset, resolved: NamedPreset | null) =>
  preset === "auto" && resolved ? `${PRESET_LABELS.auto} · ${PRESET_LABELS[resolved]}` : PRESET_LABELS[preset];
