import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToString } from "react-dom/server";
import { FacetEditor } from "../src/components/FacetEditor";
import { apiMessage, groupTags, tagDisplayName, tagQuery } from "../src/lib/facets";
import { parseQueryChips } from "../src/lib/queryChips";
import type { Facet, Tag } from "../src/lib/types";

const purpose: Facet = {
  id: 1, key: "purpose", label: "Θεραπευτικός στόχος", multi: true, sort_order: 0,
  values: [{ id: 11, value: "χαλάρωση", count: 2 }, { id: 12, value: "ύπνος", count: 0 }],
};
const voice: Facet = {
  id: 2, key: "voice", label: "Φωνή", multi: false, sort_order: 1,
  values: [{ id: 21, value: "οργανικό", count: 1 }, { id: 22, value: "φωνή χωρίς λόγια", count: 0 }],
};
const mood: Facet = { id: 3, key: "mood", label: "Διάθεση", multi: true, sort_order: 2, values: [] };

describe("facet tag names and queries", () => {
  test("tagDisplayName shows only the value part of a facet tag", () => {
    expect(tagDisplayName({ id: 1, name: "purpose:χαλάρωση", category: "purpose" })).toBe("χαλάρωση");
    expect(tagDisplayName({ id: 2, name: "my tag", category: null })).toBe("my tag");
    expect(tagDisplayName({ id: 3, name: "a:b", category: "x" })).toBe("a:b");
  });

  test("tagQuery builds a token the search grammar reads back", () => {
    expect(tagQuery({ id: 1, name: "purpose:χαλάρωση", category: "purpose" })).toBe('purpose:"χαλάρωση"');
    expect(tagQuery({ id: 2, name: "voice:φωνή χωρίς λόγια", category: "voice" })).toBe('voice:"φωνή χωρίς λόγια"');
    expect(tagQuery({ id: 3, name: "my tag", category: null })).toBe('"my tag"');
    expect(tagQuery({ id: 4, name: "ambient", category: null })).toBe("ambient");
  });

  test("groupTags puts facets first under their Greek label and uncategorised last", () => {
    const tags: Tag[] = [
      { id: 5, name: "loose", category: null },
      { id: 6, name: "rare", category: "other" },
      { id: 7, name: "purpose:χαλάρωση", category: "purpose" },
    ];
    const groups = groupTags(tags, [purpose, voice]);
    expect(groups[0]).toMatchObject({ key: "purpose", label: "Θεραπευτικός στόχος", facet: true });
    expect(groups[1]).toMatchObject({ key: "other", label: "other", facet: false });
    expect(groups.at(-1)).toMatchObject({ key: "", label: "Χωρίς κατηγορία", facet: false });
    expect(groups.at(-1)?.tags.map(t => t.id)).toEqual([5]);
  });

  test("apiMessage strips the HTTP status prefix", () => {
    expect(apiMessage(new Error("409: μήνυμα"))).toBe("μήνυμα");
    expect(apiMessage("409: μήνυμα")).toBe("μήνυμα");
  });
});

describe("FacetEditor", () => {
  test("single facets are radio groups, multi facets are toggle buttons, labels are Greek", () => {
    const html = renderToString(
      <FacetEditor facets={[purpose, voice]} selected={new Set([21, 11])} onToggle={() => {}} />,
    );
    expect(html).toContain('role="radiogroup"');
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>οργανικό</);
    expect(html).toMatch(/aria-pressed="true"[^>]*>χαλάρωση</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>ύπνος</);
    expect(html).toContain("Θεραπευτικός στόχος");
    expect(html).toContain("Φωνή");
    expect(html).not.toContain("purpose");
  });
});

describe("query chips with facets", () => {
  test("facet tokens show the facet label, never the key", () => {
    expect(parseQueryChips('purpose:"χαλάρωση" -mood:*', [purpose, mood]).map(c => c.label)).toEqual([
      "Θεραπευτικός στόχος: χαλάρωση",
      "όχι Διάθεση: οποιαδήποτε τιμή",
    ]);
  });

  test("every parseQueryChips call in Library and Crates passes the facets", () => {
    for (const page of ["Library", "Crates"]) {
      const source = readFileSync(new URL(`../src/pages/${page}.tsx`, import.meta.url), "utf8");
      const calls = [...source.matchAll(/parseQueryChips\(([^()]*(?:\([^()]*\))?[^()]*)\)/g)];
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect(call[1]).toContain(",");
    }
  });
});
