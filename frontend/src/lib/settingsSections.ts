/** Settings page navigation: topic groups, sections and the sidebar search. */

export type SettingsGroupId = "app" | "library" | "analysis" | "audio" | "system";

export type SettingsSectionId =
  | "general"
  | "appearance"
  | "folders"
  | "scan"
  | "vocabularies"
  | "analysis"
  | "djay"
  | "llm"
  | "playback"
  | "waveforms"
  | "backup"
  | "status";

export interface SettingsSection {
  id: SettingsSectionId;
  group: SettingsGroupId;
  label: string;
  description: string;
  /** Extra search words: the settings the section holds. */
  keywords: string;
}

export const SETTINGS_GROUPS: readonly { id: SettingsGroupId; label: string }[] = [
  { id: "app", label: "Εφαρμογή" },
  { id: "library", label: "Βιβλιοθήκη" },
  { id: "analysis", label: "Ανάλυση" },
  { id: "audio", label: "Ήχος" },
  { id: "system", label: "Σύστημα" },
];

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: "general",
    group: "app",
    label: "Γενικά",
    description: "Προφίλ χρήσης, προεπιλεγμένη ουρά για τον «Χαρακτηρισμό tracks» και μορφή κλειδιού.",
    keywords: "προφίλ χρήσης dj μουσικοθεραπεία προεπιλεγμένη ουρά χαρακτηρισμός tracks tagging μορφή κλειδιού camelot επιβεβαίωση export",
  },
  {
    id: "appearance",
    group: "app",
    label: "Εμφάνιση",
    description: "Θέμα, φόντο και πυκνότητα της διεπαφής.",
    keywords: "θέμα νυχτερινό κενό ηλιακό φως night solar φόντο πυκνότητα μειωμένη κίνηση σύμπτυξη πλαϊνής μπάρας",
  },
  {
    id: "folders",
    group: "library",
    label: "Φάκελοι μουσικής",
    description: "Οι φάκελοι που σαρώνει το CrateMind. Τα αρχεία μένουν στη θέση τους και δεν αλλάζουν.",
    keywords: "φάκελος βιβλιοθήκη library roots αντιστοίχιση συσκευή εύρος bpm",
  },
  {
    id: "scan",
    group: "library",
    label: "Σάρωση",
    description: "Βρίσκει νέα, αλλαγμένα και μετακινημένα αρχεία στους φακέλους μουσικής.",
    keywords: "σάρωση scan έλεγχος αλλαγών πλήρης υποφάκελος fingerprint fpcalc διπλότυπα",
  },
  {
    id: "vocabularies",
    group: "library",
    label: "Λεξιλόγια",
    description: "Δικές σου κατηγορίες με τιμές (π.χ. «Θεραπευτικός στόχος: χαλάρωση»). Αποθηκεύονται μόνο στο CrateMind· τα αρχεία ήχου δεν αλλάζουν.",
    keywords: "λεξιλόγιο κατηγορίες τιμές πολλαπλή επιλογή",
  },
  {
    id: "analysis",
    group: "analysis",
    label: "BPM & Key",
    description: "Τοπική ανάλυση tempo και τονικότητας. Κάθε ανάλυση φτιάχνει και το beatgrid του CrateMind.",
    keywords: "ανάλυση επανανάλυση bpm key τονικότητα εύρος ffmpeg ffprobe consensus διαφορές",
  },
  {
    id: "djay",
    group: "analysis",
    label: "Beatgrid από djay",
    description: "Το beatgrid του djay Pro χρησιμοποιείται όταν το beatgrid του CrateMind δεν είναι αρκετά σίγουρο.",
    keywords: "beatgrid djay import εισαγωγή αφαίρεση",
  },
  {
    id: "llm",
    group: "analysis",
    label: "Μοντέλο τεχνητής νοημοσύνης",
    description: "Το μοντέλο που κάνει την έρευνα καλλιτεχνών: διεύθυνση, όνομα, επίπεδο σκέψης και κλειδί API.",
    keywords: "llm ai τεχνητή νοημοσύνη μοντέλο endpoint διεύθυνση κλειδί api key effort σκέψη openai έρευνα καλλιτεχνών δοκιμή σύνδεσης",
  },
  {
    id: "playback",
    group: "audio",
    label: "Αναπαραγωγή",
    description: "Επεξεργασία μόνο για ακρόαση. Τα αρχεία και τα tags δεν αλλάζουν.",
    keywords: "auto gain audio limiter maximizer ένταση οροφή lufs αυτόματη αναπαραγωγή plugin vst3 master",
  },
  {
    id: "waveforms",
    group: "audio",
    label: "Κυματομορφές",
    description: "Πώς φαίνονται οι κυματομορφές στη μπάρα αναπαραγωγής και στα decks.",
    keywords: "κυματομορφή μεταφοράς χρώματα συχνότητες θέση decks",
  },
  {
    id: "backup",
    group: "system",
    label: "Backup & μεταφορά",
    description: "Αντίγραφα της βιβλιοθήκης και μεταφορά σε άλλη συσκευή.",
    keywords: "backup αντίγραφο αντίγραφα ασφαλείας κρατιούνται ημέρες μέρες χώρος json metadata μεταφορά άλλη συσκευή ανταλλαγή διαδρομές output",
  },
  {
    id: "status",
    group: "system",
    label: "Κατάσταση συστήματος",
    description: "Τα εργαλεία, η βάση δεδομένων και η τελευταία εργασία.",
    keywords: "κατάσταση υγεία βάση δεδομένων τελευταία εργασία ffprobe fpcalc controller midi μηνύματα χωρίς αντιστοίχιση καταγραφή όλων των μηνυμάτων jog nudge bend σχετικά έκδοση άδεια συντελεστές",
  },
];

/** Case- and accent-insensitive text for search: «Εμφάνιση» and «εμφανιση» match, and ς equals σ. */
export function normalizeSearch(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/ς/g, "σ").trim();
}

/** Sections whose label or keywords contain every word of the query. */
export function matchSettingsSections<T extends SettingsSection>(sections: readonly T[], query: string): T[] {
  const terms = normalizeSearch(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...sections];
  return sections.filter(section => {
    const haystack = normalizeSearch(`${section.label} ${section.keywords}`);
    return terms.every(term => haystack.includes(term));
  });
}
