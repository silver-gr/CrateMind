import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { renderToString } from "react-dom/server";
import * as virtual from "@tanstack/react-virtual";
import TrackTable from "../src/components/TrackTable";
import { preferenceStorage } from "../src/lib/preferenceStorage";
import { formatKey, keyColor } from "../src/lib/camelot";
import type { Track } from "../src/lib/types";

const fixture: Track = {
  id: 1, file_name: "fixture.wav", absolute_path: "/fixture.wav", extension: "wav",
  title: "Πολύ μεγάλο όνομα κομματιού για ένα στενό panel", artist: "Ένας καλλιτέχνης",
  play_count: 0, missing: false, bpm: 150, key_analyzed: "~Am",
};

afterEach(() => {
  virtualizerSpy?.mockRestore();
  storageSpy?.mockRestore();
});

let virtualizerSpy: ReturnType<typeof spyOn> | undefined;
let storageSpy: ReturnType<typeof spyOn> | undefined;

function render({ compact = true, play = true, add = true, addDisabled = false, tracks = [fixture], visibility = null as Record<string, boolean> | null } = {}) {
  // SSR does not measure a viewport; provide visible rows without changing the
  // table's sizing/column implementation or touching a real browser or library.
  virtualizerSpy = spyOn(virtual, "useVirtualizer").mockImplementation((options: any) => ({
    getTotalSize: () => options.count * options.estimateSize(),
    getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({
      index, size: options.estimateSize(), start: options.scrollMargin + index * options.estimateSize(),
    })),
    scrollToIndex: () => {},
  }) as any);
  storageSpy = spyOn(preferenceStorage, "getItem").mockImplementation(key => key === "cratemind:colw:v1"
    ? JSON.stringify({ "compact-track": 640, "compact-bpm": 640, "compact-key": 640, add: 640, bpm: 88 })
    : key === "cratemind:table:full:v2" && visibility
      ? JSON.stringify({ version: 2, widths: { bpm: 88 }, visibility }) : null);
  return renderToString(<TrackTable tracks={tracks} variant={compact ? "compact" : "full"}
    addDisabled={addDisabled} onSelect={() => {}} onPlay={play ? () => {} : undefined} onAdd={add ? () => {} : undefined}
    sortKey="key" sortDir="asc" onSort={() => {}} />);
}

describe("TrackTable candidate panel layout", () => {
  test("ignores oversized compact saved widths and shares a panel-fitting header/body grid", () => {
    const html = render();
    const grids = [...html.matchAll(/grid-template-columns:([^";]+)/g)].map(match => match[1]);
    expect(grids).toEqual(["28px minmax(0,1fr) 48px 52px 36px", "28px minmax(0,1fr) 48px 52px 36px"]);
    expect(html).not.toContain("640px");
    expect(html).not.toContain("min-width:");
    expect(html).not.toContain("overflow-x-auto");
    expect(html.match(/overflow-x-hidden/g)).toHaveLength(1);
    // One viewport owns the scrollbar and sticky header, so independent gutter
    // widths or horizontal offsets cannot move their column boundaries apart.
    expect(html.match(/\[scrollbar-gutter:stable\]/g)).toHaveLength(1);
    expect(html).toContain("sticky top-0");
    expect(html.indexOf('data-at-top="true"')).toBeLessThan(html.indexOf('role="columnheader"'));
    expect(html).not.toContain('role="separator"');
    // Fixed columns total 164px, leaving the title room even in a 240px panel
    // with a conventional 15px vertical scrollbar gutter.
    expect(240 - 15 - (28 + 48 + 52 + 36)).toBeGreaterThan(0);
    expect(html).toContain("height:40px");
  });

  test.each([[false, false, 3], [true, false, 4], [false, true, 4], [true, true, 5]])(
    "keeps optional play/add headers aligned: play=%s add=%s",
    (play, add, columns) => {
      const html = render({ play, add });
      expect(html.match(/role="columnheader"/g)).toHaveLength(columns);
      expect(html.match(/role="cell"/g)).toHaveLength(columns);
    },
  );

  test("preserves full table resizing/scrolling while locking its Add column at 36px", () => {
    const html = render({ compact: false });
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain('role="separator"');
    const grids = [...html.matchAll(/grid-template-columns:([^";]+)/g)].map(match => match[1]);
    expect(grids).toHaveLength(2);
    for (const grid of grids) {
      expect(grid).toContain("88px");
      expect(grid.endsWith("36px")).toBe(true);
      expect(grid).not.toContain("640px");
    }
    expect(html).toContain("height:46px");
    const headers = html.match(/<div[^>]*role="columnheader"[^>]*>.*?<\/div>/g) ?? [];
    const cells = html.match(/<div[^>]*role="cell"[^>]*>.*?<\/div>/g) ?? [];
    expect(headers.find(header => header.includes("Κατάσταση"))).toContain("justify-center text-center");
    expect(headers.find(header => header.includes("BPM"))).toContain("justify-start text-left");
    expect(cells.some(cell => cell.includes("ποτέ"))).toBe(false);
    expect(html).toContain("Μελωδία");
    expect(html).toContain("Ιδιορρυθμία");
    expect(headers).toHaveLength(cells.length);
  });

  test("explicit column choices keep full headers and cells aligned, including default-hidden columns", () => {
    const html = render({ compact: false, visibility: { genre: true, last: true, created: true, energy: false, role: false } });
    const headers = html.match(/role="columnheader"/g) ?? [];
    const cells = html.match(/role="cell"/g) ?? [];
    expect(headers).toHaveLength(cells.length);
    expect(html).toContain("Δημιουργήθηκε");
    expect(html).toContain("Τελευταίο");
    expect(html).toContain("Είδος");
    expect(html).not.toContain("Ενέργεια");
    expect(html).not.toContain("Ρόλος");
    expect([...html.matchAll(/grid-template-columns:([^";]+)/g)].map(match => match[1])[0])
      .toBe([...html.matchAll(/grid-template-columns:([^";]+)/g)].map(match => match[1])[1]);
  });

  test.each([true, false])("colors the circular Add button from its canonical key: compact=%s", compact => {
    const html = render({ compact });
    const button = html.match(/<button[^>]*aria-label="Προσθήκη στο set"[^>]*>.*?<\/button>/)?.[0] ?? "";
    expect(button).toContain(`--k:${keyColor(formatKey(fixture.key_text, fixture.key_analyzed))}`);
    expect(button).toContain("border-current/25");
    expect(button).toContain("bg-current/8");
    expect(button).toContain("hover:border-current/60");
    expect(button).toContain("rounded-full");
    expect(button).toContain('title="Προσθήκη στο set"');
    expect(button).not.toContain("προσθ.");
  });

  test("uses a cyan Add-button fallback when the key cannot be recognized", () => {
    const html = render({ tracks: [{ ...fixture, key_text: "unknown", key_analyzed: null }] });
    const button = html.match(/<button[^>]*aria-label="Προσθήκη στο set"[^>]*>/)?.[0] ?? "";
    expect(button).toContain("--k:var(--color-cm-cyan)");
  });

  test("pending additions keep the fixed action column and disable its button", () => {
    const html = render({ addDisabled: true });
    expect(html.match(/grid-template-columns:28px minmax\(0,1fr\) 48px 52px 36px/g)).toHaveLength(2);
    const button = html.match(/<button[^>]*aria-label="Προσθήκη στο set"[^>]*>/)?.[0] ?? "";
    expect(button).toContain('disabled=""');
  });

  test("retains the key-group divider independently of narrow columns", () => {
    const html = render({ tracks: [fixture, { ...fixture, id: 2, key_text: "2A" }] });
    expect(html.match(/data-key-group-end="true"/g)).toHaveLength(1);
  });
});
