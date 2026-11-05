import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import SetTimeline from "../src/components/SetTimeline";
import type { SetTrackRow } from "../src/lib/types";
import { describeAuto } from "../src/lib/transitions/copy";
import { pairKey, type SetTransition } from "../src/lib/transitions/types";

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

test("timeline selection has its own keyboard control and does not mark paused tracks as playing", () => {
  const noop = () => {};
  const tracks = [rows[0], { ...rows[1], track: { ...rows[1].track, id: 8 } }];
  const html = renderToString(<SetTimeline rows={tracks} pairNotes={{}} selectedTrackId={7} onSelect={noop}
    onReorder={noop} onMove={noop} onRemove={noop} onPlay={noop} onBridge={noop} onAddPairNote={noop} />);
  const selectionButtons = html.match(/<button[^>]*aria-label="Επιλογή track:[^>]*>/g) ?? [];
  expect(selectionButtons).toHaveLength(2);
  expect(selectionButtons[0]).toContain('aria-pressed="true"');
  expect(selectionButtons[1]).toContain('aria-pressed="false"');
  expect(html.match(/data-selected="true"/g)).toHaveLength(1);
  expect(html).not.toContain('data-playing="true"');
});

test("the selected row gets the candidates-list look (cyan wash, inset bar) and unselected rows keep the quiet border", () => {
  const noop = () => {};
  const tracks = [rows[0], { ...rows[1], track: { ...rows[1].track, id: 8 } }];
  const html = renderToString(<SetTimeline rows={tracks} pairNotes={{}} selectedTrackId={8} onSelect={noop}
    onReorder={noop} onMove={noop} onRemove={noop} onPlay={noop} onBridge={noop} onAddPairNote={noop} />);
  const [first, second] = html.match(/<div[^>]*data-set-position="\d"[^>]*>/g) ?? [];
  expect(second).toContain("bg-cm-cyan/12");
  expect(second).toContain("shadow-[inset_2px_0_0_var(--color-cm-cyan)]");
  expect(second).not.toContain("border-black/10");
  expect(first).not.toContain("bg-cm-cyan/12");
  expect(first).toContain("border-black/10");
});

// ---- transition pill (set transitions, Task 9) ----------------------------

const pair = [rows[0], { ...rows[1], track: { ...rows[1].track, id: 8 } }];

function transition(over: Partial<SetTransition> = {}): SetTransition {
  return {
    id: null, set_id: 1, from_track_id: 7, to_track_id: 8, persisted: false,
    preset: "auto", resolved_preset: "blend", bars: 8, volume_curve: "overlap", eq_curve: "three_band",
    filter_curve: "none", loop_beats: null, out_anchor_s: null, in_anchor_s: null, tempo_match: true,
    reasons: [], updated_at: null, ...over,
  };
}

function renderPills(t: SetTransition | null, mixable: Record<number, boolean> = { 7: true, 8: true }) {
  const noop = () => {};
  return renderToString(
    <SetTimeline rows={pair} pairNotes={{}} onReorder={noop} onMove={noop} onRemove={noop} onPlay={noop}
      onBridge={noop} onAddPairNote={noop}
      transitions={t ? { [pairKey(t.from_track_id, t.to_track_id)]: t } : {}} mixable={mixable}
      onEditTransition={noop} onPreviewTransition={noop} />,
  );
}

const pillOf = (html: string) => html.match(/<button[^>]*data-transition-pill[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";
/** Visible text plus the title/aria-label attributes: where a raw key would leak to the user. */
const userFacing = (html: string) => [html.replace(/<[^>]*>/g, ""), ...(html.match(/(?:title|aria-label)="[^"]*"/g) ?? [])].join(" ");
const previewOf = (html: string) => html.match(/<button[^>]*aria-label="Προεπισκόπηση μετάβασης"[^>]*>/)?.[0] ?? "";

test("a persisted named preset shows its Greek name on the pill", () => {
  const html = renderPills(transition({ persisted: true, id: 3, preset: "blend", resolved_preset: null }));
  const pill = pillOf(html);
  expect(pill).toContain("Ανάμειξη");
  expect(pill).not.toContain("Αυτόματο");
  expect(pill).toContain('title="Αποθηκευμένη μετάβαση"');
  expect(pill).toContain('aria-label="Επεξεργασία μετάβασης: Ανάμειξη"');
  expect(userFacing(pill)).not.toContain("blend");
});

test("an Auto row shows the resolved preset and explains the choice in its title", () => {
  const html = renderPills(transition({ resolved_preset: "slam", bars: 1, reasons: ["bpm_out_of_range", "key_clash"] }));
  const pill = pillOf(html);
  expect(pill).toContain("Αυτόματο · Κόψιμο");
  expect(pill).toContain(`title="${describeAuto(["bpm_out_of_range", "key_clash"])}"`);
  expect(pill).toContain("BPM εκτός εύρους pitch");
  expect(userFacing(pill)).not.toContain("bpm_out_of_range");
  expect(userFacing(pill)).not.toContain("slam");
});

test("a pair with an unmixable track shows «χωρίς μίξη» in rose and disables the preview", () => {
  for (const mixable of [{ 7: false, 8: true }, { 7: true, 8: false }]) {
    const html = renderPills(transition(), mixable);
    const pill = pillOf(html);
    expect(pill).toContain("χωρίς μίξη");
    expect(pill).toContain("text-cm-rose");
    expect(pill).toContain("lucide-ban");
    expect(previewOf(html)).toContain('disabled=""');
  }
  const mixed = renderPills(transition());
  expect(pillOf(mixed)).not.toContain("χωρίς μίξη");
  expect(previewOf(mixed)).not.toContain('disabled=""');
});

test("the preview button is labelled and revealed on keyboard focus and on touch screens", () => {
  const preview = previewOf(renderPills(transition()));
  expect(preview).toContain('aria-label="Προεπισκόπηση μετάβασης"');
  expect(preview).toContain("focus-visible:opacity-100");
  expect(preview).toContain("[@media(hover:none)]:opacity-100");
});

test("the pill is the first chip of the connector row", () => {
  const html = renderPills(transition());
  const connector = html.slice(html.indexOf("data-set-connector"));
  expect(connector.indexOf("data-transition-pill")).toBeGreaterThan(-1);
  expect(connector.indexOf("data-transition-pill")).toBeLessThan(connector.indexOf("γέφυρα"));
});

test("without transitions the connector renders no pill and does not crash", () => {
  const html = render(false, pair);
  expect(html).not.toContain("data-transition-pill");
  expect(html).not.toContain("Προεπισκόπηση μετάβασης");
  expect(html).toContain("γέφυρα");
  expect(renderPills(null)).not.toContain("data-transition-pill");
});
