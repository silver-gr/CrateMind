import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  acceptBody, acknowledgeBody, answerInput, answeredLetter, bulkConfirm, clampOffset, correctionInput, defaultTab,
  doneText, focusIndexAfter, groupsTotal, isNamesTab, nameKindLabel, nameSourceLabel, NAMES_TABS, namesErrorText,
  noticeLines, offLine, questionsInOrder, rangeText, reachText, runBusy, tabCounts, trackLine, tracksText,
} from "../src/lib/names";
import type { NameAnswer, NameQuestion, NamesStatus } from "../src/lib/types";

const status = (over: Partial<NamesStatus> = {}): NamesStatus => ({
  on: true, can_turn_on: true, blocked_reason: null, ruleset: "names-8", present: 10, named: 10, unread: 0,
  unreadable: 0, counts: { sure: 4, look: 3, open: 1, none: 2, hand: 0 }, accepted: 1, changed: 2, new: 5,
  run: { state: "idle", cause: null, job_id: null }, last_run: null, refusal: null, refusal_text: null, ...over,
});

const answer = (over: Partial<NameAnswer> = {}): NameAnswer => ({
  id: 1, kind: "spelling", scope: "act:zyx", track_id: null, value: "Zyx", text: "Γραφή: Zyx", source: "owner",
  provisional: false, created_at: "2026-11-28T00:00:00Z", reach: null, undoable: true, track: null, ...over,
});

const question = (over: Partial<NameQuestion> = {}): NameQuestion => ({
  id: "spelling|act:zyx", kind: "spelling", scope: "act:zyx", section: "open", code: "N4", question: "Ποια γραφή;",
  options: [{ letter: "A", text: "Zyx" }, { letter: "B", text: "ZYX" }], allows_text: true, text_hint: null,
  recommended: null, why: null, track_count: 2, examples: [], answer: null, ...over,
});

describe("tabs", () => {
  test("six tabs in the plan's order, with Greek labels", () => {
    expect(NAMES_TABS.map(t => t.label)).toEqual([
      "Για απόφαση", "Ερωτήσεις προτιμήσεων", "Για ματιά", "Χωρίς καλλιτέχνη", "Άλλαξαν", "Οι απαντήσεις σου",
    ]);
    expect(isNamesTab("look")).toBe(true);
    expect(isNamesTab("nope")).toBe(false);
    expect(isNamesTab(null)).toBe(false);
  });

  test("counts: unanswered questions, unaccepted look tracks, none, unacknowledged changes, every answer", () => {
    const qs = { open: [question(), question({ id: "x", answer: answer() })], patterns: [question({ section: "pattern" })], has_run: true,
      run: { state: "idle" as const, cause: null, job_id: null } };
    expect(tabCounts(status(), qs, [answer(), answer({ id: 2 })])).toEqual({
      questions: 1, patterns: 1, look: 2, none: 2, changed: 5, answers: 2,
    });
    expect(tabCounts(null, null, null)).toEqual({ questions: null, patterns: null, look: null, none: null, changed: null, answers: null });
    expect(tabCounts(status({ accepted: 9 }), null, null).look).toBe(0);
  });

  test("the default tab is the first with something to do, else the answers", () => {
    const none = { questions: 0, patterns: 0, look: 0, none: 0, changed: 0, answers: 3 };
    expect(defaultTab(none)).toBe("answers");
    expect(defaultTab({ ...none, look: 4, changed: 1 })).toBe("look");
    expect(defaultTab({ ...none, questions: 1, look: 4 })).toBe("questions");
    expect(defaultTab({ questions: null, patterns: null, look: null, none: null, changed: null, answers: null })).toBe("answers");
  });
});

describe("words", () => {
  test("track counts and reach", () => {
    expect(tracksText(1)).toBe("1 κομμάτι");
    expect(tracksText(1234)).toBe("1.234 κομμάτια");
    expect(reachText(null)).toBe("μετριέται στην επόμενη ενημέρωση");
    expect(reachText(0)).toBe("δεν άλλαξε κανένα κομμάτι");
    expect(reachText(1)).toBe("άλλαξε 1 κομμάτι");
    expect(reachText(61)).toBe("άλλαξε 61 κομμάτια");
  });

  test("a track line names an empty artist in Greek, and the switch-off name shows only when it differs", () => {
    expect(trackLine("Zyx", "Song")).toBe("Zyx — Song");
    expect(trackLine("", "Song")).toBe("Άγνωστος καλλιτέχνης — Song");
    expect(trackLine("Zyx", "")).toBe("Zyx");
    const row = { artist: "Zyx", title: "Song", off_artist: "ZYX", off_title: "Song" };
    expect(offLine(row)).toBe("ZYX — Song");
    expect(offLine({ ...row, off_artist: "Zyx" })).toBeNull();
    expect(offLine({ ...row, off_artist: "", off_title: "" })).toBeNull();
  });

  test("kinds and sources are Greek, and an unknown key is never shown", () => {
    for (const kind of ["spelling", "same_act", "one_act", "not_act", "bracket_word", "album_credit", "facts", "preference", "track", "accept"]) {
      expect(nameKindLabel(kind)).toMatch(/[Ͱ-Ͽ]/);
    }
    expect(nameKindLabel("brand_new_kind")).toBe("Απάντηση");
    expect(nameSourceLabel("owner")).toBe("δική σου");
    expect(nameSourceLabel("canonical")).toBe("από τη σελίδα ταυτότητας");
    expect(nameSourceLabel("seed")).toMatch(/[Ͱ-Ͽ]/);
    expect(nameSourceLabel("other")).toBe("δική σου");
  });

  test("an api error loses its status prefix", () => {
    expect(namesErrorText(new Error("409: Η απάντηση αναιρείται στη σελίδα ταυτότητας"))).toBe("Η απάντηση αναιρείται στη σελίδα ταυτότητας");
    expect(namesErrorText(new Error(""))).toBe("Το αίτημα απέτυχε");
  });
});

describe("answers", () => {
  test("a letter or a trimmed typed value; an empty typed value sends nothing", () => {
    const q = question();
    expect(answerInput(q, { letter: "B" })).toEqual({ kind: "spelling", scope: "act:zyx", letter: "B" });
    expect(answerInput(q, { text: "  Zy X " })).toEqual({ kind: "spelling", scope: "act:zyx", text: "Zy X" });
    expect(answerInput(q, { text: "   " })).toBeNull();
  });

  test("the chosen option is marked when the answer's value is its letter or its text, else none", () => {
    expect(answeredLetter(question({ answer: answer({ value: "B" }) }))).toBe("B");
    expect(answeredLetter(question({ answer: answer({ value: "ZYX" }) }))).toBe("B");
    expect(answeredLetter(question({ answer: answer({ value: "typed" }) }))).toBeNull();
    expect(answeredLetter(question())).toBeNull();
  });

  test("unanswered questions come first, each group in the run's order", () => {
    const a = question({ id: "a" }), b = question({ id: "b", answer: answer() }), c = question({ id: "c" });
    expect(questionsInOrder([b, a, c]).map(q => q.id)).toEqual(["a", "c", "b"]);
  });

  test("a correction needs both an artist and a title", () => {
    expect(correctionInput(" Zyx ", " Song ")).toEqual({ artist: "Zyx", title: "Song" });
    expect(correctionInput("", "Song")).toBeNull();
    expect(correctionInput("Zyx", " ")).toBeNull();
  });
});

describe("paging and focus", () => {
  test("range text, and an offset past the end steps back to the last page", () => {
    expect(rangeText(0, 100, 1234)).toBe("1–100 από 1.234");
    expect(rangeText(1200, 34, 1234)).toBe("1.201–1.234 από 1.234");
    expect(rangeText(0, 0, 0)).toBe("");
    expect(clampOffset(300, 250, 100)).toBe(200);
    expect(clampOffset(200, 200, 100)).toBe(100);
    expect(clampOffset(100, 250, 100)).toBe(100);
    expect(clampOffset(100, 0, 100)).toBe(0);
    expect(clampOffset(-5, 10, 100)).toBe(0);
  });

  test("the focus goes to the row now in the place of the one that left, else the last, else the heading", () => {
    expect(focusIndexAfter(2, 5)).toBe(2);
    expect(focusIndexAfter(4, 4)).toBe(3);
    expect(focusIndexAfter(0, 0)).toBe(-1);
  });

  test("«Όλα» counts every group, or the section total when it has none", () => {
    expect(groupsTotal([{ count: 3 }, { count: 4 }], 99)).toBe(7);
    expect(groupsTotal([], 12)).toBe(12);
  });

  test("a queued or running run is busy; idle or unknown is not", () => {
    expect(runBusy({ state: "queued", cause: "manual", job_id: null })).toBe(true);
    expect(runBusy({ state: "running", cause: "manual", job_id: 3 })).toBe(true);
    expect(runBusy({ state: "idle", cause: null, job_id: null })).toBe(false);
    expect(runBusy(null)).toBe(false);
  });
});

describe("bulk actions for the filter shown", () => {
  test("«Εντάξει» sends the deciding rule of the group shown, or nothing for the whole list", () => {
    expect(acceptBody("N7", true)).toEqual({ rule: "N7", dry_run: true });
    expect(acceptBody(null, false)).toEqual({ dry_run: false });
    expect(acknowledgeBody("ok", "scan", true)).toEqual({ cause: "scan", action: "ok", dry_run: true });
    expect(acknowledgeBody("keep_previous", null, false)).toEqual({ action: "keep_previous", dry_run: false });
  });

  test("the confirmation names the count from the dry run and the group", () => {
    const one = bulkConfirm("accept", 1, null);
    expect(one.text.startsWith("1 κομμάτι θα σημειωθεί ως εντάξει")).toBe(true);
    expect(one.button).toBe("Εντάξει στο 1");
    const many = bulkConfirm("accept", 237, "Μία πηγή");
    expect(many.text).toContain("237 κομμάτια της ομάδας «Μία πηγή»");
    expect(many.text).toContain("Τα αρχεία δεν αλλάζουν");
    expect(many.button).toBe("Εντάξει και στα 237");
    expect(bulkConfirm("ok", 12, null).text).toContain("φεύγουν από τα «Άλλαξαν»");
    expect(bulkConfirm("ok", 1, null).text).toContain("1 κομμάτι κρατά το νέο του όνομα");
    expect(bulkConfirm("keep_previous", 1, null).text).toContain("1 κομμάτι θα πάρει");
    const keep = bulkConfirm("keep_previous", 3, "Σάρωση");
    expect(keep.text).toContain("ως δική σου διόρθωση");
    expect(keep.button).toBe("Κράτα τα προηγούμενα και στα 3");
    expect(doneText("accept", 1)).toBe("Σημειώθηκε ως εντάξει");
    expect(doneText("ok", 5)).toBe("Σημειώθηκαν ως εντάξει 5 κομμάτια");
    expect(doneText("keep_previous", 2)).toBe("Κράτησες τα προηγούμενα ονόματα σε 2 κομμάτια");
  });

  test("a bulk write happens only after its dry run, from the confirmation", () => {
    const source = readFileSync(new URL("../src/components/names/ReviewList.tsx", import.meta.url), "utf8");
    const start = source.slice(source.indexOf("async function startBulk"), source.indexOf("async function confirmBulk"));
    const confirm = source.slice(source.indexOf("async function confirmBulk"), source.indexOf("function pickGroup"));
    expect(start).toContain("acceptBody(group, true)");
    expect(start).toContain("acknowledgeBody(action, group, true)");
    expect(start).not.toContain(", false)");
    expect(confirm).toContain("acceptBody(group, false)");
    expect(confirm).toContain("acknowledgeBody(bulk.action, group, false)");
    // Outside these two functions no bulk request is built.
    expect(source.split("acceptBody(").length - 1).toBe(2);
    expect(source.split("acknowledgeBody(").length - 1).toBe(2);
  });
});

describe("notices", () => {
  test("switch off, a refused run and unread tracks each get a line", () => {
    expect(noticeLines(null)).toEqual([]);
    expect(noticeLines(status())).toEqual([]);
    const off = noticeLines(status({ on: false, blocked_reason: "3 κομμάτια δεν έχουν διαβαστεί ακόμη: κάνε σάρωση" }));
    expect(off.map(l => l.tone)).toEqual(["info", "warn"]);
    expect(off[0].text).toContain("κλειστά");
    expect(off[1].text).toContain("κάνε σάρωση");
    const refused = noticeLines(status({ refusal: "key_version", refusal_text: "Οι απαντήσεις σου γράφτηκαν με παλαιότερη έκδοση" }));
    expect(refused).toEqual([{ tone: "warn", text: "Οι απαντήσεις σου γράφτηκαν με παλαιότερη έκδοση" }]);
  });
});
