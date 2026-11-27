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

function render({ compact = true, play = true, add = true, addDisabled = false, tracks = [fixture], visibility = null as Record<string, boolean> | null,
  selectedId = undefined as number | undefined, selectedIds = undefined as Set<number> | undefined } = {}) {
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
    sortKey="key" sortDir="asc" onSort={() => {}} selectedId={selectedId}
    {...(selectedIds ? { selectedIds, onSelectionChange: () => {} } : {})} />);
}

describe("TrackTable candidate panel layout", () => {
  test("ignores oversized compact saved widths and shares a panel-fitting header/body grid", () => {
    const html = render();
    const grids = [...html.matchAll(/grid-template-columns:([^";]+)/g)].map(match => match[1]);
    // Play and add have no column: the track gets the row's width and the two buttons lie over BPM and Key.
    expect(grids).toEqual(["minmax(0,1fr) 48px 52px", "minmax(0,1fr) 48px 52px"]);
    expect(html).not.toContain("640px");
    expect(html).not.toContain("min-width:");
    expect(html).not.toContain("overflow-x-auto");
    expect(html.match(/overflow-x-hidden/g)).toHaveLength(1);
    // The compact header sits above the scroller (so the scroller can carry the scroll fade without fading or un-blurring a
    // sticky header): both reserve the same stable gutter, and the panel never scrolls sideways, so their columns line up.
    expect(html.match(/\[scrollbar-gutter:stable\]/g)).toHaveLength(2);
    expect(html).toContain("shrink-0 overflow-y-hidden [scrollbar-gutter:stable]");
    expect(html).not.toContain("sticky top-0");
    expect(html).toContain("scroll-fade-y overflow-x-hidden");
    expect(html.indexOf('role="columnheader"')).toBeLessThan(html.indexOf("scroll-fade-y"));
    expect(html).not.toContain('role="separator"');
    // Fixed columns total 100px, leaving the title room even in a 240px panel
    // with a conventional 15px vertical scrollbar gutter.
    expect(240 - 15 - (48 + 52)).toBeGreaterThan(0);
    expect(html).toContain("height:40px");
  });

  test.each([[false, false], [true, false], [false, true], [true, true]])(
    "play and add take no column: three headers, and one overlay cell over BPM and Key when either exists: play=%s add=%s",
    (play, add) => {
      const html = render({ play, add });
      expect(html.match(/role="columnheader"/g)).toHaveLength(3);
      expect(html.match(/role="cell"/g)).toHaveLength(play || add ? 4 : 3);
      expect(html.includes("data-row-actions")).toBe(play || add);
      expect(html.includes('aria-label="Ακρόαση track"')).toBe(play);
      expect(html.includes('aria-label="Προσθήκη στο set"')).toBe(add);
    },
  );

  test("the overlay shows on hover, selection or keyboard focus, and BPM and Key fade out under it", () => {
    const idle = render();
    expect(idle).toContain("pointer-events-none opacity-0 group-hover/row:pointer-events-auto group-hover/row:opacity-100");
    expect(idle).toContain("focus-within:pointer-events-auto focus-within:opacity-100");
    expect(idle.match(/group-hover\/row:opacity-0/g)).toHaveLength(2); // the BPM and the Key cell
  });

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
    // One cell more than the headers: the row's tick box and play button, an overlay with no column.
    expect(cells.filter(cell => !cell.includes("data-row-lead"))).toHaveLength(headers.length);
    expect(cells.filter(cell => cell.includes("data-row-lead"))).toHaveLength(1);
  });

  test("explicit column choices keep full headers and cells aligned, including default-hidden columns", () => {
    const html = render({ compact: false, visibility: { genre: true, last: true, created: true, energy: false, role: false } });
    const headers = html.match(/role="columnheader"/g) ?? [];
    const cells = html.match(/role="cell"/g) ?? [];
    expect(cells).toHaveLength(headers.length + 1); // plus the overlay with the play button
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

  test("pending additions keep the add button in place and disable it", () => {
    const html = render({ addDisabled: true });
    expect(html.match(/grid-template-columns:minmax\(0,1fr\) 48px 52px/g)).toHaveLength(2);
    const button = html.match(/<button[^>]*aria-label="Προσθήκη στο set"[^>]*>/)?.[0] ?? "";
    expect(button).toContain('disabled=""');
  });

  test("retains the key-group divider independently of narrow columns", () => {
    const html = render({ tracks: [fixture, { ...fixture, id: 2, key_text: "2A" }] });
    expect(html.match(/data-key-group-end="true"/g)).toHaveLength(1);
  });

  test("checked, inspector-selected and both get distinct row styles; the left bar stays when both", () => {
    const tracks = [fixture, { ...fixture, id: 2 }, { ...fixture, id: 3 }, { ...fixture, id: 4 }];
    const html = render({ compact: false, tracks, selectedId: 1, selectedIds: new Set([1, 2]) });
    const rows = [...html.matchAll(/<div[^>]*role="row"[^>]*class="([^"]*group\/row[^"]*)"/g)].map(m => m[1]);
    const bar = "inset_2px_0_0_var(--color-cm-cyan)";
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain("bg-cm-cyan/[0.18]");   // both
    expect(rows[0]).toContain(bar);
    expect(rows[1]).toContain("bg-cm-cyan/[0.07]");   // checked only
    expect(rows[1]).not.toContain(bar);
    expect(rows[1]).toContain("border-cm-cyan/10");   // a run of checked rows reads as one block
    expect(rows[3]).toContain("bg-cm-contrast/[0.025]"); // zebra untouched
    expect(rows[2]).not.toContain("bg-cm-cyan");
  });
});
