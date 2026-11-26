/** «Η αφήγηση του set»: the reader's numbers (backend/app/services/set_story.py) and the Greek they read as. */

export type StoryEntry = { kind: "blend" | "step" | "jump"; from_bpm: number; to_bpm: number; three_four: boolean };
export type StoryDrift = { tempo: [number, number] | null; lufs: [number, number] | null; bass: [number, number] | null };
export type StoryLead = { name: string; count: number; of: number };
export type StoryChapter = {
  kind: "plateau" | "wander";
  first_row: number;
  last_row: number;
  track_count: number;
  start_seconds: number;
  seconds: number;
  lo: number;
  hi: number;
  median: number;
  entry: StoryEntry | null;
  lufs: number | null;
  lufs_change: number | null;
  style: StoryLead | null;
  key: StoryLead | null;
  artist: { name: string; count: number } | null;
  unknown: { bpm: number; lufs: number; bass: number; key: number; style: number };
  drift: StoryDrift | null;
};
export type StoryParenthesis = { row: number; chapter: number; bpm: number; before_bpm: number; after_bpm: number };
export type SetStoryReading = {
  track_count: number;
  seconds: number;
  crate: boolean;
  unknown: { bpm: number; duration: number };
  folded: number[];
  chapters: StoryChapter[];
  parentheses: StoryParenthesis[];
};

export type StoryChapterText = { title: string; entry: string | null; body: string; drift: string | null };
export type SetStoryText = { summary: string; chapters: StoryChapterText[]; notes: string[] };

const COUNT = ["Ένα κεφάλαιο", "Δύο κεφάλαια", "Τρία κεφάλαια", "Τέσσερα κεφάλαια", "Πέντε κεφάλαια", "Έξι κεφάλαια"];
const MIN_TRACKS = 3;

/** Minutes on the set's clock: «51′», «1ω 50′». */
export function storyMinutes(seconds: number): string {
  const total = Math.round(Math.max(0, seconds) / 60);
  const hours = Math.floor(total / 60);
  return hours ? `${hours}ω ${total % 60}′` : `${total}′`;
}

const bpm = (value: number) => String(Math.round(value));
const band = (lo: number, hi: number) => `${bpm(lo)}–${bpm(hi)}`;
const signed = (value: number, digits: number) => value.toFixed(digits).replace("-", "−").replace(".", ",");
const tracks = (n: number) => (n === 1 ? "1 track" : `${n} tracks`);

function entryText(entry: StoryEntry): string {
  const move = `${bpm(entry.from_bpm)} → ${bpm(entry.to_bpm)} BPM`;
  if (entry.kind === "blend") return `Ομαλή συνέχεια ${move}.`;
  if (entry.kind === "step") return `Σκαλοπάτι ${move}.`;
  return `Άλμα ${move}${entry.three_four ? " (3:4)" : ""}.`;
}

function driftText(drift: StoryDrift): string | null {
  const parts: string[] = [];
  if (drift.tempo) {
    const [a, z] = drift.tempo;
    parts.push(`${z > a ? "πιο γρήγορα" : "πιο αργά"} (${bpm(z)} από ${bpm(a)} BPM)`);
  }
  if (drift.lufs) {
    const [a, z] = drift.lufs;
    parts.push(`${z > a ? "πιο δυνατά" : "πιο ήσυχα"} (${signed(z, 1)} από ${signed(a, 1)} LUFS)`);
  }
  if (drift.bass) {
    const [a, z] = drift.bass;
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    parts.push(`${z > a ? "περισσότερο μπάσο" : "λιγότερο μπάσο"} (${pct(z)} από ${pct(a)} του χρόνου)`);
  }
  return parts.length ? `Στο τέλος, σε σχέση με την αρχή: ${parts.join("· ")}.` : null;
}

function chapterText(chapter: StoryChapter, index: number): StoryChapterText {
  const rows = chapter.first_row === chapter.last_row
    ? `track ${chapter.first_row + 1}`
    : `tracks ${chapter.first_row + 1}–${chapter.last_row + 1}`;
  const start = index > 0 && chapter.start_seconds > 0 ? ` · από το ~${storyMinutes(chapter.start_seconds)}` : "";
  const where = `${chapter.kind === "plateau" ? "σταθερά" : "περιπλάνηση"} στα ${band(chapter.lo, chapter.hi)} BPM`;
  const lead = chapter.seconds > 0 ? `Περίπου ${storyMinutes(chapter.seconds)} ${where}` : where[0].toUpperCase() + where.slice(1);
  const facts = [lead];
  if (chapter.style) facts.push(`κυρίως ${chapter.style.name}`);
  if (chapter.key) facts.push(`βασικό key ${chapter.key.name} (${chapter.key.count} από ${chapter.key.of})`);
  if (chapter.artist) facts.push(`${chapter.artist.count} tracks του ${chapter.artist.name}`);
  if (chapter.lufs_change !== null && Math.abs(chapter.lufs_change) >= 1) {
    const db = Math.round(Math.abs(chapter.lufs_change));
    facts.push(`${db} dB ${chapter.lufs_change > 0 ? "πιο δυνατά" : "πιο ήσυχα"} από το προηγούμενο`);
  }
  return {
    title: `Κεφάλαιο ${index + 1} · ${rows}${start}`,
    entry: chapter.entry ? entryText(chapter.entry) : null,
    body: `${facts.join(", ")}.`,
    drift: chapter.drift ? driftText(chapter.drift) : null,
  };
}

/** The whole reading as plain Greek: a summary, one block per chapter and the notes under them. */
export function describeSetStory(reading: SetStoryReading): SetStoryText {
  const notes: string[] = [];
  if (reading.track_count === 0) return { summary: "Το set είναι άδειο.", chapters: [], notes };
  if (reading.unknown.bpm > 0) {
    notes.push(reading.unknown.bpm === 1 ? "1 track χωρίς BPM δεν μετρήθηκε." : `${reading.unknown.bpm} tracks χωρίς BPM δεν μετρήθηκαν.`);
  }
  if (!reading.chapters.length) return { summary: "Κανένα track δεν έχει BPM, οπότε δεν βγαίνουν κεφάλαια.", chapters: [], notes };
  if (reading.track_count < MIN_TRACKS) {
    return { summary: `Λίγα tracks ακόμη: τα κεφάλαια φαίνονται από ${MIN_TRACKS} tracks και πάνω.`, chapters: [], notes };
  }
  for (const p of reading.parentheses) {
    const home = reading.chapters[p.chapter];
    notes.push(`Παρένθεση στο track ${p.row + 1}: ${bpm(p.bpm)} BPM ανάμεσα σε δύο tracks της ζώνης ${band(home.lo, home.hi)}.`);
  }
  const folded = reading.folded.length;
  if (folded) {
    notes.push(folded === 1
      ? "1 track με μισό ή διπλό tempo μετρήθηκε στο tempo του set."
      : `${folded} tracks με μισό ή διπλό tempo μετρήθηκαν στο tempo του set.`);
  }
  if (reading.unknown.duration > 0) {
    notes.push(`Σε ${tracks(reading.unknown.duration)} λείπει η διάρκεια, οπότε οι χρόνοι βγαίνουν μικρότεροι.`);
  }
  if (reading.crate) notes.push("Πάνω από 4 ώρες: μοιάζει με crate· η αφήγηση μόνο περιγράφει.");
  const count = COUNT[reading.chapters.length - 1] ?? `${reading.chapters.length} κεφάλαια`;
  const summary = reading.seconds > 0 ? `${count}, περίπου ${storyMinutes(reading.seconds)}.` : `${count}.`;
  return { summary, chapters: reading.chapters.map(chapterText), notes };
}
