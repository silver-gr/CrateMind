import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FacetFilterView, createLatestLoader } from "../src/components/FacetFilterPanel";
import { Slider } from "../src/components/ui/slider";
import { boundsFromQuery, facetTokenActive, foldText, rangeFromQuery, setRangeToken, toggleFacetToken } from "../src/lib/queryGrammar";
import type { Facet } from "../src/lib/types";

const voice: Facet = {
  id: 2, key: "voice", label: "Φωνή", multi: false, sort_order: 1,
  values: [{ id: 31, value: "με στίχους", count: 4 }, { id: 32, value: "οργανικό", count: 3 }],
};
const purpose: Facet = {
  id: 1, key: "purpose", label: "Θεραπευτικός στόχος", multi: true, sort_order: 0,
  values: [{ id: 11, value: "χαλάρωση", count: 2 }, { id: 12, value: "ύπνος", count: 0 }],
};
const voiceSiblings = voice.values.map(v => v.value);

describe("foldText", () => {
  test("drops accents, lowercases and folds final sigma", () => {
    expect(foldText("Χαλάρωση")).toBe("χαλαρωση");
    expect(foldText("ΜΆΝΟΣ")).toBe("μανοσ");
  });
});

describe("toggleFacetToken", () => {
  test("adds a quoted facet token after the typed words", () => {
    expect(toggleFacetToken("ambient", "purpose", "χαλάρωση", { single: false, siblings: [] })).toBe('ambient purpose:"χαλάρωση"');
  });

  test("a typed accentless token is active and a click removes it rather than adding a duplicate", () => {
    expect(facetTokenActive("purpose:χαλαρωση", "purpose", "χαλάρωση")).toBe(true);
    expect(toggleFacetToken("purpose:χαλαρωση", "purpose", "χαλάρωση", { single: false, siblings: [] })).toBe("");
  });

  test("single-value facets act as radios", () => {
    expect(toggleFacetToken('voice:"με στίχους"', "voice", "οργανικό", { single: true, siblings: voiceSiblings }))
      .toBe('voice:"οργανικό"');
  });

  test("negated tokens, key:*, paths and free words stay byte-for-byte", () => {
    const query = '-mood:* folder:"C:\\Music" deep  forest';
    expect(toggleFacetToken(query, "mood", "ήρεμο", { single: false, siblings: [] }))
      .toBe('-mood:* folder:"C:\\Music" deep forest mood:"ήρεμο"');
    expect(toggleFacetToken('-voice:"οργανικό" voice:*', "voice", "με στίχους", { single: true, siblings: voiceSiblings }))
      .toBe('-voice:"οργανικό" voice:* voice:"με στίχους"');
  });
});

describe("range tokens", () => {
  test("setRangeToken writes, replaces and removes positive tokens only", () => {
    expect(setRangeToken("ambient", "bpm", [60, 80])).toBe("ambient bpm:60-80");
    expect(setRangeToken("bpm:100-120 ambient", "bpm", [60, 80])).toBe("ambient bpm:60-80");
    expect(setRangeToken("ambient bpm:60-80", "bpm", null)).toBe("ambient");
    expect(setRangeToken("-bpm:90-100", "bpm", [60, 80])).toBe("-bpm:90-100 bpm:60-80");
    expect(setRangeToken("-bpm:90-100", "bpm", null)).toBe("-bpm:90-100");
  });

  test("rangeFromQuery reads a positive two-value range only", () => {
    expect(rangeFromQuery("ambient valence:6-8", "valence")).toEqual([6, 8]);
    expect(rangeFromQuery("valence:6", "valence")).toBeNull();
    expect(rangeFromQuery("-valence:6-8", "valence")).toBeNull();
  });

  test("boundsFromQuery reads single values and open ranges for the slider display", () => {
    expect(boundsFromQuery("energy:7", "energy", 1, 10)).toEqual([7, 7]);
    expect(boundsFromQuery("darkness:7+ energy:8+", "energy", 1, 10)).toEqual([8, 10]);
    expect(boundsFromQuery("bpm:150-", "bpm", 40, 240)).toEqual([40, 150]);
    expect(boundsFromQuery("bpm:60-80", "bpm", 40, 240)).toEqual([60, 80]);
    expect(boundsFromQuery("-energy:7 ambient", "energy", 1, 10)).toBeNull();
  });
});

describe("facet counts", () => {
  test("the older of two responses is ignored", async () => {
    const pending = new Map<string, (value: string) => void>();
    const applied: string[] = [];
    const loader = createLatestLoader(
      (q: string) => new Promise<string>(resolve => pending.set(q, resolve)),
      result => applied.push(result),
    );
    loader.load("old");
    loader.load("new");
    pending.get("new")!("new result");
    pending.get("old")!("old result");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(applied).toEqual(["new result"]);
  });
});

describe("facet panel view", () => {
  const render = (draft: string, counts: Record<string, number> | null) => renderToStaticMarkup(createElement(FacetFilterView, {
    facets: [purpose, voice], counts, draft, profile: "therapy", collapsed: [],
    onToggleSection: () => {}, onApply: () => {},
  }));
  const button = (html: string, label: string) =>
    html.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}(?:(?!</button>).)*</button>`))?.[0] ?? "";

  test("a radio sibling with a zero count stays enabled and replaces the selection", () => {
    const draft = 'voice:"με στίχους"';
    const html = render(draft, { 31: 4 });
    expect(html).toContain('role="radiogroup"');
    expect(button(html, "οργανικό")).toContain('role="radio"');
    expect(button(html, "οργανικό")).not.toContain('aria-disabled="true"');
    expect(button(html, "με στίχους")).toContain('aria-checked="true"');
    expect(toggleFacetToken(draft, "voice", "οργανικό", { single: true, siblings: voiceSiblings })).toBe('voice:"οργανικό"');
    // A multi-value value that would give no results is disabled.
    expect(button(html, "ύπνος")).toContain('role="checkbox"');
    expect(button(html, "ύπνος")).toContain('aria-disabled="true"');
  });

  test("a disabled value stays focusable, so the radiogroup keeps its tab stop", () => {
    // Nothing chosen and the first radio has a zero count.
    const html = render("", { 32: 3 });
    const first = button(html, "με στίχους");
    expect(first).toContain('aria-disabled="true"');
    expect(first).toContain('tabindex="0"');
    expect(first).not.toMatch(/ disabled=""/);
    // A value removed from a zero-result query keeps focus: it is never natively disabled.
    expect(render('purpose:"ύπνος"', {})).not.toMatch(/<button[^>]* disabled=""[^>]*role="(checkbox|radio)"|<button[^>]*role="(checkbox|radio)"[^>]* disabled=""/);
  });

  test("a single-value or open-ended token shows what it filters, not «όλα»", () => {
    const html = render("energy:8+ valence:7", null);
    expect(html).toContain("8–10");
    expect(html).toContain("7–7");
    expect(html).toContain("left:77.77777777777777%;right:0%"); // the energy track spans 8-10
  });

  test("«Καθαρισμός φίλτρων» is never natively disabled, so clearing keeps the keyboard focus", () => {
    const empty = button(render("", null), "Καθαρισμός φίλτρων");
    expect(empty).toContain('aria-disabled="true"');
    expect(empty).not.toMatch(/ disabled=""/);
    expect(button(render("bpm:60-80", null), "Καθαρισμός φίλτρων")).not.toContain('aria-disabled="true"');
  });

  test("sections expose aria-expanded and aria-controls; no facet key leaks", () => {
    const html = render("purpose:χαλαρωση -voice:*", null);
    expect(html).toMatch(/aria-expanded="true"[^>]*aria-controls="[^"]+"|aria-controls="[^"]+"[^>]*aria-expanded="true"/);
    expect(button(html, "χαλάρωση")).toContain('aria-checked="true"');
    expect(html).toContain("εκτός");
    expect(html).not.toMatch(/purpose|voice/);
    expect(html).toContain("Ελάχιστο BPM");
    expect(html).toContain("Μέγιστο BPM");
  });
});

describe("slider thumbs", () => {
  test("each thumb gets its own label", () => {
    const html = renderToStaticMarkup(createElement(Slider, {
      value: [60, 80], min: 40, max: 240, thumbLabels: ["Ελάχιστο BPM", "Μέγιστο BPM"],
    }));
    const labels = [...html.matchAll(/role="slider"[^>]*aria-label="([^"]+)"|aria-label="([^"]+)"[^>]*role="slider"/g)]
      .map(m => m[1] ?? m[2]);
    expect(labels).toEqual(["Ελάχιστο BPM", "Μέγιστο BPM"]);
  });
});

describe("Library wiring", () => {
  test("counts are keyed on the applied query, not the draft", () => {
    const library = readFileSync(new URL("../src/pages/Library.tsx", import.meta.url), "utf8");
    const panel = library.match(/<FacetFilterPanel[^>]*\/>/)?.[0] ?? "";
    expect(panel).toContain("applied={appliedQuery}");
    expect(panel).toContain("draft={query}");
    const source = readFileSync(new URL("../src/components/FacetFilterPanel.tsx", import.meta.url), "utf8");
    expect(source).toContain("api.facetCounts");
    expect(source).toMatch(/loader\.load\(applied\)/);
  });

  test("keyboard steps on a range slider apply once the keys rest; a pointer release applies at once", () => {
    const source = readFileSync(new URL("../src/components/FacetFilterPanel.tsx", import.meta.url), "utf8");
    expect(source).toContain("onKeyDown={() => { keyboard.current = true; }}");
    expect(source).toContain("onPointerDown={() => { keyboard.current = false; }}");
    expect(source).toContain("if (keyboard.current) pendingCommit.current = setTimeout(apply, KEYBOARD_COMMIT_MS);");
  });

  test("counts refetch after a BPM change or a finished analysis under a bpm: filter", () => {
    const source = readFileSync(new URL("../src/components/FacetFilterPanel.tsx", import.meta.url), "utf8");
    expect(source).toContain("queryHasBpmFilter(applied) ? [BPM_UPDATED, ANALYSIS_FINISHED] : []");
  });
});
