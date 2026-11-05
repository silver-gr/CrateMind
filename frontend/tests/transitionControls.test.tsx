import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TransitionLength, BAR_PRESETS, barOptions, formatRate } from "../src/components/transitions/TransitionLength";
import { TransitionOverview, overviewLayout, overviewViewport, clampViewCenter } from "../src/components/transitions/TransitionOverview";
import { TransitionParams, PARAM_FIELDS, loopOptions } from "../src/components/transitions/TransitionParams";
import { TransitionPresets, PRESET_ORDER } from "../src/components/transitions/TransitionPresets";
import type { BeatGrid } from "../src/lib/beatGrid";
import { CONTROL_COPY, EQ_LABELS, FILTER_LABELS, PRESET_LABELS, VOLUME_LABELS } from "../src/lib/transitions/copy";
import type { LaneSpec } from "../src/lib/transitions/dualWaveform";
import { EQ_CURVES, FILTER_CURVES, LOOP_BEATS, PRESET_KEYS, VOLUME_CURVES, type TransitionParams as Params } from "../src/lib/transitions/types";

const noop = () => {};
const greek = /[Ͱ-Ͽἀ-῿]/;

const params = (over: Partial<Params> = {}): Params => ({
  preset: "blend", bars: 8, volume_curve: "overlap", eq_curve: "three_band", filter_curve: "none", loop_beats: null,
  out_anchor_s: null, in_anchor_s: null, tempo_match: true, ...over,
});

const attr = (html: string, label: string) => {
  const at = html.indexOf(`aria-label="${label}"`);
  if (at < 0) return null;
  const start = html.lastIndexOf("<", at);
  return html.slice(start, html.indexOf(">", at) + 1);
};

describe("TransitionPresets", () => {
  test("Greek chip labels, the active chip is pressed, Auto first after Custom", () => {
    const html = renderToStaticMarkup(<TransitionPresets value="blend" onChange={noop} />);
    for (const key of PRESET_KEYS.filter(k => k !== "custom")) expect(html).toContain(PRESET_LABELS[key]);
    expect(html).not.toContain(PRESET_LABELS.custom);
    expect(html).not.toMatch(/>(blend|auto|slam|none)</);
    expect(html.match(/aria-pressed="true"/g)?.length).toBe(1);
    const pressed = html.slice(html.indexOf('aria-pressed="true"'));
    expect(pressed.slice(0, pressed.indexOf("</button>"))).toContain(PRESET_LABELS.blend);
    expect(html).toContain(`aria-label="${CONTROL_COPY.presets}"`);
    expect(PRESET_ORDER[0]).toBe("custom");
    expect(PRESET_ORDER[1]).toBe("auto");
    expect(PRESET_ORDER.at(-1)).toBe("none");
    expect(new Set(PRESET_ORDER)).toEqual(new Set(PRESET_KEYS));
  });

  test("«Προσαρμογή» appears only (and pressed) for custom", () => {
    const html = renderToStaticMarkup(<TransitionPresets value="custom" onChange={noop} />);
    expect(html).toContain(PRESET_LABELS.custom);
    const pressed = html.slice(html.indexOf('aria-pressed="true"'));
    expect(pressed.slice(0, pressed.indexOf("</button>"))).toContain(PRESET_LABELS.custom);
  });
});

describe("TransitionParams", () => {
  test("option arrays map every curve to its Greek label and never show keys", () => {
    const byKey = Object.fromEntries(PARAM_FIELDS.map(f => [f.key, f]));
    expect(byKey.volume_curve.options.map(o => o.value)).toEqual([...VOLUME_CURVES]);
    expect(byKey.eq_curve.options.map(o => o.value)).toEqual([...EQ_CURVES]);
    expect(byKey.filter_curve.options.map(o => o.value)).toEqual([...FILTER_CURVES]);
    for (const o of byKey.volume_curve.options) expect(o.label).toBe(VOLUME_LABELS[o.value as keyof typeof VOLUME_LABELS]);
    for (const o of byKey.eq_curve.options) expect(o.label).toBe(EQ_LABELS[o.value as keyof typeof EQ_LABELS]);
    for (const o of byKey.filter_curve.options) expect(o.label).toBe(FILTER_LABELS[o.value as keyof typeof FILTER_LABELS]);
    expect(PARAM_FIELDS.map(f => f.label)).toEqual(["Ένταση", "EQ", "Φίλτρο"]);
  });

  test("loop options: «Χωρίς loop» plus 1..16 beats, longer than the window disabled", () => {
    const opts = loopOptions(2);
    expect(opts.map(o => o.value)).toEqual(["none", ...LOOP_BEATS.map(String)]);
    expect(opts[0].label).toBe("Χωρίς loop");
    expect(opts.find(o => o.value === "8")?.disabled).toBe(false);
    expect(opts.find(o => o.value === "16")?.disabled).toBe(true);
    expect(loopOptions(1).filter(o => o.disabled).map(o => o.value)).toEqual(["8", "16"]);
  });

  test("SSR: the four labelled selects with their current Greek values", () => {
    const html = renderToStaticMarkup(<TransitionParams value={params({ loop_beats: 4 })} onChange={noop} />);
    for (const label of ["Ένταση", "EQ", "Φίλτρο", "Loop"]) expect(html).toMatch(new RegExp(`<label[^>]*for="[^"]+"[^>]*>(<span[^>]*></span>)?${label}</label>`));
    expect(html).toContain(VOLUME_LABELS.overlap);
    expect(html).toContain(EQ_LABELS.three_band);
    expect(html).toContain(FILTER_LABELS.none);
    expect(html).toContain("4 beat loop");
    expect(html).not.toContain('disabled=""');
  });

  test("a cut (preset none) disables the curve selects", () => {
    const html = renderToStaticMarkup(<TransitionParams value={params({ preset: "none", bars: 0 })} onChange={noop} />);
    expect(html.match(/<button[^>]*disabled=""/g)?.length).toBe(4);
  });
});

describe("TransitionLength", () => {
  test("bar presets and options keep a non-preset length selectable", () => {
    expect([...BAR_PRESETS]).toEqual([1, 2, 4, 8, 16, 32]);
    expect(barOptions(8)).toEqual([1, 2, 4, 8, 16, 32]);
    expect(barOptions(5)).toEqual([1, 2, 4, 5, 8, 16, 32]);
    expect(formatRate(0.9524)).toBe("95,2 %");
    expect(formatRate(1)).toBe("100,0 %");
    expect(formatRate(null)).toBe("—");
  });

  const render = (bars: number, tempoMatch = true) => renderToStaticMarkup(
    <TransitionLength bars={bars} onBars={noop} onNudgeWindow={noop} onNudgeIn={noop}
      tempoMatch={tempoMatch} onTempoMatch={noop} rateText="95,2 %" />,
  );

  test("eight Greek-labelled buttons; −1 bar disabled at 1, +1 bar at 32", () => {
    const labels = [
      CONTROL_COPY.barsLess, CONTROL_COPY.barsMore,
      CONTROL_COPY.windowBarBack, CONTROL_COPY.windowBeatBack, CONTROL_COPY.windowBeatFwd, CONTROL_COPY.windowBarFwd,
      CONTROL_COPY.inBeatBack, CONTROL_COPY.inBeatFwd,
    ];
    expect(new Set(labels).size).toBe(8);
    const mid = render(8);
    for (const label of labels) {
      expect(label).toMatch(greek);
      expect(attr(mid, label)).not.toBeNull();
      expect(attr(mid, label)).not.toContain('disabled=""');
    }
    expect(attr(render(1), CONTROL_COPY.barsLess)).toContain('disabled=""');
    expect(attr(render(1), CONTROL_COPY.barsMore)).not.toContain('disabled=""');
    expect(attr(render(32), CONTROL_COPY.barsMore)).toContain('disabled=""');
    expect(attr(render(32), CONTROL_COPY.barsLess)).not.toContain('disabled=""');
    expect(mid).toContain("8 bars");
    expect(attr(mid, CONTROL_COPY.bars)).not.toBeNull();
  });

  test("tempo-match switch is labelled and shows the rate", () => {
    const html = render(8);
    expect(html).toMatch(/<label[^>]*for="[^"]+"[^>]*>Ταίριασμα tempo<\/label>/);
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("95,2 %");
    expect(render(8, false)).toContain('aria-checked="false"');
  });
});

describe("TransitionOverview", () => {
  const grid: BeatGrid = { kind: "straight", anchor: 0, period: 0.5, estimated: false, overridden: false };
  const out: LaneSpec = { trackId: 1, revision: 1, grid, duration: 300, rate: 1, anchorS: 240 };
  const inn: LaneSpec = { trackId: 2, revision: 1, grid, duration: 200, rate: 1, anchorS: 16 };

  test("layout: both tracks on the audio axis, incoming offset to the window start", () => {
    const l = overviewLayout(out, inn);
    expect(l.t0).toBe(-240);
    expect(l.t1).toBe(184);
    expect(l.out.left).toBeCloseTo(0);
    expect(l.out.width).toBeCloseTo(300 / 424);
    expect(l.in.left).toBeCloseTo((240 - 16) / 424);
    expect(l.in.width).toBeCloseTo(200 / 424);
    const slow = overviewLayout(out, { ...inn, rate: 0.8 });
    expect(slow.t1).toBeCloseTo(-16 / 0.8 + 200 / 0.8);
  });

  test("viewport: the view's bars around its centre, clamped to the axis", () => {
    const l = overviewLayout(out, inn);
    const v = overviewViewport(l, { centerAudioS: 0, bars: 8 }, 2);
    expect(v.left).toBeCloseTo((240 - 8) / 424);
    expect(v.width).toBeCloseTo(16 / 424);
    expect(clampViewCenter(l, 1000)).toBe(184);
    expect(clampViewCenter(l, -1000)).toBe(-240);
  });

  test("SSR: a labelled group with a keyboard-operable viewport", () => {
    const html = renderToStaticMarkup(
      <TransitionOverview out={out} in={inn} window={{ outStartS: 240, bars: 8 }} view={{ centerAudioS: 0, bars: 8 }} onViewChange={noop} />,
    );
    expect(html).toContain(`aria-label="${CONTROL_COPY.overview}"`);
    expect(html).toContain('role="slider"');
    expect(html).toContain(`aria-label="${CONTROL_COPY.viewport}"`);
    expect(html).toContain('tabindex="0"');
  });
});
