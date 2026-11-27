/** «Νέα έρευνα για όλους»: the confirmation dialog's text and its rough duration. The count and the model come from
 *  `GET /artists/stats` (`research_again_artists`, `research_model`), never from a guess in the page. */

/** About how long one call takes (measured on the owner's gateway, 2026-11-28). */
export const SECONDS_PER_ARTIST = 40;
/** Calls out at once: `RESEARCH_AGAIN_WIDTH` in backend/app/services/artist_intelligence.py (tests/researchAgain.test.ts compares them). */
export const RESEARCH_AT_ONCE = 3;

/** «περίπου 25 λεπτά», «περίπου 1 ώρα και 42 λεπτά», «περίπου 2 ώρες». */
export function durationText(artists: number): string {
  const minutes = Math.max(1, Math.ceil(artists * SECONDS_PER_ARTIST / RESEARCH_AT_ONCE / 60));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const minutesText = (n: number) => `${n} ${n === 1 ? "λεπτό" : "λεπτά"}`;
  if (hours === 0) return `περίπου ${minutesText(rest)}`;
  const hoursText = `${hours} ${hours === 1 ? "ώρα" : "ώρες"}`;
  return `περίπου ${rest ? `${hoursText} και ${minutesText(rest)}` : hoursText}`;
}

export interface ResearchAgainDialog {
  lines: string[];
  canStart: boolean;
}

export function researchAgainDialog(count: number, model: string | null | undefined): ResearchAgainDialog {
  const name = model?.trim();
  if (!name) return { canStart: false, lines: ["Δεν έχει ρυθμιστεί μοντέλο AI. Όρισέ το στις Ρυθμίσεις («Μοντέλο AI»)."] };
  if (count <= 0) {
    return { canStart: false, lines: [`Όλοι οι καλλιτέχνες έχουν ήδη εύρημα από το «${name}». Δεν μένει κανείς για νέα έρευνα.`] };
  }
  const who = count === 1 ? "1 καλλιτέχνης θα ερευνηθεί" : `${count.toLocaleString("el-GR")} καλλιτέχνες θα ερευνηθούν`;
  return {
    canStart: true,
    lines: [
      `${who} ξανά με το μοντέλο «${name}».`,
      `Διάρκεια: ${durationText(count)} (περίπου ${SECONDS_PER_ARTIST} δευτερόλεπτα ο καθένας, ${RESEARCH_AT_ONCE} μαζί).`,
      "Τα είδη που έχεις επιβεβαιώσει δεν αλλάζουν.",
      "Κάθε τωρινό εύρημα μένει όπως είναι μέχρι να έρθει το νέο του και να περάσει τον έλεγχο· αν η νέα έρευνα αποτύχει, μένει το παλιό.",
      "Μπορείς να τη διακόψεις όποτε θέλεις και να τη συνεχίσεις αργότερα με το ίδιο κουμπί: όσοι έχουν ήδη ερευνηθεί με αυτό το μοντέλο παραλείπονται.",
    ],
  };
}
