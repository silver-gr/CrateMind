import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QuestionCard } from "../src/components/names/QuestionCard";
import { AnswersList } from "../src/components/names/AnswersList";
import { ReviewRowBody } from "../src/components/names/ReviewList";
import { NameCorrection } from "../src/components/names/NameCorrection";
import { NamesPager } from "../src/components/names/NamesPager";
import Names from "../src/pages/Names";
import type { NameAnswer, NameQuestion, NameReviewRow } from "../src/lib/types";

const answer = (over: Partial<NameAnswer> = {}): NameAnswer => ({
  id: 7, kind: "preference", scope: "pref:zyx_rule", track_id: null, value: "B", text: "Προτίμηση: όπως γράφονται",
  source: "owner", provisional: false, created_at: "2026-11-28T00:00:00Z", reach: 3, undoable: true, track: null, ...over,
});

const question = (over: Partial<NameQuestion> = {}): NameQuestion => ({
  id: "preference|pref:zyx_rule", kind: "preference", scope: "pref:zyx_rule", section: "pattern", code: "U42",
  question: "Ονόματα με κεφαλαία στη μέση: όπως γράφονται;",
  options: [{ letter: "A", text: "ναι, όπως τώρα" }, { letter: "B", text: "όχι, όπως γράφονται" }],
  allows_text: false, text_hint: null, recommended: "A", why: "ο κανόνας που ισχύει τώρα",
  track_count: 8,
  examples: [
    { track_id: 1, artist: "Qwerty Zed", title: "Alpha", off_artist: "QWERTY ZED", off_title: "Alpha" },
    { track_id: 2, artist: "Lumo Vex", title: "Beta", off_artist: "Lumo Vex", off_title: "Beta" },
  ],
  answer: null, ...over,
});

const row = (over: Partial<NameReviewRow> = {}): NameReviewRow => ({
  track_id: 11, artist: "Qwerty Zed", title: "Alpha", folder: "Qwerty Zed", off_artist: "QWERTY ZED", off_title: "Alpha",
  status: "look", group: "N7", reason: "Το όνομα βγήκε από μία μόνο πηγή.", accepted: false, prev_artist: null,
  prev_title: null, prev_folder: null, changed_at: null, cause_text: "", ...over,
});

const html = (node: ReactNode) => renderToString(<MemoryRouter>{node}</MemoryRouter>).replace(/<!-- -->/g, "");

describe("question card", () => {
  test("shows the reach, examples with today's name when it differs, the recommendation and no internal code", () => {
    const out = html(<QuestionCard question={question()} busy={false} onAnswer={() => {}} onUndo={() => {}} />);
    expect(out).toContain("Αφορά 8 κομμάτια");
    expect(out).toContain("Qwerty Zed — Alpha");
    expect(out).toContain("με κλειστά τα καθαρά ονόματα: QWERTY ZED — Alpha");
    expect(out).not.toContain("με κλειστά τα καθαρά ονόματα: Lumo Vex");
    expect(out).toContain("και 6 κομμάτια ακόμη");
    expect(out).toContain("Προτείνεται");
    expect(out).toContain("Γιατί προτείνεται: ο κανόνας που ισχύει τώρα");
    expect(out).not.toContain("U42");
    expect(out).not.toContain("Άλλο…");
    expect(out).not.toContain("Αναίρεση");
    expect((out.match(/aria-pressed="true"/g) ?? []).length).toBe(0);
  });

  test("an answered question marks its option, offers undo, and «Άλλο…» where a typed value is allowed", () => {
    const out = html(<QuestionCard question={question({ answer: answer(), allows_text: true })} busy={false} onAnswer={() => {}} onUndo={() => {}} />);
    expect(out).toContain("Η απάντησή σου: Προτίμηση: όπως γράφονται");
    expect(out).toContain("Αναίρεση");
    expect(out).toContain("Άλλο…");
    expect((out.match(/aria-pressed="true"/g) ?? []).length).toBe(1);
    expect(out).toMatch(/aria-pressed="true"[^>]*>(?:(?!<\/button>).)*όχι, όπως γράφονται/);
  });

  test("a /canonical answer on a question has no undo", () => {
    const out = html(<QuestionCard question={question({ answer: answer({ undoable: false, source: "canonical" }) })} busy={false} onAnswer={() => {}} onUndo={() => {}} />);
    expect(out).not.toContain("Αναίρεση");
  });
});

describe("answers list", () => {
  test("each answer with its kind, date, source and reach; undo, or the way to /canonical", () => {
    const out = html(
      <AnswersList busyId={null} onUndo={() => {}} answers={[
        answer(),
        answer({ id: 8, kind: "track", track_id: 5, value: "Lumo Vex | Beta", text: "Lumo Vex — Beta", source: "canonical", undoable: false, reach: null,
          track: { track_id: 5, artist: "Lumo Vex", title: "Beta", off_artist: "", off_title: "" } }),
      ]} />,
    );
    expect(out).toContain("Προτίμηση");
    expect(out).toContain("δική σου");
    expect(out).toContain("άλλαξε 3 κομμάτια");
    expect(out).toContain("Διόρθωση κομματιού");
    expect(out).toContain("από τη σελίδα ταυτότητας");
    expect(out).toContain("μετριέται στην επόμενη ενημέρωση");
    expect(out).toContain('href="/canonical"');
    expect((out.match(/>Αναίρεση</g) ?? []).length).toBe(1);
    expect(out).not.toContain("pref:zyx_rule");
    // A one-track answer whose text is already the track line does not repeat it.
    expect(out.split("Lumo Vex — Beta").length - 1).toBe(1);
  });

  test("thousands of answers are paged a hundred at a time", () => {
    const many = Array.from({ length: 250 }, (_, i) => answer({ id: i + 1 }));
    const out = html(<AnswersList busyId={null} onUndo={() => {}} answers={many} />);
    expect((out.match(/data-answer-id=/g) ?? []).length).toBe(100);
    expect(out).toContain("1–100 από 250");
  });

  test("no answers yet", () => {
    expect(html(<AnswersList busyId={null} onUndo={() => {}} answers={[]} />)).toContain("Δεν έχεις δώσει ακόμη απάντηση");
  });
});

describe("review rows", () => {
  test("a look row: shown name, switch-off name, folder, reason; «Εντάξει» badge once accepted", () => {
    const out = html(<ReviewRowBody row={row()} section="look" />);
    expect(out).toContain("Qwerty Zed — Alpha");
    expect(out).toContain("Με κλειστά τα καθαρά ονόματα: QWERTY ZED — Alpha");
    expect(out).toContain("Προτεινόμενος φάκελος: Qwerty Zed");
    expect(out).toContain("Το όνομα βγήκε από μία μόνο πηγή.");
    expect(out).not.toContain(">Εντάξει<");
    expect(html(<ReviewRowBody row={row({ accepted: true })} section="look" />)).toContain(">Εντάξει<");
  });

  test("a none row reads «Άγνωστος καλλιτέχνης»", () => {
    expect(html(<ReviewRowBody row={row({ artist: "", status: "none" })} section="none" />)).toContain("Άγνωστος καλλιτέχνης — Alpha");
  });

  test("a changed row shows before and now, a moved folder and the cause", () => {
    const out = html(<ReviewRowBody section="changed" row={row({
      prev_artist: "Qwerty", prev_title: "Alpha", prev_folder: "Qwerty", changed_at: "2026-11-28T00:00:00Z",
      cause_text: "Νέοι κανόνες ονομάτων",
    })} />);
    expect(out).toContain("Qwerty Zed — Alpha");
    expect(out).toContain("Πριν: Qwerty — Alpha");
    expect(out).toContain("Προτεινόμενος φάκελος: Qwerty → Qwerty Zed");
    expect(out).toContain("Νέοι κανόνες ονομάτων");
    expect(out).not.toContain("N7");
  });
});

describe("pieces", () => {
  test("the correction form has labelled fields and saves only with both filled", () => {
    const out = html(<NameCorrection artist="" title="Alpha" busy={false} onSave={() => {}} onCancel={() => {}} />);
    expect(out).toContain("Καλλιτέχνης");
    expect(out).toContain("Τίτλος");
    expect(out).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
  });

  test("the pager shows only for more than a page", () => {
    expect(html(<NamesPager offset={0} limit={100} shown={40} total={40} onOffset={() => {}} label="x" />)).toBe("");
    const out = html(<NamesPager offset={100} limit={100} shown={100} total={1234} onOffset={() => {}} label="Σελίδες" />);
    expect(out).toContain("101–200 από 1.234");
    expect(out).toContain('aria-label="Προηγούμενη σελίδα"');
    expect(out).toContain('aria-label="Επόμενη σελίδα"');
  });

  test("the page renders its header and waits for its data before choosing a tab", () => {
    const out = html(<Names />);
    expect(out).toContain("Καθαρισμός ονομάτων");
    expect(out).toContain("Φόρτωση…");
    expect(out).toContain("τα αρχεία μουσικής δεν αλλάζουν");
  });

  test("the page writes only through the names api (no file, tag or track writes)", () => {
    const files = ["../src/pages/Names.tsx", "../src/components/names/ReviewList.tsx", "../src/components/names/AnswersList.tsx",
      "../src/components/names/QuestionCard.tsx", "../src/components/names/NameCorrection.tsx"];
    const used = new Set<string>();
    for (const file of files) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      for (const m of source.matchAll(/api\.(\w+)\(/g)) used.add(m[1]);
    }
    expect([...used].sort()).toEqual([
      "acceptNames", "acknowledgeNames", "answerNameQuestion", "correctTrackName", "nameAnswers", "nameQuestions",
      "nameReview", "namesStatus", "undoNameAnswer",
    ]);
  });
});
