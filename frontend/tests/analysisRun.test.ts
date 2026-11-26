import { describe, expect, test } from "bun:test";
import { analysisProgress, canStopAnalysis, reanalysisDuration, wasStopped } from "../src/lib/analysisRun";

describe("reanalysisDuration", () => {
  test("the owner's library reads as the measured 2 to 3.5 hours", () => {
    expect(reanalysisDuration(4675)).toBe("περίπου 2 έως 3,5 ώρες");
  });

  test("a small library is counted in minutes", () => {
    expect(reanalysisDuration(300)).toBe("περίπου 8 έως 14 λεπτά");
    expect(reanalysisDuration(10)).toBe("λίγα λεπτά");
    expect(reanalysisDuration(0)).toBe("λίγα λεπτά");
  });
});

describe("canStopAnalysis", () => {
  test("only a running BPM/key analysis can be stopped", () => {
    expect(canStopAnalysis({ kind: "analyze", status: "running" })).toBe(true);
    expect(canStopAnalysis({ kind: "analyze", status: "pending" })).toBe(false);
    expect(canStopAnalysis({ kind: "analyze", status: "done" })).toBe(false);
    expect(canStopAnalysis({ kind: "scan", status: "running" })).toBe(false);
    expect(canStopAnalysis(null)).toBe(false);
  });
});

test("analysisProgress counts steps in Greek digits", () => {
  expect(analysisProgress({ processed: 1200, total: 14025 })).toBe("1.200 από 14.025 βήματα");
  expect(analysisProgress({ processed: 0 })).toBe("0 από 0 βήματα");
});

test("wasStopped: a done job whose message says it was stopped", () => {
  expect(wasStopped({ status: "done", message: "Διακόπηκε στο βήμα 7 από 30" })).toBe(true);
  expect(wasStopped({ status: "done", message: "analyzed 30, failed 0" })).toBe(false);
  expect(wasStopped({ status: "done" })).toBe(false);
  expect(wasStopped({ status: "error", message: "Διακόπηκε στο βήμα 7 από 30" })).toBe(false);
});
