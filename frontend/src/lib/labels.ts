import { getPref, type LibraryProfile } from "./prefs";
import { STATUS_VALUES } from "./types";

export type Axis = "energy" | "darkness" | "valence";

const AXIS_LABELS: Record<LibraryProfile, Record<Axis, string>> = {
  dj: { energy: "Ενέργεια", darkness: "Σκοτεινότητα", valence: "Σθένος" },
  therapy: { energy: "Διέγερση", darkness: "Σκοτεινότητα", valence: "Συναισθηματικό σθένος" },
};

/** The shared numeric axes: in therapy energy is arousal («Διέγερση»). */
export function axisLabel(axis: Axis, profile: LibraryProfile = getPref("libraryProfile")): string {
  return AXIS_LABELS[profile][axis];
}

const THERAPY_STATUS_LABELS: Record<string, string> = {
  unknown: "Αταξινόμητο",
  testing: "Υπό δοκιμή",
  approved: "Εγκεκριμένο",
  weapon: "Εγκεκριμένο",
  retired: "Αποσυρμένο",
  avoid: "Αποφυγή",
};

/** The statuses offered by editors; therapy has no "weapon". */
export function statusValues(profile: LibraryProfile = getPref("libraryProfile")): string[] {
  return profile === "therapy" ? STATUS_VALUES.filter(status => status !== "weapon") : [...STATUS_VALUES];
}

/** The status an editor shows as selected: therapy has no "weapon", so a DJ weapon shows as approved. */
export function editorStatus(status?: string | null, profile: LibraryProfile = getPref("libraryProfile")): string {
  if (!status) return "";
  return profile === "therapy" && status === "weapon" ? "approved" : status;
}

/** True when writing `next` would only restate what the editor already shows: in therapy that would erase a DJ weapon. */
export function writesOnlyShownStatus(
  current: string | null | undefined, next: string | null | undefined, profile: LibraryProfile = getPref("libraryProfile"),
): boolean {
  return !!next && current !== next && editorStatus(current, profile) === next;
}

const STATUS_LABELS: Record<string, string> = {
  unknown: "άγνωστο",
  needs_review: "έλεγχος",
  testing: "δοκιμή",
  approved: "εγκεκριμένο",
  weapon: "banger",
  overplayed: "πολυπαιγμένο",
  retired: "αποσυρμένο",
  avoid: "απόφυγε",
};

const FIELD_LABELS: Record<string, string> = {
  energy: "ενέργεια",
  intensity: "ένταση",
  darkness: "σκοτεινότητα",
  melody: "μελωδία",
  weirdness: "ιδιορρυθμία",
  chaos_level: "χάος",
  mixability: "mixability",
  confidence: "σιγουριά",
  role: "ρόλος",
  break: "break",
  tolerance: "ανοχή",
  status: "κατάσταση",
  artist: "καλλιτέχνης",
  artist_scene: "σκηνή καλλιτέχνη",
  artist_subgenre: "subgenre καλλιτέχνη",
  artist_confidence: "σιγουριά καλλιτέχνη",
  artist_review: "έλεγχος καλλιτέχνη",
  not_recent: "όχι πρόσφατα",
  played_recently: "πρόσφατα παιγμένο",
  lufs: "LUFS",
};

const VALUE_LABELS: Record<string, string> = {
  "goa": "Goa Trance",
  "prog-psy": "Prog-psy",
  "full-on": "Full-On",
  "morning-full-on": "Morning Full-On",
  "night-full-on": "Night Full-On",
  "twilight": "Twilight",
  "forest": "Forest",
  "darkpsy": "Darkpsy",
  "hi-tech": "Hi-Tech",
  "psycore": "Psycore",
  "suomi": "Suomi",
  "zenonesque": "Zenonesque",
  untagged: "χωρίς tags",
  weapons: "bangers",
  approved: "εγκεκριμένα",
  weapon: "banger",
  missing: "λείπει",
  never_played: "δεν παίχτηκε ποτέ",
  no_energy: "χωρίς ενέργεια",
  dramatic: "δραματικό",
  can_cut_into: "δέχεται cut-in",
  can_cut_out_of: "βγαίνει με cut-out",
  testing: "δοκιμή",
  bridge: "γέφυρα",
  peak: "κορύφωση",
  reset: "reset",
  builder: "χτίσιμο",
  closer: "κλείσιμο",
  afterglow: "afterglow",
  afterhours: "afterhours",
  native: "φυσικό",
  can_push_up: "ανεβαίνει",
  can_push_down: "κατεβαίνει",
  do_not_warp: "χωρίς warp",
  huge: "μεγάλο",
  "no break": "χωρίς break",
  "short break": "σύντομο break",
  "long melodic break": "μεγάλο μελωδικό break",
  fakeout: "fakeout",
  cinematic: "κινηματογραφικό",
};

const JOB_STATUS_LABELS: Record<string, string> = {
  pending: "Σε αναμονή",
  running: "Τρέχει",
  done: "Ολοκληρώθηκε",
  error: "Σφάλμα",
};

const JOB_KIND_LABELS: Record<string, string> = {
  scan: "Σάρωση",
  fingerprint: "Fingerprint",
  duplicate_scan: "Διπλότυπα",
  analyze: "Ανάλυση BPM + key",
  artist_enrich: "Εμπλουτισμός καλλιτεχνών",
  djay_import: "Import beatgrid djay",
};

export function statusLabel(status?: string | null, profile: LibraryProfile = getPref("libraryProfile")): string {
  if (!status) return "";
  if (profile === "therapy" && THERAPY_STATUS_LABELS[status]) return THERAPY_STATUS_LABELS[status];
  return STATUS_LABELS[status] ?? valueLabel(status);
}

export function fieldLabel(field: string, profile: LibraryProfile = getPref("libraryProfile")): string {
  if (field === "energy" || field === "darkness" || field === "valence") return axisLabel(field, profile).toLocaleLowerCase("el");
  return FIELD_LABELS[field] ?? field;
}

export function valueLabel(value?: string | null): string {
  if (!value) return "";
  return VALUE_LABELS[value] ?? value.replace(/_/g, " ");
}

export function jobStatusLabel(status?: string | null): string {
  if (!status) return "";
  return JOB_STATUS_LABELS[status] ?? valueLabel(status);
}

export function jobKindLabel(kind?: string | null): string {
  if (!kind) return "";
  return JOB_KIND_LABELS[kind] ?? valueLabel(kind);
}

export function translateRecommendationReason(reason: string): string {
  const prefix = reason.match(/^([+-]\s*)/)?.[1] ?? "";
  const body = reason.slice(prefix.length);
  const intoB = body.startsWith("→ into B ");
  const originalText = intoB ? body.slice("→ into B ".length) : body;
  // Round only displayed tempo values, leaving energy, scores and stored BPM intact.
  const text = /^BPM (?:close|near|reachable|far|between A and B|off the A-B path)(?: at (?:half|double) tempo)?:/i.test(originalText)
    ? originalText.replace(/\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi, value => {
      const bpm = Number(value);
      return Number.isFinite(bpm) ? String(Math.round(bpm)) : value;
    })
    : originalText;
  let translated = text
    // A half or double tempo match: translate the plain reason, then say at which tempo it fits.
    .replace(/^(BPM [^:]+) at (half|double) tempo: (.+)$/i, (_, fit: string, fold: string, path: string) =>
      `${fit}: ${path} (στο ${fold.toLowerCase() === "half" ? "μισό" : "διπλό"} tempo)`)
    .replace(/^(key .+) \(uncertain key\)$/i, "$1 (αβέβαιο key)")
    .replace(/^key match (.+)$/i, "ταιριαστό key $1")
    .replace(/^key adjacent (.+)$/i, "γειτονικό key $1")
    .replace(/^key relative (.+)$/i, "σχετικό key $1")
    .replace(/^key clash (.+)$/i, "σύγκρουση key $1")
    .replace(/^style match (.+)$/i, "ίδιο είδος: $1")
    .replace(/^style near (.+?)->(.+)$/i, "κοντινό είδος: $1 → $2")
    .replace(/^BPM between A and B: (.+)$/i, (_, path: string) => `BPM ανάμεσα σε A και B: ${path.replace(/->/g, "→")}`)
    .replace(/^BPM off the A-B path: (.+)$/i, (_, path: string) => `BPM εκτός διαδρομής A→B: ${path.replace(/->/g, "→")}`)
    .replace(/^BPM close: (.+)$/i, "BPM πολύ κοντά: $1")
    .replace(/^BPM near: (.+)$/i, "BPM κοντά: $1")
    .replace(/^BPM reachable: (.+)$/i, "BPM εφικτό: $1")
    .replace(/^BPM far: (.+)$/i, "BPM μακριά: $1")
    .replace(/^energy on target: (.+)$/i, "ενέργεια στον στόχο: $1")
    .replace(/^energy near: (.+)$/i, "ενέργεια κοντά: $1")
    .replace(/^energy ok: (.+)$/i, "ενέργεια οκ: $1")
    .replace(/^energy off: (.+)$/i, "ενέργεια εκτός: $1")
    .replace(/^role match: (.+)$/i, "ταιριαστός ρόλος: $1")
    .replace(/^weapon$/i, "banger")
    .replace(/^approved$/i, "εγκεκριμένο")
    .replace(/^testing$/i, "δοκιμή")
    .replace(/^bridge candidate$/i, "υποψήφια γέφυρα")
    .replace(/^tempo bridge score (.+)$/i, "score γέφυρας tempo $1")
    .replace(/^played recently$/i, "παίχτηκε πρόσφατα")
    .replace(/^fresh \(never played\)$/i, "φρέσκο, δεν παίχτηκε ποτέ")
    .replace(/^weirdness (.+) > max (.+)$/i, "ιδιορρυθμία $1 > μέγιστο $2")
    .replace(/^noted A→this worked:(.*)$/i, "σημείωση A→αυτό δούλεψε:$1")
    .replace(/^noted this→B worked:(.*)$/i, "σημείωση αυτό→B δούλεψε:$1");
  if (intoB) translated = `→ προς B ${translated}`;
  return `${prefix}${translated}`;
}

export function translateSetWarning(message: string): string {
  return message
    .replace(/^BPM jump (.+)$/i, "άλμα BPM $1")
    .replace(/^same artist back-to-back: (.+)$/i, "ίδιος καλλιτέχνης στη σειρά: $1");
}

const IDENTITY_ANCHOR: Record<string, string> = {
  manual_identity_confirmation: "χειροκίνητη επιβεβαίωση",
  existing_manual_review: "προηγούμενος χειροκίνητος έλεγχος",
  legacy_confirmed_manual_review: "παλαιότερος χειροκίνητος έλεγχος",
  existing_exact_metadata: "ίδια μεταδεδομένα",
  identity_v1_guarded_high_confidence: "αυτόματη σύνδεση υψηλής εμπιστοσύνης",
  cleanup_policy_high_confidence: "αυτόματη σύνδεση υψηλής εμπιστοσύνης",
  cleanup_download_provenance: "λήψη από τα SoundCloud Likes",
  existing_rejection: "προηγούμενη απόρριψη",
};

/** Why a candidate already has an identity decision; never the raw acceptance-method key. */
export function identityAnchorLabel(anchor: { method?: string; status?: string }): string {
  if (anchor.status === "rejected") return "προηγούμενη απόρριψη";
  return IDENTITY_ANCHOR[anchor.method ?? ""] ?? "υπάρχουσα απόφαση";
}

export function translateDuplicateReason(reason: string): string {
  return reason
    .replace(/^exact: identical quick_hash$/i, "ακριβές: ίδιο quick_hash")
    .replace(/^metadata: same artist\/title, similar duration — review$/i, "metadata: ίδιος καλλιτέχνης/τίτλος, παρόμοια διάρκεια — έλεγχος")
    .replace(/^audio: same recording by fingerprint — review$/i, "ήχος: ίδια ηχογράφηση (αποτύπωμα ήχου, π.χ. preview και πλήρες) — έλεγχος");
}

const API_ERROR_LABELS: Record<string, string> = {
  "track not found": "Το track δεν βρέθηκε",
  "set not found": "Το set δεν βρέθηκε",
  "track not in set": "Το track δεν ανήκει στο set",
  "cue not found": "Το cue δεν βρέθηκε",
  "tag not found": "Το tag δεν βρέθηκε",
  "assignment not found": "Το track δεν έχει αυτό το tag",
  "artist not found": "Ο καλλιτέχνης δεν βρέθηκε",
  "artwork not found": "Δεν υπάρχει εξώφυλλο",
  "beatgrid not found": "Δεν υπάρχει beatgrid",
  "group not found": "Η ομάδα διπλοτύπων δεν βρέθηκε",
  "job not found": "Η εργασία δεν βρέθηκε",
  "saved search not found": "Το crate δεν βρέθηκε",
  "detail waveform unavailable": "Η κυματομορφή δεν είναι διαθέσιμη",
  "audio file no longer present on disk": "Το αρχείο ήχου δεν υπάρχει πια στον δίσκο",
  "cue position exceeds track duration (100ms tolerance)": "Η θέση του cue είναι μετά το τέλος του track",
  "downbeat exceeds track duration": "Το downbeat είναι μετά το τέλος του track",
  "downbeat must be a finite time >= 0": "Το downbeat πρέπει να είναι χρόνος από 0 και πάνω",
  "out_anchor_s exceeds track duration": "Το σημείο εξόδου είναι μετά το τέλος του track",
  "in_anchor_s exceeds track duration": "Το σημείο εισόδου είναι μετά το τέλος του track",
  "out_anchor_s must be a finite time >= 0": "Το σημείο εξόδου πρέπει να είναι χρόνος από 0 και πάνω",
  "in_anchor_s must be a finite time >= 0": "Το σημείο εισόδου πρέπει να είναι χρόνος από 0 και πάνω",
  "no tracks to export": "Δεν υπάρχουν tracks για export",
  "markdown export requires set_id": "Το export Markdown χρειάζεται ένα set",
  "provide tag_id or name": "Διάλεξε ένα tag ή γράψε όνομα",
  "artist comparison not found.": "Η σύγκριση καλλιτέχνη δεν βρέθηκε",
  "new finding is not ready.": "Το νέο εύρημα δεν είναι έτοιμο ακόμα",
  "enter a substyle.": "Γράψε ένα substyle",
  "configure llm1 before enriching artists.": "Ρύθμισε πρώτα το μοντέλο στις Ρυθμίσεις › «Μοντέλο τεχνητής νοημοσύνης»",
  "no library roots configured. set cratemind_library_roots.": "Δεν έχει οριστεί φάκελος μουσικής",
  "fpcalc/chromaprint not found on path.": "Δεν βρέθηκε το fpcalc (Chromaprint), που χρειάζεται για τα fingerprints",
};

const API_STATUS_LABELS: Record<number, string> = {
  400: "Το αίτημα δεν είναι έγκυρο",
  404: "Δεν βρέθηκε",
  409: "Δεν γίνεται στην τρέχουσα κατάσταση",
  410: "Δεν υπάρχει πια",
  415: "Το format δεν υποστηρίζεται",
  422: "Τα στοιχεία δεν είναι έγκυρα",
  503: "Η υπηρεσία είναι απασχολημένη, δοκίμασε ξανά",
  504: "Η υπηρεσία άργησε να απαντήσει",
};

/** Shown when the request never reached the backend (the browser's own text is English). */
export const API_UNREACHABLE = "Δεν υπάρχει σύνδεση με την υπηρεσία του CrateMind";

/** Backend error details are partly English. Known ones map to Greek, Greek ones pass through, and any
 *  other English text falls back to a Greek line for the HTTP status. `req` in api.ts applies this to every error. */
export function translateApiError(status: number, detail: string): string {
  const text = detail.replace(/^Value error, /, "").trim();
  if (/[\u0370-\u03ff]/.test(text)) return text;
  const known = API_ERROR_LABELS[text.toLowerCase()];
  if (known) return known;
  const format = /^unsupported audio format for in-browser audition: (\S+)$/i.exec(text);
  if (format) return `Το format ${format[1]} δεν παίζει μέσα στην εφαρμογή`;
  const source = /^(\S+) BPM is unavailable$/i.exec(text);
  if (source) return `Δεν υπάρχει BPM από την πηγή ${source[1]}`;
  const provider = /^(\S+) is enabled but \S+ is missing\.$/i.exec(text);
  if (provider) return `Το ${provider[1]} είναι ενεργό, αλλά λείπει το κλειδί του`;
  if (/^Artist enrichment job \d+ is already active\.$/i.test(text)) return "Τρέχει ήδη εμπλουτισμός καλλιτεχνών";
  return API_STATUS_LABELS[status] ?? (status >= 500 ? "Σφάλμα της υπηρεσίας" : "Το αίτημα απέτυχε");
}

/** A task's outcome (scan, fingerprint, analysis, duplicates, research, backup import) stays on screen until closed:
 *  the user may be on another screen, minimised or away while it runs. Every other toast times out. */
export const TASK_RESULT_TOAST = { duration: Infinity, closeButton: true } as const;

/** Job errors arrive as raw backend exception text. Known causes become Greek; unknown English text
 *  falls back to the generic Greek line (the raw text stays in the jobs table for diagnosis). */
export function translateJobError(error: string | null | undefined, fallback: string): string {
  if (!error) return fallback;
  const cause = /disk is full|no space left/i.test(error) ? "ο δίσκος είναι γεμάτος"
    : /readonly database|read-only/i.test(error) ? "η βάση δεν δέχεται εγγραφές, κάνε επανεκκίνηση της εφαρμογής"
    : /database is locked/i.test(error) ? "η βάση είναι απασχολημένη από άλλη εργασία"
    : null;
  if (/^Catalog scan saved; identity synchronization failed/i.test(error)) {
    return `Η σάρωση αποθηκεύτηκε, αλλά ο συγχρονισμός των ταυτοτήτων απέτυχε${cause ? ` (${cause})` : ""}. Τρέξε ξανά τη σάρωση.`;
  }
  if (cause) return `${fallback}: ${cause}.`;
  return /[\u0370-\u03ff]/.test(error) ? error : fallback;
}

export function translateJobMessage(message: string): string {
  // Scan warnings follow the counts as "; <warning>" parts; the anchored summaries below read the counts without them.
  const cut = message.indexOf("; ");
  if (cut > 0) return translateJobMessage(message.slice(0, cut)) + translateJobMessage(message.slice(cut));
  // A run that built beatgrids or track structures, re-analysed keys or measured loudness appends ", beatgrids N", ", structures N",
  // ", keys N" and ", loudness N", then ", phase failures N"; the summaries below are anchored, so they are set aside first.
  const phaseFailures = /, phase failures (\d+)$/i.exec(message);
  if (phaseFailures) return `${translateJobMessage(message.slice(0, phaseFailures.index))}, Αποτυχίες σε beatgrid/key/LUFS: ${phaseFailures[1]}`;
  const loudness = /, loudness (\d+)$/i.exec(message);
  if (loudness) return `${translateJobMessage(message.slice(0, loudness.index))}, Μέτρηση LUFS: ${loudness[1]}`;
  const keys = /, keys (\d+)$/i.exec(message);
  if (keys) return `${translateJobMessage(message.slice(0, keys.index))}, Νέα ανάλυση key: ${keys[1]}`;
  const structures = /, structures (\d+)$/i.exec(message);
  if (structures) return `${translateJobMessage(message.slice(0, structures.index))}, Δομές: ${structures[1]}`;
  const grids = /, beatgrids (\d+)$/i.exec(message);
  if (grids) return `${translateJobMessage(message.slice(0, grids.index))}, Beatgrids: ${grids[1]}`;
  return message
    .replace(/^added (\d+), updated (\d+), unchanged (\d+), missing (\d+)(?=,|;| \(|$)/i, "Προστέθηκαν: $1, Ενημερώθηκαν: $2, Αμετάβλητα: $3, Λείπουν: $4")
    .replace(/, skipped duplicates (\d+)/i, ", Παραλείφθηκαν διπλότυπα: $1")
    .replace(/, merged moved (\d+)/i, ", Συγχωνεύτηκαν μετακινημένα: $1")
    .replace(/, analyzed (\d+), analysis failed (\d+)/i, ", Αναλύθηκαν: $1, Αποτυχίες ανάλυσης: $2")
    .replace(/new-track analysis failed/i, "η ανάλυση νέων tracks απέτυχε")
    .replace(/^analyzing (\d+) new tracks$/i, "Ανάλυση BPM και key για $1 νέα tracks")
    .replace(/^analyzed (\d+), failed (\d+), essentia (\d+), validation failed (\d+)$/i, "Αναλύθηκαν: $1, Απέτυχαν: $2, Essentia: $3, Αποτυχίες validation: $4")
    .replace(/^fingerprinted (\d+)$/i, "Δημιουργήθηκαν fingerprints για $1 tracks")
    .replace(/^groups (\d+)$/i, (_match, count: string) => count === "0" ? "Δεν βρέθηκαν διπλότυπα"
      : count === "1" ? "Βρέθηκε 1 ομάδα διπλοτύπων" : `Βρέθηκαν ${count} ομάδες διπλοτύπων`)
    .replace(/^matched (\d+), added (\d+), updated (\d+), unchanged (\d+)$/i, "Αντιστοιχίστηκαν: $1, Προστέθηκαν: $2, Ενημερώθηκαν: $3, Αμετάβλητα: $4")
    // Scan warnings: "; <root>: missing-file detection skipped (<OS error>)". The OS text is English, so only a known cause is kept.
    .replace(/; (.+?): missing-file detection skipped \(([^)]*)\)/gi, (_match, root: string, cause: string) =>
      `; ${root}: δεν ελέγχθηκε για αρχεία που λείπουν${/no such file|not found/i.test(cause) ? " (ο φάκελος δεν βρέθηκε)" : /permission|not permitted/i.test(cause) ? " (δεν υπάρχει άδεια πρόσβασης)" : ""}`)
    .replace(/ \(artist rebuild failed: .*\)/i, " (η ενημέρωση των καλλιτεχνών απέτυχε)")
    .replace(
      /^analyzed (\d+), failed (\d+), essentia (\d+), validation failed (\d+), disagreements (\d+), reccobeats (\d+), reccobeats failed (\d+), getsongbpm (\d+), getsongbpm failed (\d+), consensus (\d+), review (\d+), cyanite submitted (\d+), cyanite finished (\d+), cyanite failed (\d+), cyanite skipped (\d+)$/i,
      "Κύρια ανάλυση: $1, Αποτυχίες: $2, Essentia: $3, Αποτυχίες validation: $4, Διαφωνίες: $5, ReccoBeats: $6, Αποτυχίες ReccoBeats: $7, GetSongBPM: $8, Αποτυχίες GetSongBPM: $9, Consensus: $10, Για έλεγχο: $11, Στάλθηκαν Cyanite: $12, Ολοκληρώθηκαν Cyanite: $13, Αποτυχίες Cyanite: $14, Χωρίς credit: $15",
    )
    .replace(/^analyzed (\d+), failed (\d+)$/i, "Αναλύθηκαν: $1, Απέτυχαν: $2")
    .replace(/^enriched (\d+), failed (\d+)$/i, "Εμπλουτίστηκαν: $1, Απέτυχαν: $2");
}
