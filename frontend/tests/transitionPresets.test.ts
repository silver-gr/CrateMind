import { afterEach, describe, expect, test } from "bun:test";
import { PRESETS, applyPreset, presetFor } from "../src/lib/transitions/presets";
import { pairKey, type Preset, type TransitionParams } from "../src/lib/transitions/types";
import { MIX_UNSUPPORTED_EXT, isMixable } from "../src/lib/transitions/mixable";
import { api } from "../src/lib/api";

const base: TransitionParams = {
  preset: "custom", bars: 2, volume_curve: "linear", eq_curve: "bass_cut_long", filter_curve: "lpf_out",
  loop_beats: null, out_anchor_s: 120.5, in_anchor_s: 3.25, tempo_match: false,
};
const NAMED = ["fade", "rise", "blend", "wave", "melt", "slam", "dissolve", "surge", "afterglow", "none"] as const;

describe("presets", () => {
  test("presets.json holds the Appendix B table", () => {
    expect(Object.keys(PRESETS).sort()).toEqual([...NAMED].sort());
    expect(PRESETS.blend).toEqual({ volume_curve: "overlap", eq_curve: "three_band", filter_curve: "none", bars: 8, loop_beats: null });
    expect(PRESETS.surge).toEqual({ volume_curve: "overlap", eq_curve: "bass_swap_start", filter_curve: "hpf_in", bars: 4, loop_beats: 4 });
    expect(PRESETS.slam.bars).toBe(1);
    expect(PRESETS.none.bars).toBe(0);
  });

  test("every named preset round-trips through presetFor(applyPreset(p, base))", () => {
    for (const p of NAMED) expect(presetFor(applyPreset(p, base))).toBe(p);
  });

  test("named presets differ in curves + loop, so the round trip is unambiguous", () => {
    const sigs = NAMED.filter(p => p !== "none").map(p => {
      const s = PRESETS[p];
      return `${s.volume_curve}|${s.eq_curve}|${s.filter_curve}|${s.loop_beats}`;
    });
    expect(new Set(sigs).size).toBe(sigs.length);
  });

  test("applyPreset keeps the anchors and tempo match and sets the preset's bars and loop", () => {
    const next = applyPreset("surge", base);
    expect(next).toEqual({ ...base, preset: "surge", volume_curve: "overlap", eq_curve: "bass_swap_start", filter_curve: "hpf_in", bars: 4, loop_beats: 4 });
    expect(applyPreset("none", base)).toMatchObject({ preset: "none", bars: 0, loop_beats: null, out_anchor_s: 120.5 });
  });

  test("auto and custom keep the current parameters and only change the preset", () => {
    const blend = applyPreset("blend", base);
    expect(applyPreset("auto", blend)).toEqual({ ...blend, preset: "auto" });
    expect(applyPreset("custom", blend)).toEqual({ ...blend, preset: "custom" });
  });

  test("a changed volume curve becomes custom", () => {
    const wave = applyPreset("wave", base);
    expect(presetFor({ ...wave, volume_curve: "smooth" })).toBe("custom");
    expect(presetFor({ ...applyPreset("surge", base), loop_beats: 8 })).toBe("custom");
  });

  test("a bars change keeps the preset; zero bars is always «Χωρίς μετάβαση»", () => {
    const melt = applyPreset("melt", base);
    expect(presetFor({ ...melt, bars: 16 })).toBe("melt");
    expect(presetFor({ ...melt, bars: 1 })).toBe("melt");
    expect(presetFor({ ...melt, bars: 0 })).toBe("none");
  });

  test("presetFor never answers auto", () => {
    const seen = new Set<Preset>(NAMED.map(p => presetFor(applyPreset(p, base))));
    expect(seen.has("auto")).toBe(false);
  });

  test("pairKey is the ordered pair", () => {
    expect(pairKey(4, 9)).toBe("4-9");
    expect(pairKey(9, 4)).not.toBe(pairKey(4, 9));
  });
});

describe("isMixable", () => {
  test("AIFF never mixes, with or without the dot, in any case", () => {
    expect(MIX_UNSUPPORTED_EXT).toEqual([".aiff", ".aif"]);
    expect(isMixable({ extension: "aiff", duration: 200 }, 48000)).toBe(false);
    expect(isMixable({ extension: ".AIF", duration: 200 }, 48000)).toBe(false);
  });

  test("a 30-minute track at 48 kHz is over the decode budget", () => {
    expect(isMixable({ extension: "wav", duration: 30 * 60 }, 48000)).toBe(false);
  });

  test("an ordinary track mixes; an unknown duration is not refused up front", () => {
    expect(isMixable({ extension: "mp3", duration: 6 * 60 }, 48000)).toBe(true);
    expect(isMixable({ extension: "flac", duration: null }, 44100)).toBe(true);
  });
});

describe("transition API client", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  const capture = (body: unknown) => {
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    return calls;
  };

  test("GET unwraps the transitions list", async () => {
    const calls = capture({ transitions: [{ from_track_id: 1, to_track_id: 2 }] });
    expect(await api.getSetTransitions(7)).toEqual([{ from_track_id: 1, to_track_id: 2 }] as never);
    expect(calls[0].url).toBe("/api/sets/7/transitions");
  });

  test("POST sends the pair with the parameters; DELETE names the ordered pair", async () => {
    const calls = capture({ removed: true });
    await api.saveSetTransition(7, { ...base, preset: "blend", from_track_id: 1, to_track_id: 2 });
    expect(calls[0].url).toBe("/api/sets/7/transitions");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ from_track_id: 1, to_track_id: 2, preset: "blend", bars: 2 });
    expect(await api.deleteSetTransition(7, 1, 2)).toEqual({ removed: true });
    expect(calls[1].url).toBe("/api/sets/7/transitions/1/2");
    expect(calls[1].init?.method).toBe("DELETE");
  });
});
