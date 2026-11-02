import { describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';
import { DeckHeader } from '../src/components/DeckHeader';
import type { Track, TrackCue } from '../src/lib/types';

const track: Track = { id: 503, absolute_path: '/synthetic/track.wav', file_name: 'track.wav', extension: 'wav', title: 'Συνθετικό', missing: false, play_count: 0 };
const cue: TrackCue = { id: 1, track_id: track.id, position_ms: 30_000, kind: 'cue', label: null, created_at: '', updated_at: '' };
const render = (canSeek = true, duration = 120, time = 30) => renderToString(<DeckHeader deck="A" track={track} bpm={150} bpmText="150 BPM" keyFormat="camelot"
  time={time} duration={duration} progress={.25} drawRef={{ current: null }} playheadRef={{ current: null }} canSeek={canSeek} onSeek={() => {}} cues={[cue]} cueSlots={[1, null, null, null, null, null, null, null]} />);

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
