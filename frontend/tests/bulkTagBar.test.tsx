import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToString } from "react-dom/server";
import { BulkTagBar } from "../src/components/BulkTagBar";
import { preferenceStorage } from "../src/lib/preferenceStorage";
import { bulkFacets, changeSummary, keepOnePerSingleFacet } from "../src/lib/selection";
import type { Facet } from "../src/lib/types";

describe("bulk bar accessibility", () => {
  let storageSpy: ReturnType<typeof spyOn> | undefined;
  afterEach(() => storageSpy?.mockRestore());

  test("the bar is a named group and its scope and mode chips expose aria-pressed", () => {
    storageSpy = spyOn(preferenceStorage, "getItem").mockImplementation(() => null);
    const html = renderToString(<BulkTagBar selectedIds={new Set([1, 2])} query="" onApplied={() => {}} />);
    expect(html).toMatch(/role="group"[^>]*aria-label="Μαζική αλλαγή"|aria-label="Μαζική αλλαγή"[^>]*role="group"/);
    const chip = (label: string) => html.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}`))?.[0] ?? "";
    expect(chip("Επιλεγμένα")).toContain('aria-pressed="true"');
    expect(chip("Όλα τα αποτελέσματα")).toContain('aria-pressed="false"');
    expect(chip("Προσθήκη τιμών")).toContain('aria-pressed="true"');
    expect(chip("Αφαίρεση τιμών")).toContain('aria-pressed="false"');
  });

  test("the confirmation names the mode, the values and the axes", () => {
    expect(changeSummary("add", ["χαλάρωση", "ύπνος"], [])).toBe("Προσθήκη: χαλάρωση, ύπνος.");
    expect(changeSummary("remove", ["χαλάρωση"], [["Διέγερση", 3]])).toBe("Αφαίρεση: χαλάρωση. Διέγερση: 3.");
    expect(changeSummary("remove", [], [["Διέγερση", 3], ["Συναισθηματικό σθένος", 7]])).toBe("Διέγερση: 3. Συναισθηματικό σθένος: 7.");
  });
});

describe("bulk remove mode and single-value vocabularies", () => {
  const voice: Facet = {
    id: 2, key: "voice", label: "Φωνή", multi: false, sort_order: 0,
    values: [{ id: 21, value: "οργανικό", count: 1 }, { id: 22, value: "με στίχους", count: 1 }],
  };
  const purpose: Facet = { id: 1, key: "purpose", label: "Σκοπός", multi: true, sort_order: 1, values: [{ id: 11, value: "χαλάρωση", count: 1 }, { id: 12, value: "ύπνος", count: 1 }] };

  test("remove mode edits every vocabulary as multi-select, so no radio group holds two checked radios", () => {
    expect(bulkFacets([voice, purpose], "remove").every(f => f.multi)).toBe(true);
    expect(bulkFacets([voice, purpose], "add").map(f => f.multi)).toEqual([false, true]);
  });

  test("switching to add keeps one value per single-value vocabulary", () => {
    expect([...keepOnePerSingleFacet(new Set([22, 21, 11, 12]), [voice, purpose])].sort()).toEqual([11, 12, 21]);
    expect([...keepOnePerSingleFacet(new Set([22]), [voice, purpose])]).toEqual([22]);
  });

  test("the bar edits with bulkFacets and prunes on the switch to add", () => {
    const source = readFileSync(new URL("../src/components/BulkTagBar.tsx", import.meta.url), "utf8");
    expect(source.includes("facets={bulkFacets(facets, mode)}")).toBe(true);
    expect(source.includes("keepOnePerSingleFacet(current, facets)")).toBe(true);
    expect(source.includes('setMode("add")')).toBe(false);
  });
});
