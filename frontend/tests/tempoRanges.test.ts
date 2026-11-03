import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { analyzeRequestBody } from "../src/lib/api";
import { resetPrefs, setPref } from "../src/lib/prefs";
import { activeRootRanges, activeTempoRange, methodLabel, TEMPO_RANGE_LABELS } from "../src/lib/tempoRanges";
import { jobProgressText } from "../src/components/AnalyzeBpmDialog";
import type { DjRangeKey } from "../src/lib/tempoRanges";

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

afterEach(() => resetPrefs());

describe("active tempo window", () => {
  test("the therapy profile always analyses with the therapy window and no folder windows", () => {
    setPref("djTempoRange", "slow");
    setPref("tempoRangeByRoot", { "/music/down": "slow" });
    setPref("libraryProfile", "therapy");
    expect(activeTempoRange()).toBe("therapy");
    expect(activeRootRanges()).toEqual({});
  });

  test("the DJ profile uses the stored DJ window and folder windows", () => {
    setPref("libraryProfile", "dj");
    expect(activeTempoRange()).toBe("psy");
    setPref("djTempoRange", "mixed");
    setPref("tempoRangeByRoot", { "/music/down": "slow" });
    expect(activeTempoRange()).toBe("mixed");
    expect(activeRootRanges()).toEqual({ "/music/down": "slow" });
  });

  test("stale stored keys fall back to the default and stale folder entries are dropped", () => {
    setPref("libraryProfile", "dj");
    setPref("djTempoRange", "house" as DjRangeKey);
    setPref("tempoRangeByRoot", { "/a": "therapy" as DjRangeKey, "/b": "mixed" });
    expect(activeTempoRange()).toBe("psy");
    expect(activeRootRanges()).toEqual({ "/b": "mixed" });
  });

  test("window labels are Greek and name the BPM span", () => {
    expect(TEMPO_RANGE_LABELS).toEqual({
      psy: "Psy / hi-tech (133–286)",
      mixed: "Μικτό 4/4 (118–250)",
      slow: "Αργά / downtempo (70–125)",
      therapy: "Μουσικοθεραπεία (40–240)",
    });
  });
});

describe("method labels", () => {
  const rows: [string, string][] = [
    ["librosa-onset-multilag-v2", "Ανάλυση BPM (135–286)"],
    ["librosa-onset-multilag-v2@133-286", "Ανάλυση BPM (psy 133–286)"],
    ["librosa-onset-multilag-v2@118-250", "Ανάλυση BPM (μικτό 118–250)"],
    ["librosa-onset-multilag-v2@70-125", "Ανάλυση BPM (αργά 70–125)"],
    ["librosa-onset-wide-v1@40-240", "Ανάλυση BPM (μουσικοθεραπεία 40–240)"],
    ["ffmpeg+onset-autocorr-v1@133-286", "Εναλλακτική ανάλυση BPM (psy 133–286)"],
    ["ffmpeg+onset-autocorr-v1@118-250", "Εναλλακτική ανάλυση BPM (μικτό 118–250)"],
    ["ffmpeg+onset-autocorr-v1@70-125", "Εναλλακτική ανάλυση BPM (αργά 70–125)"],
    ["ffmpeg+onset-autocorr-v1", "Εναλλακτική ανάλυση BPM (135–286)"],
    ["librosa-beat-v9@1-2", "Ανάλυση BPM"],
    ["something else", "Ανάλυση BPM"],
  ];

  test.each(rows)("%s → %s", (method, label) => {
    expect(methodLabel(method)).toBe(label);
  });

  test("no method means no label, and no label leaks a raw method string", () => {
    expect(methodLabel(null)).toBeNull();
    expect(methodLabel(undefined)).toBeNull();
    expect(methodLabel("")).toBeNull();
    for (const [method] of rows) {
      const label = methodLabel(method) ?? "";
      expect(label).not.toMatch(/librosa|ffmpeg|@/);
    }
  });
});

describe("analysis request bodies", () => {
  test("unscoped bodies carry force, limit, the window and folder windows", () => {
    expect(analyzeRequestBody({ force: true, tempoRange: "mixed", rootRanges: { "/m": "slow" } })).toEqual({
      force: true, limit: null, tempo_range: "mixed", root_ranges: { "/m": "slow" },
    });
    expect(analyzeRequestBody()).toEqual({ force: false, limit: null, tempo_range: "psy", root_ranges: {} });
  });

  test("scoped bodies send the ids or the query, never both, and no folder windows", () => {
    expect(analyzeRequestBody({ tempoRange: "slow", trackIds: [3, 1] })).toEqual({ tempo_range: "slow", track_ids: [3, 1] });
    expect(analyzeRequestBody({ tempoRange: "therapy", query: "" })).toEqual({ tempo_range: "therapy", query: "" });
    expect(analyzeRequestBody({ tempoRange: "psy", query: "artist:Zed", dryRun: true })).toEqual({
      tempo_range: "psy", query: "artist:Zed", dry_run: true,
    });
  });

  test("a stale window outside the registry is sent as psy, and stale folder windows are dropped", () => {
    expect(analyzeRequestBody({ tempoRange: "house" as DjRangeKey, rootRanges: { "/a": "fast" as DjRangeKey, "/b": "slow" } })).toEqual({
      force: false, limit: null, tempo_range: "psy", root_ranges: { "/b": "slow" },
    });
    expect(analyzeRequestBody({ tempoRange: "house" as DjRangeKey, trackIds: [1] })).toEqual({ tempo_range: "psy", track_ids: [1] });
  });
});

describe("«Ανάλυση BPM» dialog", () => {
  test("progress shows done / total, falling back to the dry-run count", () => {
    expect(jobProgressText({ id: 1, kind: "analyze", status: "running", processed: 12, total: 3400 }, 10)).toBe("12 / 3.400");
    expect(jobProgressText({ id: 1, kind: "analyze", status: "pending", processed: 0 }, 5)).toBe("0 / 5");
    expect(jobProgressText({ id: 1, kind: "analyze", status: "pending", processed: 0 })).toBe("0");
  });

  test("the dialog follows the job with pollJob and reloads rows when it ends", () => {
    const dialog = source("components/AnalyzeBpmDialog.tsx");
    expect(dialog.includes("pollJob(")).toBe(true);
    expect(dialog.includes("read: api.scanStatus")).toBe(true);
    const terminal = dialog.indexOf("const terminal = await pollJob(");
    expect(terminal).toBeGreaterThan(-1);
    const done = dialog.indexOf("onDoneRef.current()", terminal);
    expect(done).toBeGreaterThan(terminal);
    expect(dialog.indexOf("new Event(ANALYSIS_FINISHED)", terminal)).toBeGreaterThan(terminal);
  });

  test("the dialog can be hidden while the job runs and the job is still followed to the end", () => {
    const dialog = source("components/AnalyzeBpmDialog.tsx");
    expect(dialog).toContain("<Dialog open={open} onOpenChange={close}>");
    expect(dialog).not.toContain("if (!running) onOpenChange");
    expect(dialog).not.toContain(".abort()");
    expect(dialog).toContain("onConnection: setConnection");
  });

  test("a hidden job ends with the caller's latest callbacks, not those captured at «Ανάλυση»", () => {
    const dialog = source("components/AnalyzeBpmDialog.tsx");
    expect(dialog).toContain("onDoneRef.current = onDone;");
    expect(dialog).toContain("await onDoneRef.current();");
    expect(dialog).toContain("if (openRef.current) onOpenChangeRef.current(false);");
    expect(dialog).not.toMatch(/await onDone\(\)|[^.]onOpenChange\(false\)/);
    // An unmounted instance never closes a dialog shown later.
    expect(dialog).toContain("useEffect(() => () => { openRef.current = false; }, []);");
  });

  test("a reopened dialog keeps the running job's window and count", () => {
    expect(source("components/AnalyzeBpmDialog.tsx")).toContain("if (!open || running) return;");
  });

  test("Crates keeps the dialog mounted while hidden, and the Library reloads after any analysis", () => {
    const crates = source("pages/Crates.tsx");
    expect(crates).toContain("open={analyzeOpen}");
    expect(crates).toContain("onOpenChange={setAnalyzeOpen}");
    expect(crates).not.toMatch(/if \(!open\) setAnalyzeTarget\(null\)/);
    expect(source("pages/Library.tsx")).toContain("addEventListener(ANALYSIS_FINISHED, onAnalysisFinished)");
  });

  test("Settings passes the active window to scans and analyses; the bulk bar and crates render the dialog", () => {
    const settings = source("pages/Settings.tsx");
    expect(settings).toMatch(/api\.startScan\([^;]*activeTempoRange\(\)/s);
    expect(settings).toMatch(/api\.startAnalyze\(\{[^}]*activeTempoRange\(\)/s);
    expect(settings.includes("followAnalysisJob(current, api.scanStatus)")).toBe(true);
    expect(source("components/BulkTagBar.tsx").includes("<AnalyzeBpmDialog")).toBe(true);
    expect(source("pages/Crates.tsx").includes("<AnalyzeBpmDialog")).toBe(true);
  });

  test("Enter or Space on a crate card's action buttons runs the button, not the card", () => {
    const crates = source("pages/Crates.tsx");
    const handler = crates.slice(crates.indexOf("onKeyDown={(e) => {"), crates.indexOf("onOpen();", crates.indexOf("onKeyDown={(e) => {")));
    expect(handler).toContain("if (e.target !== e.currentTarget) return;");
    expect(handler.indexOf("e.target !== e.currentTarget")).toBeLessThan(handler.indexOf("e.preventDefault()"));
  });
});
