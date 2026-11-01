const STATUS_LABELS: Record<string, string> = {
  unknown: "άγνωστο",
  needs_review: "έλεγχος",
  testing: "δοκιμή",
  approved: "εγκεκριμένο",
  weapon: "όπλο",
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
  artist_scene: "σκηνή καλλιτέχνη",
  artist_subgenre: "subgenre καλλιτέχνη",
  artist_confidence: "σιγουριά καλλιτέχνη",
  artist_review: "έλεγχος καλλιτέχνη",
  not_recent: "όχι πρόσφατα",
  played_recently: "πρόσφατα παιγμένο",
};

const VALUE_LABELS: Record<string, string> = {
  "prog-psy": "Prog-psy",
  "full-on": "Full-on",
  "forest": "Forest",
  "darkpsy": "Darkpsy",
  "hi-tech": "Hi-tech",
  "psycore": "Psycore",
  "suomi": "Suomi",
  "zenonesque": "Zenonesque",
  untagged: "χωρίς tags",
  weapons: "όπλα",
  approved: "εγκεκριμένα",
  weapon: "όπλο",
  missing: "λείπει",
  never_played: "δεν παίχτηκε ποτέ",
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
  pending: "σε αναμονή",
  running: "τρέχει",
  done: "ολοκληρώθηκε",
  error: "σφάλμα",
};

const JOB_KIND_LABELS: Record<string, string> = {
  scan: "scan",
  fingerprint: "fingerprint",
  duplicate_scan: "διπλότυπα",
  analyze: "ανάλυση BPM + key",
  artist_enrich: "εμπλουτισμός καλλιτεχνών",
  djay_import: "import beatgrid djay",
};

export function statusLabel(status?: string | null): string {
  if (!status) return "";
  return STATUS_LABELS[status] ?? valueLabel(status);
}

export function fieldLabel(field: string): string {
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
  const text = /^BPM (?:close|near|reachable|far):/i.test(originalText)
    ? originalText.replace(/\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi, value => {
      const bpm = Number(value);
      return Number.isFinite(bpm) ? String(Math.round(bpm)) : value;
    })
    : originalText;
  let translated = text
    .replace(/^key match (.+)$/i, "ταιριαστό key $1")
    .replace(/^key adjacent (.+)$/i, "γειτονικό key $1")
    .replace(/^key relative (.+)$/i, "σχετικό key $1")
    .replace(/^key clash (.+)$/i, "σύγκρουση key $1")
    .replace(/^BPM close: (.+)$/i, "BPM πολύ κοντά: $1")
    .replace(/^BPM near: (.+)$/i, "BPM κοντά: $1")
    .replace(/^BPM reachable: (.+)$/i, "BPM εφικτό: $1")
    .replace(/^BPM far: (.+)$/i, "BPM μακριά: $1")
    .replace(/^energy on target: (.+)$/i, "ενέργεια στον στόχο: $1")
    .replace(/^energy near: (.+)$/i, "ενέργεια κοντά: $1")
    .replace(/^energy ok: (.+)$/i, "ενέργεια οκ: $1")
    .replace(/^energy off: (.+)$/i, "ενέργεια εκτός: $1")
    .replace(/^role match: (.+)$/i, "ταιριαστός ρόλος: $1")
    .replace(/^weapon$/i, "όπλο")
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

export function translateDuplicateReason(reason: string): string {
  return reason
    .replace(/^exact: identical quick_hash$/i, "ακριβές: ίδιο quick_hash")
    .replace(/^metadata: same artist\/title, similar duration — review$/i, "metadata: ίδιος καλλιτέχνης/τίτλος, παρόμοια διάρκεια — έλεγχος");
}

export function translateJobMessage(message: string): string {
  return message
    .replace(/^added (\d+), updated (\d+), unchanged (\d+), missing (\d+)(?=,|;| \(|$)/i, "προστέθηκαν $1, ενημερώθηκαν $2, αμετάβλητα $3, λείπουν $4")
    .replace(/, skipped duplicates (\d+)/i, ", παραλείφθηκαν διπλότυπα $1")
    .replace(/, analyzed (\d+), analysis failed (\d+)/i, ", αναλύθηκαν $1, αποτυχίες ανάλυσης $2")
    .replace(/new-track analysis failed:/i, "η ανάλυση νέων tracks απέτυχε:")
    .replace(/^analyzing (\d+) new tracks$/i, "ανάλυση BPM και key για $1 νέα tracks")
    .replace(/^analyzed (\d+), failed (\d+), essentia (\d+), validation failed (\d+)$/i, "αναλύθηκαν $1, απέτυχαν $2, Essentia $3, αποτυχίες validation $4")
    .replace(/^fingerprinted (\d+)$/i, "fingerprinted $1")
    .replace(/^groups (\d+)$/i, "groups $1")
    .replace(
      /^analyzed (\d+), failed (\d+), essentia (\d+), validation failed (\d+), disagreements (\d+), reccobeats (\d+), reccobeats failed (\d+), getsongbpm (\d+), getsongbpm failed (\d+), consensus (\d+), review (\d+), cyanite submitted (\d+), cyanite finished (\d+), cyanite failed (\d+), cyanite skipped (\d+)$/i,
      "κύρια ανάλυση $1, αποτυχίες $2, Essentia $3, αποτυχίες validation $4, διαφωνίες $5, ReccoBeats $6, αποτυχίες ReccoBeats $7, GetSongBPM $8, αποτυχίες GetSongBPM $9, consensus $10, για έλεγχο $11, στάλθηκαν Cyanite $12, ολοκληρώθηκαν Cyanite $13, αποτυχίες Cyanite $14, χωρίς credit $15",
    )
    .replace(/^analyzed (\d+), failed (\d+)$/i, "αναλύθηκαν $1, απέτυχαν $2")
    .replace(/^enriched (\d+), failed (\d+)$/i, "εμπλουτίστηκαν $1, απέτυχαν $2");
}
