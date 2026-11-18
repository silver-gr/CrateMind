import { afterEach, describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { api } from "../src/lib/api";
import { clearStructureCache, requestStructureSummaries, useStructureSummaries } from "../src/lib/trackStructureStore";
import { StructureStrip } from "../src/components/StructureStrip";
import { TooltipProvider } from "../src/components/ui/tooltip";
import type { StructureSection, StructureSummary } from "../src/lib/trackStructure";

const sections: StructureSection[] = [{ start_s: 0.2, beats: 128, bass: false, level: 0.3 }, { start_s: 51.4, beats: 256, bass: true, level: 1 }];
const original = api.getTrackStructures;
const settle = () => new Promise(resolve => setTimeout(resolve, 120));
afterEach(() => { api.getTrackStructures = original; clearStructureCache(); });

function Probe({ ids }: { ids: number[] }) {
  const map = useStructureSummaries(ids, false);
  return <span>{ids.map(id => (map.has(id) ? (map.get(id) ? "yes" : "none") : "?")).join(",")}</span>;
}

describe("structure summaries for the rows on screen", () => {
  test("a burst of rows is one request, and known tracks are not asked again", async () => {
    const calls: number[][] = [];
    api.getTrackStructures = async ids => { calls.push([...ids]); return { "1": { quality: 0.9, sections } } as Record<string, StructureSummary>; };
    requestStructureSummaries([1, 2]);
    requestStructureSummaries([2, 3]);
    await settle();
    expect(calls).toEqual([[1, 2, 3]]);
    expect(renderToString(<Probe ids={[1, 2, 4]} />)).toContain("yes,none,?");     // 2 has no structure; 4 was never asked
    requestStructureSummaries([1, 2, 3]);
    await settle();
    expect(calls.length).toBe(1);
  });
  test("more ids than the route takes go out in batches of 300", async () => {
    const sizes: number[] = [];
    api.getTrackStructures = async ids => { sizes.push(ids.length); return {}; };
    requestStructureSummaries(Array.from({ length: 650 }, (_, i) => i + 1));
    await settle();
    expect(sizes).toEqual([300, 300, 50]);
  });
  test("a failed request is not repeated on every scroll, and an analysis clears what is known", async () => {
    let calls = 0;
    api.getTrackStructures = async () => { calls += 1; throw new Error("offline"); };
    requestStructureSummaries([7]);
    await settle();
    requestStructureSummaries([7]);
    await settle();
    expect(calls).toBe(1);
    clearStructureCache();
    requestStructureSummaries([7]);
    await settle();
    expect(calls).toBe(2);
  });
});

describe("the structure strip of a list row", () => {
  test("one block per part, tall where the bass plays, and the summary as its label", () => {
    const html = renderToString(<TooltipProvider><StructureStrip sections={sections} duration={160} /></TooltipProvider>);
    expect(html).toContain('aria-label="Δομή: Εισαγωγή 32 bars · πρώτο μπάσο 0:51 · 0 breaks"');
    expect(html.match(/h-\[3px\]/g)?.length).toBe(1);
    expect(html.match(/h-full bg-cm-text\/40/g)?.length).toBe(1);
  });
});
