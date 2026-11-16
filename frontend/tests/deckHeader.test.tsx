import { describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';
import { DeckHeader } from '../src/components/DeckHeader';
import type { Track, TrackCue } from '../src/lib/types';

const track: Track = { id: 503, absolute_path: '/synthetic/track.wav', file_name: 'track.wav', extension: 'wav', title: 'Συνθετικό', missing: false, play_count: 0 };
const cue: TrackCue = { id: 1, track_id: track.id, position_ms: 30_000, kind: 'cue', label: null, created_at: '', updated_at: '' };
const render = (canSeek = true, duration = 120, time = 30, mirrored = false) => renderToString(<DeckHeader deck="A" mirrored={mirrored} playing track={track}
  time={time} duration={duration} progress={.25} drawRef={{ current: null }} playheadRef={{ current: null }} canSeek={canSeek} onSeek={() => {}} cues={[cue]} cueSlots={[1, null, null, null, null, null, null, null]} coverSize={150} />);

describe('deck overview controls', () => {
  test('renders an accessible seek surface above the noninteractive waveform', () => {
    const html = render();
    const slider = html.match(/<input[^>]+type="range"[^>]*>/)?.[0] ?? '';
    expect(slider).toContain('data-playback-shortcuts');
    expect(slider).toContain('aria-label="Μετακίνηση στο track, Deck A"');
    expect(slider).toContain('max="120"'); expect(slider).toContain('value="30"');
    expect(slider).toContain('z-20'); expect(slider).toContain('touch-none');
    expect(slider).toContain('cm-overview-seek');
    expect(slider).not.toContain('disabled=""');
    expect(html).toContain('focus-within:ring-1');
  });
  test('disables seeking without metadata or finite positive duration', () => {
    for (const html of [render(false), render(true, 0), render(true, NaN), render(true, Infinity)]) {
      expect(html.match(/<input[^>]+type="range"[^>]*>/)?.[0]).toContain('disabled=""');
    }
    expect(render(true, 120, 150)).toContain('value="120"');
  });
  test('compact cue flags retain cue numbering, labels and foreground hit targets', () => {
    const html = render();
    expect(html).toContain('data-cue-id="1"'); expect(html).toContain('data-cue-number="1"');
    expect(html).toContain('aria-label="Μετάβαση: 1'); expect(html).toContain('z-30');
    expect(html).toContain('clip-path:polygon');
  });
});

describe('deck info block', () => {
  test('marks its deck, dims the played part and uses the shared playhead colour', () => {
    const html = render();
    expect(html).toContain('data-deck-info="A"');
    expect(html).toContain('right-full');
    expect(html).toContain('bg-[var(--cm-playhead)]');
    expect(html).toContain('relative max-h-28 min-h-5 flex-1 rounded-md'); // the small overview: at most 112px tall
    expect(html).toContain('h-full'); // the columns share the pads' top and bottom edges
  });
  test('the cover column holds a large artwork with a sliding title, and gives way on a narrow deck', () => {
    const html = render();
    const cover = html.slice(html.indexOf('data-deck-cover="A"'));
    expect(cover).toContain('width:clamp(64px, 20cqw - 36px, 150px)');
    expect(cover).toContain('@max-[540px]/player:hidden');
    expect(cover).toMatch(/class="@container overflow-hidden[^"]*" title="Συνθετικό"><span class="cm-marquee">Συνθετικό<\/span>/);
    expect(html).toContain('hidden min-w-0 shrink-0 truncate text-xs font-semibold leading-none text-cm-text @max-[540px]/player:block'); // the narrow deck's title line
  });
  test('the remaining time turns rose in the last 30 seconds', () => {
    expect(render(true, 120, 100)).toContain('text-cm-rose');
    expect(render(true, 120, 30)).not.toContain('text-cm-rose');
  });
  const row = (mirrored: boolean) => renderToString(<DeckHeader deck="B" mirrored={mirrored} track={track} time={0} duration={120} progress={0} coverSize={150}
    drawRef={{ current: null }} playheadRef={{ current: null }} canSeek onSeek={() => {}} transport={<button type="button">SYNC</button>} tempo={<b>140 BPM</b>} />);
  test('elapsed time and transport sit above the overview; the remaining time and the tempo below it', () => {
    const html = row(false);
    const time = html.indexOf('aria-label="Χρόνος αναπαραγωγής"'), sync = html.indexOf('<button type="button">SYNC'), wave = html.indexOf('data-player-waveform'),
      left = html.indexOf('aria-label="Υπόλοιπο χρόνου"'), tempo = html.indexOf('<b>140 BPM');
    expect(time).toBeGreaterThan(-1);
    expect(time).toBeLessThan(sync); expect(sync).toBeLessThan(wave); expect(wave).toBeLessThan(left); expect(left).toBeLessThan(tempo);
    expect(html).toContain('class="flex h-8 min-w-0 shrink-0 items-center justify-between gap-2"');
    expect(render()).toContain('aria-label="Υπόλοιπο χρόνου"'); // the countdown row stays without a tempo
  });
  test('the elapsed time counts up while the countdown counts down', () => {
    const html = render(true, 125, 65.6);
    expect(html).toMatch(/aria-label="Χρόνος αναπαραγωγής"[^>]*>1:05</);
    expect(html).toMatch(/aria-label="Υπόλοιπο χρόνου"[^>]*>-0:59</);
  });
  test('deck B mirrors: the columns swap and each row is reversed', () => {
    const plain = row(false), flipped = row(true);
    expect(plain).toMatch(/data-deck-info="B" class="[^"]* order-2"/); expect(plain).toMatch(/data-deck-cover="B" style="[^"]*" class="[^"]* order-3"/);
    expect(flipped).toMatch(/data-deck-info="B" class="[^"]* order-3"/); expect(flipped).toMatch(/data-deck-cover="B" style="[^"]*" class="[^"]* order-2"/);
    expect(flipped).toContain('items-center justify-between gap-2 flex-row-reverse');
    expect(plain).not.toContain('flex-row-reverse');
  });
});
