import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { TASK_RESULT_TOAST } from "../src/lib/labels";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("toast lifetimes", () => {
  test("toasts time out by default", () => {
    const shell = read("../src/components/layout/AppShell.tsx");
    expect(shell).not.toContain("duration={Infinity}");
  });

  test("a task's outcome stays until closed, with the close button", () => {
    expect(TASK_RESULT_TOAST).toEqual({ duration: Infinity, closeButton: true });
  });

  test("every task outcome uses it: jobs in Ρυθμίσεις, BPM dialog, duplicates, artist research, backup import", () => {
    for (const [file, outcomes] of [
      ["../src/pages/Settings.tsx", 2],
      ["../src/components/AnalyzeBpmDialog.tsx", 2],
      ["../src/pages/Duplicates.tsx", 2],
      ["../src/pages/Artists.tsx", 2],
      ["../src/pages/Dashboard.tsx", 2],
    ] as const) {
      expect(read(file).match(/TASK_RESULT_TOAST,?\s*\)/g)?.length ?? 0, file).toBe(outcomes);
    }
  });
});
