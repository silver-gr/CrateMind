import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { cuePresentation, CueMarkers, waveCueMarker } from "../src/components/PlayerCues";
import type { TrackCue, TrackCueKind } from "../src/lib/types";

function cue(id: number, position_ms: number, kind: TrackCueKind, label: string | null = null): TrackCue {
  return { id, track_id: 1, position_ms, kind, label, created_at: "", updated_at: "" };
}

describe("numbered cue presentation", () => {
  test("numbers every kind chronologically with deterministic ties and cycling colors", () => {
    const cues = [cue(9, 3000, "exit"), cue(7, 1000, "cue"), cue(4, 1000, "entry"), cue(1, 4000, "cue")];
    const before = structuredClone(cues);
    const presentation = cuePresentation(cues);

    expect(presentation.map(({ cue, ordinal, colorClass }) => [cue.id, ordinal, colorClass])).toEqual([
      [4, 1, "text-cm-cyan"],
      [7, 2, "text-cm-chartreuse"],
      [9, 3, "text-cm-violet"],
      [1, 4, "text-cm-cyan"],
    ]);
    expect(cues).toEqual(before);
    expect(presentation[0].cue).toBe(cues[2]);
  });

  test("recomputes numbers and colors after a time edit or deletion without changing IDs", () => {
    const cues = [cue(1, 1000, "entry"), cue(2, 2000, "cue"), cue(3, 3000, "exit")];
    const moved = cues.map(cue => cue.id === 3 ? { ...cue, position_ms: 0 } : cue);
    expect(cuePresentation(moved).map(({ cue, ordinal }) => [cue.id, ordinal]))
      .toEqual([[3, 1], [1, 2], [2, 3]]);
    expect(cuePresentation(moved.filter(cue => cue.id !== 1)).map(({ cue, ordinal, colorClass }) => [cue.id, ordinal, colorClass]))
      .toEqual([[3, 1, "text-cm-cyan"], [2, 2, "text-cm-chartreuse"]]);
    expect(cuePresentation([])).toEqual([]);
  });

  test("waveform markers show numbers and preserve kind, timestamp, label, and matching color", () => {
    const cues = [cue(3, 3000, "exit"), cue(2, 2000, "cue", "break"), cue(1, 1000, "entry")];
    const html = renderToString(<CueMarkers cues={cues} duration={10} canSeek onSeek={() => {}} />);
    const buttons = html.match(/<button\b[^>]*>.*?<\/button>/g) ?? [];

    expect(buttons).toHaveLength(3);
    for (const [index, kind, color] of [[0, "Entry", "cyan"], [1, "Cue", "chartreuse"], [2, "Exit", "violet"]] as const) {
      expect(buttons[index]).toContain(`aria-label="Μετάβαση: ${index + 1} · ${kind} 0:0${index + 1}.000`);
      expect(buttons[index]).toContain(`text-cm-${color}`);
      expect(buttons[index]).toContain(`<span aria-hidden="true">${index + 1}</span>`);
    }
    expect(buttons[1]).toContain("— break");
    expect(html).toContain("left:10%");
    expect(html).toContain("left:30%");
  });

  test("markers preserve disabled seeking and empty or invalid-duration states", () => {
    const cues = [cue(1, 1000, "entry")];
    const disabled = renderToString(<CueMarkers cues={cues} duration={10} canSeek={false} onSeek={() => {}} />);
    expect(disabled).toContain('disabled=""');
    expect(renderToString(<CueMarkers cues={cues} duration={0} canSeek onSeek={() => {}} />)).toBe("");
    expect(renderToString(<CueMarkers cues={[]} duration={10} canSeek onSeek={() => {}} />)).not.toContain("<button");
  });
});

describe("big waveform cue markers", () => {
  const slots = [null, null, null, null, 42, null, null, null];
  test("a cue on a pad takes that pad's colour and number", () => {
    expect(waveCueMarker(cue(42, 1000, "exit"), slots)).toEqual({ color: "var(--color-cm-chartreuse)", pad: 5 });
    expect(waveCueMarker(cue(42, 1000, "exit"), [42, null, null, null, null, null, null, null])).toEqual({ color: "var(--color-cm-cyan)", pad: 1 });
  });
  test("a cue on no pad keeps its kind colour and gets no number", () => {
    expect(waveCueMarker(cue(7, 1000, "entry"), slots)).toEqual({ color: "#34d399", pad: null });
    expect(waveCueMarker(cue(7, 1000, "exit"))).toEqual({ color: "#fb7185", pad: null });
    expect(waveCueMarker(cue(7, 1000, "cue"), slots)).toEqual({ color: "#22d3ee", pad: null });
  });
});
