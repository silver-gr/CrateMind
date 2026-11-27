import { afterEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToString } from "react-dom/server";
// Vite supplies these emitted module URLs in-app; the Maximizer flag and stand-in engine match tests/masterHost.test.ts, which
// shares this process and expects a build that has the Maximizer whichever file loads the audio modules first.
mock.module("../src/lib/audio/peak-limiter.worklet.js?worker&url", () => ({ default: "/test/peak-limiter.worklet.js" }));
mock.module("../src/lib/audio/master-tap.worklet.js?worker&url", () => ({ default: "/test/master-tap.worklet.js" }));
mock.module("../src/lib/audio/masterTap.worker.ts?worker&url", () => ({ default: "/test/masterTap.worker.js" }));
(globalThis as { __MAXIMIZER__?: boolean }).__MAXIMIZER__ = true;
mock.module("virtual:maximizer-engine", () => ({ loadMaximizer: async () => new ArrayBuffer(8), createMaximizer: () => { throw new Error("not stubbed"); } }));
const { DeckFacts } = await import("../src/components/DeckFacts");
import { buildBeatGrid, type BeatGrid } from "../src/lib/beatGrid";
import { getDeckTempos, keyRelation, lastSeconds, loopText, nextPart, publishDeckTempo, tempoGapText, timeLeftText } from "../src/lib/deckFacts";
import type { StructureSection } from "../src/lib/trackStructure";
import type { Track } from "../src/lib/types";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

// 150 BPM: a bar is 1.6 s, bar 1 starts at 0:00.
const grid = buildBeatGrid({ bpm: 150, straight: true, anchor_s: 0, first_downbeat_index: 0, beats: null }, null, null)!;
const bar = 1.6;
const section = (startBar: number, bars: number, bass: boolean): StructureSection => ({ start_s: startBar * bar, beats: bars * 4, bass, level: bass ? 0.8 : 0.3 });
// Intro 16 bars, main 32, break 16, main 32, outro 8: the track ends at bar 104.
const sections = [section(0, 16, false), section(16, 32, true), section(48, 16, false), section(64, 32, true), section(96, 8, false)];
const duration = 104 * bar;

describe("bars to the next part", () => {
  test("counts bar lines to the next section and names it as the app does", () => {
    expect(nextPart(grid, sections, 0, duration)).toEqual({ bars: 16, to: "Κύριο μέρος" });
    expect(nextPart(grid, sections, 32.5 * bar, duration)).toEqual({ bars: 16, to: "Break" });
    expect(nextPart(grid, sections, 63.9 * bar, duration)).toEqual({ bars: 1, to: "Κύριο μέρος" });
    expect(nextPart(grid, sections, 70 * bar, duration)).toEqual({ bars: 26, to: "Κλείσιμο" });
  });
  test("in the last section it counts to the end of the track", () => {
    expect(nextPart(grid, sections, 98 * bar + 0.1, duration)).toEqual({ bars: 6, to: "Τέλος" });
    expect(nextPart(grid, sections, 98 * bar, NaN)).toBeNull();
  });
  test("a section start a few ms off its bar line still counts as on it", () => {
    const loose = sections.map((s, i) => i === 2 ? { ...s, start_s: s.start_s + 0.02 } : s);
    expect(nextPart(grid, loose, 32.5 * bar, duration)).toEqual({ bars: 16, to: "Break" });
  });
  test("with no measured sections it counts to the next phrase line of a trusted grid", () => {
    const phrased: BeatGrid = { ...grid, phrases: [0, 8 * bar, 16 * bar, 24 * bar] };
    expect(nextPart(phrased, null, 9.5 * bar, duration)).toEqual({ bars: 7, to: "Φράση" });
    expect(nextPart(phrased, [], 8 * bar + 0.01, duration)).toEqual({ bars: 8, to: "Φράση" });
    // Past the last measured line there is nothing to count down to.
    expect(nextPart(phrased, null, 25 * bar, duration)).toBeNull();
  });
  test("hidden with no grid and on a grid estimated from tempo and entry cue alone", () => {
    expect(nextPart(null, sections, 10, duration)).toBeNull();
    expect(nextPart({ ...grid, estimated: true }, sections, 10, duration)).toBeNull();
    // An estimate the owner gave a downbeat is trusted.
    expect(nextPart({ ...grid, estimated: true, overridden: true }, sections, 0, duration)).toEqual({ bars: 16, to: "Κύριο μέρος" });
    expect(nextPart(grid, sections, NaN, duration)).toBeNull();
  });
});

describe("facts row texts", () => {
  test("time left, rose in the last 30 seconds", () => {
    expect(timeLeftText(480, 228)).toBe("-4:12");
    expect(timeLeftText(480, 479.6)).toBe("-0:00");
    expect(timeLeftText(480, 500)).toBe("-0:00");
    expect(timeLeftText(0, 0)).toBe("-0:00");
    expect(timeLeftText(NaN, 3)).toBe("-0:00");
    expect(lastSeconds(480, 449)).toBe(false);
    expect(lastSeconds(480, 450)).toBe(true);
    expect(lastSeconds(0, 0)).toBe(false);
  });
  test("the loop chip prints whole beats and fractions", () => {
    expect(loopText(4)).toBe("LOOP 4");
    expect(loopText(16)).toBe("LOOP 16");
    expect(loopText(0.5)).toBe("LOOP 1/2");
    expect(loopText(0.125)).toBe("LOOP 1/8");
  });
  test("the centre cell says once whether the two keys mix, as Camelot codes", () => {
    expect(keyRelation("8A", "9A")).toEqual({ fit: true, a: "8A", b: "9A" });
    expect(keyRelation("8A", "3B")).toEqual({ fit: false, a: "8A", b: "3B" });
    expect(keyRelation("Am", "Em")).toEqual({ fit: true, a: "8A", b: "9A" });
    // An uncertain key («~8A») still takes part; a deck with no key leaves the line out.
    expect(keyRelation("~8A", "8A")?.fit).toBe(true);
    expect(keyRelation("8A", null)).toBeNull();
    expect(keyRelation(undefined, "")).toBeNull();
  });
  test("the tempo difference shows while both decks have a tempo", () => {
    expect(tempoGapText(145, 146.1)).toBe("Δ 1.1 BPM");
    expect(tempoGapText(146.1, 145)).toBe("Δ 1.1 BPM");
    expect(tempoGapText(145, null)).toBeNull();
  });
  test("each half publishes its tempo for the centre cell; an identical value keeps the snapshot", () => {
    publishDeckTempo("A", 145);
    const first = getDeckTempos();
    publishDeckTempo("A", 145);
    expect(getDeckTempos()).toBe(first);
    publishDeckTempo("B", 144);
    expect(getDeckTempos()).toEqual({ A: 145, B: 144 });
    publishDeckTempo("A", null); publishDeckTempo("B", null);
  });
});

describe("one deck's half of the facts row", () => {
  afterEach(() => { publishDeckTempo("A", null); publishDeckTempo("B", null); });
  const track: Track = { id: 611, absolute_path: "/synthetic/a.wav", file_name: "a.wav", extension: "wav", title: "Συνθετικό", artist: "Δοκιμή", key_text: "8A", missing: false, play_count: 0 };
  const half = (props: Partial<Parameters<typeof DeckFacts>[0]> = {}) => renderToString(
    <DeckFacts deck="A" track={track} time={228} duration={480} tempo={145} pitch="-0.7%" grid={grid} loop={{ beats: 4, on: false }} keyFormat="camelot" {...props}>
      <i data-overview />
    </DeckFacts>);
  const order = (html: string, labels: string[]) => labels.map(label => html.indexOf(label));

  test("from the outer edge to the playhead: letter, title, LOOP, tempo, key, time left; the overview under them", () => {
    const html = half();
    const at = order(html, [">A</span>", "Συνθετικό", "LOOP 4", 'aria-label="Tempo, Deck A"', "8A", 'aria-label="Υπόλοιπο χρόνου, Deck A"', "data-overview"]);
    expect(at.every((value, i) => value > -1 && (i === 0 || value > at[i - 1]))).toBe(true);
    expect(html).toContain('role="group" aria-label="Στοιχεία Deck A"');
    expect(html).toMatch(/aria-label="Υπόλοιπο χρόνου, Deck A"[^>]*>-4:12</);
    expect(html).toMatch(/aria-label="Tempo, Deck A"[^>]*>145\.0</);
    expect(html).toContain("-0.7%");
    expect(html).toContain("Συνθετικό</span> · Δοκιμή");
  });
  test("deck B is mirrored, so both time-left numbers sit beside the playhead", () => {
    expect(half()).not.toContain("flex-row-reverse");
    const mirrored = half({ deck: "B", mirrored: true });
    expect(mirrored).toContain("flex-row-reverse");
    expect(mirrored).toContain("text-right");
  });
  test("a narrow half drops title, LOOP, the part's name and the pitch, in that order; the main numbers have no drop", () => {
    const html = half();
    expect(html).toMatch(/@max-\[600px\]\/facts:hidden[^>]*title="Συνθετικό · Δοκιμή"/);
    expect(html).toMatch(/@max-\[540px\]\/facts:hidden[^>]*>LOOP 4</);
    expect(html).toMatch(/@max-\[380px\]\/facts:hidden[^>]*>-0\.7%</);
    expect(read("../src/components/DeckFacts.tsx")).toContain('<span className="@max-[470px]/facts:hidden"> → {part.to}</span>');
    for (const label of ['aria-label="Υπόλοιπο χρόνου, Deck A"', 'aria-label="Tempo, Deck A"']) {
      expect(html.match(new RegExp(`${label}[^>]*>`))?.[0]).not.toContain("hidden");
    }
    // The slot in the panel is the size container the steps measure.
    expect(read("../src/components/DeckViewSlot.tsx")).toContain("@container/facts relative flex min-w-0 flex-1");
  });
  test("rose means only the last 30 seconds; a running loop lights its chip in the deck colour", () => {
    expect(half()).not.toContain("text-cm-rose");
    expect(half({ time: 455 })).toMatch(/aria-label="Υπόλοιπο χρόνου, Deck A"[^>]*text-cm-rose[^>]*>-0:25</);
    expect(half()).toMatch(/title="Το μήκος που θα πάρει το επόμενο loop, σε beats"[^>]*text-cm-faint/);
    expect(half({ loop: { beats: 8, on: true } })).toMatch(/title="Τρέχει loop"[^>]*var\(--deck\)[^>]*>LOOP 8</);
  });
  test("a deck that cannot change its tempo shows no pitch, and one without a BPM a dash", () => {
    const html = half({ tempo: null, pitch: null });
    expect(html).toMatch(/aria-label="Tempo, Deck A"[^>]*>—</);
    expect(html).not.toContain("%<");
  });
  test("a window too short for the overview keeps the numbers alone", () => {
    expect(half()).toContain("data-overview");
    expect(half({ compact: true })).not.toContain("data-overview");
  });
});

describe("the facts live inside the deck", () => {
  const player = read("../src/components/MiniPlayer.tsx");
  test("MiniPlayer portals its half into its own slot, as a sibling of the lane's portal and before the deck's root", () => {
    expect(player).toMatch(/const factsPortal = twoDeck && view\.facts && createPortal\(\s*<DeckFacts deck=\{deck\} mirrored=\{mirrored\}/);
    expect(player).toMatch(/<DeckOverview deck=\{deck\}[\s\S]{0,400}onSeek=\{seekTo\}[\s\S]{0,200}<\/DeckFacts>, view\.facts\);/);
    // Fixed places in the fragment in both deck modes: the deck's root (and its <audio>) never moves, so it never remounts.
    expect(player).toMatch(/<>\s*\{lanePortal\}\s*\{factsPortal\}\s*<div\s/);
  });
  test("the controller's telemetry snapshot is not what feeds the row", () => {
    expect(read("../src/components/DeckFacts.tsx")).not.toContain("deckTelemetry");
    expect(read("../src/lib/deckFacts.ts")).not.toContain("deckTelemetry");
  });
});
