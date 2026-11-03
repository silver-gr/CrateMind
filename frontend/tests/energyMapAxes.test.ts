import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { energyMapAxes, energyMapTitle } from "../src/lib/energyMapAxes";
import { axisLabel } from "../src/lib/labels";

const BANDS: [number, number][] = [[1, 2], [3, 4], [5, 6], [7, 8], [9, 10]];
const HIGH_TO_LOW = [...BANDS].reverse();
const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

describe("energyMapAxes", () => {
  test("DJ cell queries for all 25 band pairs equal the old energy × darkness strings", () => {
    const axes = energyMapAxes("dj");
    expect(axes.cols.field).toBe("energy");
    expect(axes.rows.field).toBe("darkness");
    expect(axes.cols.bands).toEqual(BANDS);
    expect(axes.rows.bands).toEqual(HIGH_TO_LOW);
    for (const d of BANDS) {
      for (const e of BANDS) {
        expect(axes.cellQuery(e, d)).toBe(`energy:${e[0]}-${e[1]} darkness:${d[0]}-${d[1]}`);
      }
    }
  });

  test("therapy maps valence (cols) by arousal (rows, high to low)", () => {
    const axes = energyMapAxes("therapy");
    expect(axes.cols.field).toBe("valence");
    expect(axes.rows.field).toBe("energy");
    expect(axes.cols.bands).toEqual(BANDS);
    expect(axes.rows.bands).toEqual(HIGH_TO_LOW);
    expect(axes.cellQuery([3, 4], [9, 10])).toBe("valence:3-4 energy:9-10");
    for (const c of BANDS) {
      for (const r of BANDS) {
        expect(axes.cellQuery(c, r)).toBe(`valence:${c[0]}-${c[1]} energy:${r[0]}-${r[1]}`);
      }
    }
  });

  test("therapy labels come from axisLabel", () => {
    const axes = energyMapAxes("therapy");
    expect(axes.cols.label).toBe(axisLabel("valence", "therapy"));
    expect(axes.rows.label).toBe(axisLabel("energy", "therapy"));
    expect(axes.cols.legend).toBe("Συναισθηματικό σθένος →");
    expect(axes.rows.legend).toBe("Διέγερση ↑");
  });

  test("DJ keeps its legend copy; the page title follows the profile", () => {
    const axes = energyMapAxes("dj");
    expect(axes.cols.legend).toBe("← χαμηλή ένταση · υψηλή ένταση →");
    expect(axes.rows.legend).toBe("↑ βαθύ σκοτάδι");
    expect(energyMapTitle("dj")).toBe("Energy Maps");
    expect(energyMapTitle("therapy")).toBe("Χάρτης συναισθήματος");
  });
});

describe("EnergyMaps source contract", () => {
  const page = source("pages/EnergyMaps.tsx");

  test("useGSAP keeps { scope: containerRef } and no dependencies", () => {
    expect(page).toMatch(/useGSAP\(\s*\(\)\s*=>\s*\{[\s\S]*?\},[\s\S]*?\{\s*scope:\s*containerRef\s*\},?\s*\);/);
    expect(page).not.toMatch(/dependencies/);
  });

  test("therapy skips the role: count calls and keeps the 25 grid calls on cellQuery", () => {
    expect(page).toMatch(/therapy\s*\?\s*Promise\.resolve\(\[\]\)\s*:\s*Promise\.all\(\s*ROLES\.map/);
    expect(page).toMatch(/axes\.rows\.bands\.map\([\s\S]*?axes\.cols\.bands\.map\([\s\S]*?axes\.cellQuery\(/);
  });

  test("the sidebar takes the map's title from the profile", () => {
    expect(source("components/layout/Sidebar.tsx")).toContain("energyMapTitle(profile)");
  });
});
