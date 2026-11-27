import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { filterGlossary, GLOSSARY_ALL as GLOSSARY } from "../src/lib/glossary";
import { GLOSSARY_RAIL_MIN_TOTAL, GLOSSARY_RAIL_WIDTH, glossaryRailed, termInView } from "../src/lib/glossaryContents";

const cards = [{ id: "db", top: -400 }, { id: "peak", top: -20 }, { id: "clipping", top: 90 }, { id: "headroom", top: 600 }];

describe("the glossary's contents", () => {
  test("the term in view is the last card that reached the line under the header", () => {
    expect(termInView(cards, 100, false)).toBe("clipping");
    expect(termInView(cards, 80, false)).toBe("peak");
    expect(termInView(cards.map(c => ({ ...c, top: c.top + 1000 })), 100, false)).toBe("db");
    expect(termInView([], 100, false)).toBeNull();
  });

  test("at the page's end: the term just opened while its card shows, else the last card", () => {
    expect(termInView(cards, 100, true)).toBe("headroom");
    expect(termInView(cards, 100, true, "clipping")).toBe("clipping");
    expect(termInView(cards, 100, true, "db")).toBe("headroom"); // scrolled away above
    expect(termInView(cards, 100, true, "missing")).toBe("headroom");
  });

  test("the panel goes to the rail when page and panel fit together, with the same switch point both ways", () => {
    expect(glossaryRailed(GLOSSARY_RAIL_MIN_TOTAL, false)).toBe(true);
    expect(glossaryRailed(GLOSSARY_RAIL_MIN_TOTAL - 1, false)).toBe(false);
    // Railed, the page is narrower by the panel's width; it stays railed until the total drops below the same point.
    expect(glossaryRailed(GLOSSARY_RAIL_MIN_TOTAL - GLOSSARY_RAIL_WIDTH, true)).toBe(true);
    expect(glossaryRailed(GLOSSARY_RAIL_MIN_TOTAL - GLOSSARY_RAIL_WIDTH - 1, true)).toBe(false);
  });

  test("the filter narrows contents and cards alike, without accents or case", () => {
    expect(filterGlossary(GLOSSARY, "ΜΠΑΣΑ").length).toBeGreaterThan(0);
    expect(filterGlossary(GLOSSARY, "μπάσα").map(t => t.id)).toEqual(filterGlossary(GLOSSARY, "ΜΠΑΣΑ").map(t => t.id));
    expect(filterGlossary(GLOSSARY, "Clipping").map(t => t.id)).toContain("clipping");
  });

  test("the page: one filter state for panel and cards, a named nav of links, the panel in the shell's rail", () => {
    const page = readFileSync(new URL("../src/pages/Glossary.tsx", import.meta.url), "utf8");
    expect(page).toContain("<PageRail>");
    expect(page).toContain('aria-label="Περιεχόμενα λεξικού"');
    expect(page).toContain('aria-current={t.id === active ? "location" : undefined}');
    expect(page.match(/const terms = filterGlossary\(GLOSSARY, query\)/g)).toHaveLength(1);
    // A card opened from a link lands under the sticky header, measured, not a fixed scroll margin.
    expect(page).toContain("- headerBottom() - LANDING_GAP");
  });
});
