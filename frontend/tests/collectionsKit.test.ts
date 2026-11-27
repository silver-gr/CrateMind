import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fmt, fmtDate, serviceLabel } from "../src/components/collections/kit";
import { relationshipLabels } from "../src/lib/collectionLabels";

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

describe("Collections screens", () => {
  test("counts use Greek thousands separators", () => {
    expect(fmt(19954)).toBe("19.954");
    expect(fmt(1892)).toBe("1.892");
    expect(fmt(null)).toBe("0");
  });

  test("provider keys and relationship keys never reach the screen raw", () => {
    expect(serviceLabel("soundcloud")).toBe("SoundCloud");
    expect(serviceLabel("mystery")).toBe("Πηγή");
    expect(relationshipLabels(["owned", "private"])).toBe("Δική σας · Ιδιωτική");
    expect(relationshipLabels(["not_a_known_key"])).toBe("");
  });

  test("ISO dates are shown in Greek; other text passes through", () => {
    expect(fmtDate("2024-10-08T07:33:56Z")).toMatch(/2024/);
    expect(fmtDate("2024-10-08T07:33:56Z")).not.toContain("T07");
    expect(fmtDate("άγνωστο")).toBe("άγνωστο");
  });

  test("every Collections screen uses the shared shell and no raw palette colours", () => {
    for (const page of ["Collections", "CollectionProvenance", "Recovery", "CanonicalMetadata", "UnifiedLibrary"]) {
      const text = source(`pages/${page}.tsx`);
      expect(text).toContain("<div className={PAGE}>");
      expect(text).not.toMatch(/text-(cyan|rose|amber|emerald|red|pink)-\d00/);
      expect(text).not.toContain("toLocaleString(");
    }
  });

  test("the track table header can blur because its scroller has no fade mask", () => {
    const table = source("components/TrackTable.tsx");
    // The full table's header is sticky glass inside an unmasked scroller; only the compact table, whose header sits above
    // its scroller, fades.
    expect(table).toContain('"sticky top-0 z-20 border-b border-cm-contrast/10 backdrop-blur-xl"');
    expect(table).toContain('compact ? "scroll-fade-y overflow-x-hidden" : "overflow-x-auto"');
    expect(table.match(/scroll-fade-y/g)).toHaveLength(1);
  });
});
