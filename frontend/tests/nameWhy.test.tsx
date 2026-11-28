import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToString } from "react-dom/server";
import { NameWhyView } from "../src/components/NameWhy";
import { NamesQuickFilterChips } from "../src/components/NamesQuickFilters";
import {
  correctionProblem,
  correctionStart,
  fieldLabel,
  groupSteps,
  namesQuickFilters,
  noRowText,
  rawLines,
  ruleLabel,
  shownArtist,
  statusLine,
  undoLabel,
  whyActions,
} from "../src/lib/nameWhy";
import type { NameWhy } from "../src/lib/types";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

// Invented names only.
function why(over: Partial<NameWhy> = {}): NameWhy {
  return {
    track_id: 7,
    on: true,
    has_row: true,
    status: "look",
    status_text: "Για ματιά",
    artist: "Velor Mint",
    title: "Glass River",
    folder: "Velor Mint",
    off_artist: "velor mint",
    off_title: "Glass River (Original Mix) 145",
    open_question: null,
    steps: [
      { rule: "T3", field: "title", text: "Το «(Original Mix)» βγήκε από τον τίτλο." },
      { rule: "N7", field: "artist", text: "Η γραφή του καλλιτέχνη είναι η πιο συχνή στη βιβλιοθήκη." },
      { rule: "F1", field: "folder", text: "Ο φάκελος παίρνει το όνομα του καλλιτέχνη." },
      { rule: "X9", field: "mystery", text: "Ένα βήμα χωρίς όνομα πεδίου." },
    ],
    facts: [{ label: "Τέμπο", value: "145" }],
    raw: { artist: "velor mint", title: "Glass River (Original Mix) 145", album: "", track_no: "3", state: "ok" },
    accepted: false,
    decision: null,
    change: null,
    note: null,
    ruleset: "names-8",
    ...over,
  };
}

const ownCorrection = { id: 41, kind: "track", source: "owner", source_text: "Δική σου διόρθωση", undoable: true, created_at: "2026-11-28T00:00:00Z" };
const canonicalEdit = { id: 42, kind: "track", source: "canonical", source_text: "από τη σελίδα ταυτότητας", undoable: false, created_at: "2026-11-28T00:00:00Z" };
const acceptRow = { id: 43, kind: "accept", source: "owner", source_text: "Δική σου διόρθωση", undoable: true, created_at: "2026-11-28T00:00:00Z" };

const textOf = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

describe("steps per field", () => {
  test("grouped artist, title, folder, then the unnamed, each in trail order", () => {
    const groups = groupSteps(why().steps);
    expect(groups.map(g => g.label)).toEqual(["Καλλιτέχνης", "Τίτλος", "Προτεινόμενος φάκελος", null]);
    expect(groups[3].steps.map(s => s.rule)).toEqual(["X9"]);
    const twoTitles = groupSteps([
      { rule: "T1", field: "title", text: "α" },
      { rule: "T2", field: "title", text: "β" },
    ]);
    expect(twoTitles).toEqual([{ label: "Τίτλος", steps: [{ rule: "T1", field: "title", text: "α" }, { rule: "T2", field: "title", text: "β" }] }]);
  });
  test("every field the engine writes has a Greek word, an unknown one has none", () => {
    for (const field of ["artist", "title", "pair", "folder", "album", "facts"]) expect(fieldLabel(field)).toMatch(/^[\p{Script=Greek} ]+$/u);
    expect(fieldLabel("")).toBeNull();
    expect(fieldLabel("mystery")).toBeNull();
  });
  test("the rule id is named beside its sentence", () => {
    expect(ruleLabel("N7")).toBe("κανόνας N7");
  });
});

describe("status and names", () => {
  test("the status line: source of a track decision, else the status; nothing for sure", () => {
    expect(statusLine(why())).toBe("Για ματιά");
    expect(statusLine(why({ status: "sure", status_text: "" }))).toBe("");
    expect(statusLine(why({ status: "hand", status_text: "Δική σου διόρθωση", decision: canonicalEdit }))).toBe("από τη σελίδα ταυτότητας");
    expect(statusLine(why({ status: "look", decision: acceptRow }))).toBe("Για ματιά");
    expect(statusLine(why({ status: "open", status_text: "" }))).toBe("Για απόφαση");
  });
  test("status none shows «Άγνωστος καλλιτέχνης»", () => {
    expect(shownArtist(why({ status: "none", artist: "" }))).toBe("Άγνωστος καλλιτέχνης");
    expect(shownArtist(why())).toBe("Velor Mint");
  });
  test("a track without a row says why", () => {
    expect(noRowText(why({ has_row: false, raw: { artist: null, title: null, album: null, track_no: null, state: null } }))).toContain("κάνε σάρωση");
    expect(noRowText(why({ has_row: false }))).toContain("ενημέρωση ονομάτων");
  });
  test("raw tags: artist and title always, album and track number when present", () => {
    expect(rawLines(why().raw)).toEqual([
      { label: "Tag καλλιτέχνη", value: "velor mint" },
      { label: "Tag τίτλου", value: "Glass River (Original Mix) 145" },
      { label: "Tag αριθμού κομματιού", value: "3" },
    ]);
    expect(rawLines({ artist: null, title: "  ", album: null, track_no: null, state: "ok" }).map(l => l.value)).toEqual(["—", "—"]);
  });
});

describe("actions", () => {
  test("nothing with the switch off", () => {
    expect(whyActions(why({ on: false, decision: ownCorrection }))).toEqual({ correct: false, undo: false, accept: false });
  });
  test("«Εντάξει» only for a look track not yet accepted", () => {
    expect(whyActions(why()).accept).toBe(true);
    expect(whyActions(why({ accepted: true })).accept).toBe(false);
    expect(whyActions(why({ status: "open", status_text: "Για απόφαση" })).accept).toBe(false);
    expect(whyActions(why({ has_row: false })).accept).toBe(false);
  });
  test("«Διόρθωση» needs the file's tags read", () => {
    expect(whyActions(why()).correct).toBe(true);
    expect(whyActions(why({ has_row: false, raw: { artist: null, title: null, album: null, track_no: null, state: null } })).correct).toBe(false);
    expect(whyActions(why({ raw: { ...why().raw, state: "unreadable" } })).correct).toBe(true);
  });
  test("«Αναίρεση» for the owner's own decision, never for a /canonical one", () => {
    expect(whyActions(why({ decision: ownCorrection })).undo).toBe(true);
    expect(whyActions(why({ decision: canonicalEdit })).undo).toBe(false);
    expect(whyActions(why()).undo).toBe(false);
    expect(undoLabel(why({ decision: ownCorrection }))).toBe("Αναίρεση διόρθωσης");
    expect(undoLabel(why({ decision: acceptRow }))).toBe("Αναίρεση του «Εντάξει»");
  });
  test("the correction starts from the shown name, empty artist for none, the off name without a row", () => {
    expect(correctionStart(why())).toEqual({ artist: "Velor Mint", title: "Glass River" });
    expect(correctionStart(why({ status: "none", artist: "" }))).toEqual({ artist: "", title: "Glass River" });
    expect(correctionStart(why({ has_row: false }))).toEqual({ artist: "velor mint", title: "Glass River (Original Mix) 145" });
  });
  test("a correction needs both parts, and a hand correction needs a change", () => {
    expect(correctionProblem(why(), " ", "Glass River")).toBe("Συμπλήρωσε καλλιτέχνη και τίτλο.");
    expect(correctionProblem(why(), "Velor Mint", "")).toBe("Συμπλήρωσε καλλιτέχνη και τίτλο.");
    expect(correctionProblem(why(), "Velor Mint", "Glass River")).toBeNull(); // pins the engine's name by hand
    expect(correctionProblem(why({ status: "hand", decision: ownCorrection }), "Velor Mint ", "Glass River")).toBe("Δεν άλλαξε τίποτα.");
    expect(correctionProblem(why({ status: "hand", decision: ownCorrection }), "Velor Mint", "Glass Rivers")).toBeNull();
  });
});

describe("the block", () => {
  test("renders nothing with the switch off", () => {
    expect(renderToString(<NameWhyView why={why({ on: false })} />)).toBe("");
  });
  test("shows status, sentences with rule ids, facts, folder, raw tags and the switch-off name, in Greek", () => {
    const text = textOf(renderToString(<NameWhyView why={why()} />));
    for (const part of [
      "Γιατί αυτό το όνομα", "Για ματιά", "Velor Mint – Glass River",
      "Το «(Original Mix)» βγήκε από τον τίτλο.", "κανόνας T3", "κανόνας N7", "κανόνας F1", "κανόνας X9",
      "Τέμπο", "145", "Προτεινόμενος φάκελος", "Tag καλλιτέχνη", "Tag τίτλου",
      "Με κλειστά τα καθαρά ονόματα: velor mint – Glass River (Original Mix) 145",
      "Εντάξει", "Διόρθωση",
    ]) expect(text).toContain(part);
    // No internal key reaches the screen: field names, status codes, the ruleset id.
    for (const key of ["artist", "title", "folder", "mystery", "look", "names-8"]) expect(text).not.toContain(key);
    expect(text).not.toContain("Αναίρεση");
  });
  test("a sure name shows no status chip, an accepted look track shows «Εντάξει» without the button", () => {
    const sure = textOf(renderToString(<NameWhyView why={why({ status: "sure", status_text: "" })} />));
    expect(sure).not.toContain("Για ματιά");
    const accepted = renderToString(<NameWhyView why={why({ accepted: true, decision: acceptRow })} />);
    expect(accepted).not.toContain(">Εντάξει</button>");
    expect(textOf(accepted)).toContain("Αναίρεση του «Εντάξει»");
  });
  test("an open question, the previous name and the note are shown", () => {
    const text = textOf(renderToString(<NameWhyView why={why({
      status: "open", status_text: "Για απόφαση", open_question: "Είναι το «Orvane Duo» το ίδιο με το «Orvane Duo Live»;",
      change: { prev_artist: "Velor Mynt", prev_title: "Glass River", prev_folder: null, changed_at: "2026-11-28T00:00:00Z", cause_text: "νέα έκδοση κανόνων" },
      note: "χωρίς τα στοιχεία της πηγής, κατ' επιλογή σου",
    })} />));
    expect(text).toContain("Ερώτηση Είναι το «Orvane Duo» το ίδιο με το «Orvane Duo Live»;");
    expect(text).toContain("Πριν την τελευταία αλλαγή: Velor Mynt – Glass River (νέα έκδοση κανόνων)");
    expect(text).toContain("χωρίς τα στοιχεία της πηγής, κατ' επιλογή σου");
  });
  test("a /canonical correction names its source and offers no undo", () => {
    const text = textOf(renderToString(<NameWhyView why={why({ status: "hand", status_text: "Δική σου διόρθωση", decision: canonicalEdit })} />));
    expect(text).toContain("από τη σελίδα ταυτότητας");
    expect(text).not.toContain("Αναίρεση");
  });
  test("an unread track: why there is no name, no raw tags, no actions", () => {
    const text = textOf(renderToString(<NameWhyView why={why({
      has_row: false, status: null, status_text: "", artist: "", title: "", steps: [], facts: [], folder: "",
      raw: { artist: null, title: null, album: null, track_no: null, state: null },
    })} />));
    expect(text).toContain("κάνε σάρωση");
    expect(text).not.toContain("Tag καλλιτέχνη");
    expect(text).not.toContain("Διόρθωση");
    expect(text).not.toContain("Με κλειστά");
  });
  test("an unreadable file says its names came from the stored values", () => {
    expect(textOf(renderToString(<NameWhyView why={why({ raw: { ...why().raw, state: "unreadable" } })} />))).toContain("δεν διαβάστηκαν");
  });
  test("the correction form: two fields, save disabled until it can be saved", () => {
    const empty = renderToString(<NameWhyView why={why()} draft={{ artist: "", title: "Glass River" }} />);
    expect(empty).toContain('aria-label="Καλλιτέχνης"');
    expect(empty).toContain('aria-label="Τίτλος"');
    expect(textOf(empty)).toContain("Συμπλήρωσε καλλιτέχνη και τίτλο.");
    expect(empty).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
    expect(textOf(empty)).not.toContain("Διόρθωση"); // the action row hides while the form is open
    const ready = renderToString(<NameWhyView why={why()} draft={{ artist: "Velor Mint", title: "Glass Rivers" }} />);
    expect(ready).not.toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  });
});

describe("Library quick filters", () => {
  test("only while the switch is on, with the feature's tokens", () => {
    expect(namesQuickFilters(null)).toEqual([]);
    expect(namesQuickFilters({ on: false })).toEqual([]);
    expect(namesQuickFilters({ on: true }).map(f => f.q)).toEqual(["names:look", "names:open", "names:changed", "names:new"]);
    for (const f of namesQuickFilters({ on: true })) expect(f.label).not.toMatch(/[a-z]/);
  });
  test("the chips are drawn like the ready filters and mark the active one", () => {
    const html = renderToString(<NamesQuickFilterChips filters={namesQuickFilters({ on: true })} query=" names:open " onApply={() => {}} />);
    expect(textOf(html)).toContain("Ονόματα για ματιά");
    expect(html.match(/ring-1/g)?.length).toBe(1);
  });
  test("mounted beside the Library's ready filters, and the why block reloads the inspector", () => {
    expect(read("../src/pages/Library.tsx")).toContain("<NamesQuickFilters query={query} onApply={runQuery} />");
    expect(read("../src/components/ProfileEditor.tsx")).toContain("<NameWhy trackId={detail.track.id} onChanged={() => void onSaved()} />");
  });
});

describe("review fixes", () => {
  test("a `names:` search chip reads in Greek, never the raw value", async () => {
    const { parseQueryChips } = await import("../src/lib/queryChips");
    const labels = parseQueryChips("names:look names:open names:none names:hand names:sure names:changed names:new names:what").map(c => c.label);
    expect(labels).toEqual([
      "Ονόματα για ματιά", "Ονόματα για απόφαση", "Χωρίς καλλιτέχνη", "Δική σου διόρθωση", "Σίγουρα ονόματα",
      "Καθαρισμένα ονόματα", "Νέες αλλαγές ονομάτων", "Ονόματα",
    ]);
  });
  test("a sentence with no rule id gets no «κανόνας» beside it", () => {
    expect(ruleLabel("")).toBe("");
    expect(ruleLabel("N7")).toBe("κανόνας N7");
  });
  test("the proposed folder is named once, under its own heading", () => {
    const text = textOf(renderToString(<NameWhyView why={why()} />));
    expect(text.split("Προτεινόμενος φάκελος").length - 1).toBe(1);
    expect(text).toContain("Προτεινόμενος φάκελος Velor Mint Ο φάκελος παίρνει το όνομα του καλλιτέχνη.");
    const noStep = textOf(renderToString(<NameWhyView why={why({ steps: [] })} />));
    expect(noStep).toContain("Προτεινόμενος φάκελος Velor Mint");
  });
  test("the correction form takes the focus and closes on Escape", () => {
    const html = renderToString(<NameWhyView why={why()} draft={{ artist: "Velor Mint", title: "Glass River" }} />);
    expect(html).toMatch(/<input[^>]*autofocus|<input[^>]*autoFocus/i);
    expect(read("../src/components/NameWhy.tsx")).toContain('if (e.key !== "Escape") return;');
  });
});
