import { describe, expect, test } from "bun:test";
import {
  REVIEW_STATUS,
  batchSummary,
  deltaText,
  isAutomaticMethod,
  isTitleOnlyRule,
  ruleHint,
  ruleLabel,
  ruleOptions,
  shownStatus,
  sideLines,
} from "../src/lib/automaticLinks";
import type { AutomaticLinkRow } from "../src/lib/types";

const row: AutomaticLinkRow = {
  left_id: "local:7",
  left_service: "local",
  left_title: "Moon Garden",
  left_artist: null,
  left_duration_ms: 300000,
  left_permalink: null,
  left_file_name: "07 Moon Garden.mp3",
  right_id: "spotify:track:a",
  right_service: "spotify",
  right_title: "Moon Garden",
  right_artist: "Alpha Beta",
  right_duration_ms: 300400,
  right_permalink: "https://open.spotify.com/track/a",
  right_file_name: null,
  rule: "title_unknown_artist",
  accepted_at: "2026-11-26T20:36:10+00:00",
  batch: "auto-1",
  delta_seconds: 0.4,
};

describe("automatic links", () => {
  test("an unlinked local track shows no class badge, or «Για έλεγχο» when it is in the review set", () => {
    const review = new Set(["local:2"]);
    expect(shownStatus({ id: "local:1", service: "local", status: "AMBIGUOUS" }, review)).toBe("");
    expect(shownStatus({ id: "local:1", service: "local", status: "HIGH_CONFIDENCE" }, review)).toBe("");
    expect(shownStatus({ id: "local:2", service: "local", status: "CONFLICT" }, review)).toBe(REVIEW_STATUS);
    expect(shownStatus({ id: "local:2", service: "local", status: "ACCEPTED" }, review)).toBe("ACCEPTED");
    expect(shownStatus({ id: "spotify:track:a", service: "spotify", status: "AMBIGUOUS" }, review)).toBe("AMBIGUOUS");
  });

  test("rules are named in Greek and an unknown key never reaches the screen", () => {
    expect(ruleLabel("text_exact")).toBe("Ίδιος καλλιτέχνης και τίτλος");
    expect(ruleLabel("isrc_duration")).toBe("Ίδιο ISRC και διάρκεια");
    expect(ruleHint("isrc_duration")).toBe("ISRC: ο διεθνής κωδικός μιας ηχογράφησης");
    expect(ruleHint("text_exact")).toBeUndefined();
    expect(ruleLabel("some_future_rule")).toBe("Αυτόματος κανόνας");
    expect(isTitleOnlyRule("title_supported") && isTitleOnlyRule("title_unknown_artist")).toBe(true);
    expect(isTitleOnlyRule("same_words")).toBe(false);
    expect(isAutomaticMethod("auto_v1:text_clean")).toBe(true);
    expect(isAutomaticMethod("cleanup_policy_high_confidence")).toBe(false);
  });

  test("the rule filter lists the title-only rules first and leaves out rules with no decision", () => {
    const options = ruleOptions({ text_exact: 25, title_supported: 30, artist_in_title: 92, same_words: 0, title_unknown_artist: 48 });
    expect(options.map((o) => o.rule)).toEqual(["title_unknown_artist", "title_supported", "text_exact", "artist_in_title"]);
    expect(options[0]).toEqual({ rule: "title_unknown_artist", label: "Ίδιος τίτλος και διάρκεια, άγνωστος καλλιτέχνης", count: 48 });
  });

  test("a local side shows its file name, a remote side its title and artist", () => {
    expect(sideLines(row, "left")).toEqual({ main: "07 Moon Garden.mp3", sub: "Άγνωστος καλλιτέχνης — Moon Garden" });
    expect(sideLines(row, "right")).toEqual({ main: "Moon Garden", sub: "Alpha Beta" });
    expect(sideLines({ ...row, right_artist: "null", right_title: null }, "right")).toEqual({ main: "Χωρίς τίτλο", sub: "Άγνωστος καλλιτέχνης" });
  });

  test("numbers read in Greek", () => {
    expect(deltaText(0.4)).toBe("διαφορά διάρκειας 0,4 δ.");
    expect(deltaText(2)).toBe("διαφορά διάρκειας 2,0 δ.");
    expect(deltaText(null)).toBe("");
    expect(batchSummary({ link: 332, fold: 1067 })).toBe("332 συνδέσεις με αρχείο · 1.067 ενώσεις διπλότυπων");
    expect(batchSummary({ link: 1, fold: 0 })).toBe("1 σύνδεση με αρχείο");
    expect(batchSummary({ link: 0, fold: 1 })).toBe("1 ένωση διπλότυπων");
  });
});
