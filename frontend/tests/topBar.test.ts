import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
// Vite supplies these emitted module URLs in-app; the Maximizer flag and stand-in engine match tests/masterHost.test.ts, which
// shares this process and expects a build that has the Maximizer whichever file loads the audio modules first.
mock.module("../src/lib/audio/peak-limiter.worklet.js?worker&url", () => ({ default: "/test/peak-limiter.worklet.js" }));
mock.module("../src/lib/audio/master-tap.worklet.js?worker&url", () => ({ default: "/test/master-tap.worklet.js" }));
mock.module("../src/lib/audio/masterTap.worker.ts?worker&url", () => ({ default: "/test/masterTap.worker.js" }));
(globalThis as { __MAXIMIZER__?: boolean }).__MAXIMIZER__ = true;
mock.module("virtual:maximizer-engine", () => ({ loadMaximizer: async () => new ArrayBuffer(8), createMaximizer: () => { throw new Error("not stubbed"); } }));
const { analysisPercent, clockText } = await import("../src/components/layout/TopBar");

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("top bar readouts", () => {
  test("the analysis chip shows only while a BPM / key analysis is pending or running", () => {
    expect(analysisPercent({ kind: "analyze", status: "running", processed: 41, total: 100 })).toBe(41);
    expect(analysisPercent({ kind: "analyze", status: "running", processed: 2, total: 3 })).toBe(66);
    expect(analysisPercent({ kind: "analyze", status: "pending", processed: 0 })).toBe(0);
    expect(analysisPercent({ kind: "analyze", status: "done", processed: 100, total: 100 })).toBeNull();
    expect(analysisPercent({ kind: "scan", status: "running", processed: 5, total: 10 })).toBeNull();
    expect(analysisPercent(null)).toBeNull();
  });
  test("the clock is 24-hour with two-digit minutes", () => {
    expect(clockText(new Date(2026, 10, 27, 23, 4))).toBe("23:04");
    expect(clockText(new Date(2026, 10, 27, 7, 30))).toBe("07:30");
  });
});

describe("the bar over the title strip", () => {
  const shell = read("../src/components/layout/AppShell.tsx");
  const bar = read("../src/components/layout/TopBar.tsx");
  const css = read("../src/index.css");
  test("the strip stays bare and drag-only; the bar is a separate layer in every host, and the floating REC pill is gone", () => {
    expect(shell).toContain('<div data-native-titlebar-strip data-tauri-drag-region aria-hidden="true" />');
    expect(shell).toMatch(/<WindowControls \/>\s*<TopBar \/>/);
    expect(shell).not.toContain("RecordingPill");
    expect(read("../src/components/RecordingControls.tsx")).not.toContain("RecordingPill");
  });
  test("the strip is 32 px in every host: the desktop windows, macOS full screen and the web runner", () => {
    expect(css).toContain(":root { --cm-titlebar-height: 32px; }");
    expect(css.match(/--cm-titlebar-height:/g)).toHaveLength(1);
    expect(css).not.toMatch(/\[data-native-titlebar-strip\] \{\s*display: none;/);
    // The deck panel counts the bar when it decides whether the lanes fit.
    expect(read("../src/lib/deckView.ts")).toContain("chrome = TOP_BAR_HEIGHT");
  });
  test("the layer ignores the pointer, keeps 32 px and keeps each host's corners clear", () => {
    expect(bar).toContain("pointer-events-none fixed inset-x-0 top-0 z-50 h-[var(--cm-titlebar-height)]");
    // macOS windowed: the traffic lights; Windows: the caption buttons; full screen and the web runner: 12 px each side.
    expect(bar).toContain('mac ? "pl-[88px] pr-3" : host === "custom" ? "pl-3 pr-[150px]" : "px-3"');
    expect(bar).toContain('const mac = host === "overlay";');
    // The controller status is plain text that drags the window.
    expect(bar).toMatch(/barChip, "pointer-events-none border-transparent/);
  });
  test("an installed PWA keeps its own title band above the bar", () => {
    const pwa = read("../src/components/layout/PwaTitlebar.css");
    expect(pwa).toMatch(/\.cm-pwa-titlebar \{\s*display: block;[^}]*order: -1;/);
    expect(pwa).toMatch(/\[data-top-bar\] \{\s*top: calc\(env\(titlebar-area-y, 0px\) \+ env\(titlebar-area-height, 0px\)\);/);
    expect(bar).toContain("data-top-bar");
  });
  test("buttons take the pointer back; REC keeps its width while recording", () => {
    expect(read("../src/components/RecordingControls.tsx")).toContain('export const barChip = "pointer-events-auto');
    expect(read("../src/components/RecordingControls.tsx")).toContain("w-[228px]");
  });
});
