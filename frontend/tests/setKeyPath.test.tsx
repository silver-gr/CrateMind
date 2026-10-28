import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import SetKeyPath from "../src/components/SetKeyPath";
import { KeyBadge } from "../src/components/ui/KeyBadge";
import { setKeyRuns } from "../src/lib/setStats";
import type { SetTrackRow } from "../src/lib/types";

test("key runs combine equivalent consecutive keys without bridging missing keys", () => {
  expect(setKeyRuns([
    { key_analyzed: "12B" }, { key_text: "E major" },
    {}, { key_analyzed: "12B" }, { key_text: "1A" },
  ])).toEqual([
    { code: "12B", start: 0, end: 1 }, { code: null, start: 2, end: 2 },
    { code: "12B", start: 3, end: 3 }, { code: "1A", start: 4, end: 4 },
  ]);
});

test("long key paths show bounded groups and human track numbers, not database ranks", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    position: 300000 + i, profile: null, note: null,
    track: { id: i, file_name: "fixture.wav", absolute_path: "/fixture.wav", play_count: 0,
      missing: false, key_analyzed: i % 2 ? "1A" : "12B" },
  })) as SetTrackRow[];
  const html = renderToString(<SetKeyPath rows={rows} onJump={() => {}} />);
  expect(html.match(/aria-label="Μετάβαση στο track/g)).toHaveLength(6);
  expect(html.replaceAll("<!-- -->", "")).toContain("#1");
  expect(html).not.toContain("300000");
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain("10 ομάδες");
});

test("key badges use the same hue for text, border and background", () => {
  const html = renderToString(<KeyBadge analyzed="~1A" />);
  expect(html).toContain(">1A</span>");
  expect(html.match(/0\.19 165/g)).toHaveLength(3);
  expect(renderToString(<KeyBadge />)).not.toContain("style=");
});
