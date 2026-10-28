import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import SetTimeline from "../src/components/SetTimeline";
import type { SetTrackRow } from "../src/lib/types";

const rows: SetTrackRow[] = [0, 1].map((position) => ({
  position,
  note: `Occurrence ${position}`,
  profile: null,
  track: {
    id: 7,
    file_name: "repeat.mp3",
    absolute_path: "/fixture/repeat.mp3",
    extension: ".mp3",
    title: "Repeated track",
    play_count: 0,
    missing: false,
  },
}));

function render(disabled = false, tracks = rows, playingTrackId: number | null = null) {
  const noop = () => {};
  return renderToString(
    <SetTimeline rows={tracks} pairNotes={{}} disabled={disabled} playingTrackId={playingTrackId}
      onReorder={noop} onMove={noop} onRemove={noop} onPlay={noop}
      onBridge={noop} onAddPairNote={noop} />,
  );
}

test("repeated track occurrences each render a touch-safe, focusable drag handle", () => {
  const html = render();
  const handles = html.match(/<button[^>]*aria-label="Αλλαγή θέσης:[^>]*>/g) ?? [];
  expect(handles).toHaveLength(2);
  for (const handle of handles) {
    expect(handle).toContain('touch-action:none');
    expect(handle).not.toContain('disabled=""');
  }
  expect(html.match(/aria-label="Μετακίνηση πάνω"/g)).toHaveLength(2);
  expect(html.match(/aria-label="Ακρόαση track"/g)).toHaveLength(2);
});

test("pending saves disable movement and removal while keeping playback available", () => {
  const buttons = render(true).match(/<button[^>]*>/g) ?? [];
  const mutations = buttons.filter((button) => /aria-label="(?:Αλλαγή θέσης:|Μετακίνηση|Αφαίρεση)/.test(button));
  expect(mutations).toHaveLength(8);
  for (const button of mutations) expect(button).toContain('disabled=""');
  const playback = buttons.filter((button) => button.includes('aria-label="Ακρόαση track"'));
  expect(playback).toHaveLength(2);
  for (const button of playback) expect(button).not.toContain('disabled=""');
});

test("an empty set retains the Greek empty state", () => {
  const html = render(false, []);
  expect(html).toContain("Άδειο set");
  expect(html).not.toContain('aria-label="Αλλαγή θέσης:');
});


test("only the audible track keeps the row tint and glowing play button", () => {
  const tracks = [rows[0], { ...rows[1], track: { ...rows[1].track, id: 8 } }];
  const html = render(false, tracks, 7);
  expect(html.match(/data-playing="true"/g)).toHaveLength(1);
  const playButtons = html.match(/<button[^>]*aria-label="Ακρόαση track"[^>]*>/g) ?? [];
  expect(playButtons[0]).toContain('data-playback-toggle="true"');
  expect(playButtons[0]).toContain('bg-cm-cyan/20 text-cm-cyan shadow-');
  expect(playButtons[1]).not.toContain('bg-cm-cyan/20 text-cm-cyan shadow-');
  expect(render(false, tracks)).not.toContain('data-playing="true"');
});
