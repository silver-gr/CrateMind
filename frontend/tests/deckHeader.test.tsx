import { afterEach, describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';
import { DeckHeader, DeckOverview } from '../src/components/DeckHeader';
import { FxRackPanel, fxPresetFilter } from '../src/components/FxRackPicker';
import { Knob, knobArc } from '../src/components/ui/Knob';
import { engage, release, resetFxRack, selectPreset, setAvailable, setNodeState } from '../src/lib/fxRack';
import type { Track, TrackCue } from '../src/lib/types';

const track: Track = { id: 503, absolute_path: '/synthetic/track.wav', file_name: 'track.wav', extension: 'wav', title: 'Συνθετικό', missing: false, play_count: 0 };
const cue: TrackCue = { id: 1, track_id: track.id, position_ms: 30_000, kind: 'cue', label: null, created_at: '', updated_at: '' };
const render = (duration = 120, time = 30, mirrored = false) => renderToString(<DeckHeader deck="A" mirrored={mirrored} playing track={track}
  time={time} duration={duration} coverSize={150} />);
// The overview left the dock for the facts row under the waveforms (deck layout stage 2); MiniPlayer renders it there.
const overview = (canSeek = true, duration = 120, time = 30) => renderToString(<DeckOverview deck="A" track={track} className="h-[26px] w-full shrink-0"
  time={time} duration={duration} progress={.25} drawRef={{ current: null }} playheadRef={{ current: null }} canSeek={canSeek} onSeek={() => {}} cues={[cue]} cueSlots={[1, null, null, null, null, null, null, null]} />);

describe('deck overview controls', () => {
  test('renders an accessible seek surface above the noninteractive waveform', () => {
    const html = overview();
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
    for (const html of [overview(false), overview(true, 0), overview(true, NaN), overview(true, Infinity)]) {
      expect(html.match(/<input[^>]+type="range"[^>]*>/)?.[0]).toContain('disabled=""');
    }
    expect(overview(true, 120, 150)).toContain('value="120"');
  });
  test('compact cue flags retain cue numbering, labels and foreground hit targets', () => {
    const html = overview();
    expect(html).toContain('data-cue-id="1"'); expect(html).toContain('data-cue-number="1"');
    expect(html).toContain('aria-label="Μετάβαση: 1'); expect(html).toContain('z-30');
    expect(html).toContain('clip-path:polygon');
  });
  test('it is the wide, short strip of the facts row: the played part dimmed, the shared playhead colour, flags cut to its top edge', () => {
    const html = overview();
    expect(html).toMatch(/data-player-waveform="true" class="relative rounded-\[4px\][^"]*h-\[26px\] w-full shrink-0"/);
    expect(html).toContain('right-full');
    expect(html).toContain('bg-[var(--cm-playhead)]');
    expect(html).toContain('[&amp;_[data-player-cues]]:h-3'); // most of the 26 px still seeks under the flags
  });
});

describe('deck info block', () => {
  test('marks its deck and holds no overview: that lives in the facts row', () => {
    const html = render();
    expect(html).toContain('data-deck-info="A"');
    expect(html).not.toContain('data-player-waveform');
    expect(html).not.toContain('type="range"');
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
    expect(render(120, 100)).toContain('text-cm-rose');
    expect(render(120, 30)).not.toContain('text-cm-rose');
  });
  const row = (mirrored: boolean) => renderToString(<DeckHeader deck="B" mirrored={mirrored} track={track} time={0} duration={120} coverSize={150}
    transport={<button type="button">SYNC</button>} status={<b>φόρτωση</b>} />);
  test('the time left leads, large, with the elapsed time and the status under it, beside the transport; there is no tempo row', () => {
    const html = row(false);
    const left = html.indexOf('aria-label="Υπόλοιπο χρόνου"'), time = html.indexOf('aria-label="Χρόνος αναπαραγωγής"'),
      status = html.indexOf('<b>φόρτωση'), sync = html.indexOf('<button type="button">SYNC');
    expect(left).toBeGreaterThan(-1);
    expect(left).toBeLessThan(time); expect(time).toBeLessThan(status); expect(status).toBeLessThan(sync);
    expect(html).toMatch(/aria-label="Υπόλοιπο χρόνου" class="[^"]*text-2xl font-bold/);
    expect(html).toMatch(/aria-label="Χρόνος αναπαραγωγής" class="[^"]*text-sm font-semibold[^"]*text-cm-muted/);
    // 24 px time left + 2 px + a 14 px elapsed line fill the 40 px row; BPM and key live in the facts row.
    expect(html).toContain('class="flex h-10 min-w-0 shrink-0 items-center gap-2 @max-[215px]/deckinfo:gap-1.5"');
    expect(html).toContain('class="flex h-3.5 items-center gap-1.5"');
    expect(html).not.toContain('h-8 min-w-0 shrink-0 items-center justify-between');
    expect(render()).toContain('aria-label="Χρόνος αναπαραγωγής"'); // the elapsed time stays without a status
  });
  test('the info column is 248 px, shrinking to 150 px only on a narrow deck', () => {
    expect(render()).toContain('min-w-[150px] flex-[0_1_248px]');
  });
  test('the elapsed time counts up while the countdown counts down', () => {
    const html = render(125, 65.6);
    expect(html).toMatch(/aria-label="Χρόνος αναπαραγωγής"[^>]*>1:05</);
    expect(html).toMatch(/aria-label="Υπόλοιπο χρόνου"[^>]*>-0:59</);
  });
  test('deck B mirrors: the columns swap and each row is reversed', () => {
    const plain = row(false), flipped = row(true);
    expect(plain).toMatch(/data-deck-info="B" class="[^"]* order-2"/); expect(plain).toMatch(/data-deck-cover="B" style="[^"]*" class="[^"]* order-3"/);
    expect(flipped).toMatch(/data-deck-info="B" class="[^"]* order-3"/); expect(flipped).toMatch(/data-deck-cover="B" style="[^"]*" class="[^"]* order-2"/);
    expect(flipped).toContain('items-center gap-2 @max-[215px]/deckinfo:gap-1.5 flex-row-reverse');
    expect(flipped).toContain('class="flex shrink-0 flex-col gap-0.5 items-end"');
    expect(plain).not.toContain('flex-row-reverse');
  });
});

describe('deck FX row', () => {
  afterEach(resetFxRack);
  const fx = (mirrored = false, bpm: number | null = 145) => renderToString(<DeckHeader deck="B" mirrored={mirrored} track={{ ...track, bpm }} time={0} duration={120}
    coverSize={150} />);
  const button = (html: string) => html.match(/<button[^>]+aria-label="Εφέ, Deck B"[^>]*>/)?.[0] ?? '';

  test('sits under the time row: the picker on a line of its own, then FX, BEATS and WET; the second line is reversed only when mirrored', () => {
    const plain = fx(false), flipped = fx(true);
    expect(plain.indexOf('aria-label="Εφέ Deck B"')).toBeGreaterThan(plain.indexOf('aria-label="Χρόνος αναπαραγωγής"'));
    expect(plain).toContain('role="group" aria-label="Εφέ Deck B" class="flex min-w-0 shrink-0 flex-col gap-2"><div class="flex h-8 min-w-0 items-center"><button');
    expect(plain).toContain('class="flex h-12 min-w-0 items-center gap-1.5"');
    expect(flipped).toContain('class="flex h-12 min-w-0 items-center gap-1.5 flex-row-reverse"');
    // From the outer edge: picker, FX button, BEATS, then the WET knob beside the mixer.
    const order = ['Επιλογή εφέ, Deck B', 'Εφέ, Deck B', 'Λιγότερα beats', 'Ποσότητα εφέ, Deck B'].map(label => plain.indexOf(`aria-label="${label}`));
    expect(order.every((at, i) => at > -1 && (i === 0 || at > order[i - 1]))).toBe(true);
  });

  test('labels every control in Greek, with the first-run preset and amount', () => {
    const html = fx();
    expect(html).toContain('aria-label="Επιλογή εφέ, Deck B: Polyrhythmic Delay"');
    expect(button(html)).toContain('aria-pressed="false"');
    expect(button(html)).toContain('title="Κλικ: μένει ανοιχτό · Κράτημα: μόνο όσο το κρατάς"');
    expect(button(html)).toContain('data-hold-key');
    expect(html).toContain('aria-label="Beats εφέ: ¾·1 (3:4)"');
    expect(html).toContain('aria-label="Περισσότερα beats"');
    expect(html).toContain('aria-label="Ποσότητα εφέ, Deck B"');
    expect(html).toContain('aria-valuetext="70 %"');
    expect(html).toContain('>WET</span>');
    expect(html).not.toContain('polyrhythmic-delay'); // no ids are shown
  });

  test('on, held, releasing and tail are static colour changes on the same button', () => {
    engage('B', 'latch');
    const on = button(fx());
    expect(on).toContain('aria-pressed="true"');
    expect(on).toContain('bg-[color-mix(in_oklch,var(--deck)_24%,transparent)]');
    expect(on).not.toContain('ring-1');
    release('B', true);
    engage('B', 'hold');
    expect(button(fx())).toContain('ring-1 ring-[var(--deck)]');
    release('B');
    selectPreset('B', 'echo-out');
    engage('B', 'latch');
    release('B');
    const releasing = button(fx());
    expect(releasing).toContain('border-dashed');
    expect(releasing).toContain('title="Σβήνει στην επόμενη φράση"');
    expect(fx()).not.toContain('Ακούγεται ακόμα η ουρά του εφέ');
    setNodeState('B', { engaged: true, tail: true });
    expect(fx()).toContain('aria-label="Ακούγεται ακόμα η ουρά του εφέ"');
  });

  test('disables the FX button without a BPM for tempo presets, and when the effects are unavailable', () => {
    expect(button(fx(false, null))).toContain('disabled=""');
    expect(button(fx(false, null))).toContain('title="Χρειάζεται BPM"');
    selectPreset('B', 'reverse');
    expect(button(fx(false, null))).not.toContain('disabled=""');
    setAvailable(false);
    expect(button(fx())).toContain('disabled=""');
    expect(button(fx())).toContain('title="Τα εφέ δεν είναι διαθέσιμα."');
  });
});

describe('FX picker', () => {
  afterEach(resetFxRack);
  const panel = (noBpm = false) => renderToString(<FxRackPanel deck="A" presetId="echo" noBpm={noBpm} onPick={() => {}} />);

  // Each chunk holds one item's cmdk attributes and its content.
  const items = (html: string) => html.split('cmdk-item=""').slice(1);

  test('favourites come first, then the families; the current preset shows in both', () => {
    const html = panel();
    const fav = html.indexOf('>Αγαπημένα<'), basic = html.indexOf('>Βασικά<');
    expect(fav).toBeGreaterThan(-1);
    expect(fav).toBeLessThan(basic);
    expect(basic).toBeLessThan(html.indexOf('>Psytrance<'));
    const favourites = html.slice(fav, basic);
    expect(items(favourites)).toHaveLength(10);
    expect(favourites.indexOf('>Polyrhythmic Delay<')).toBeLessThan(favourites.indexOf('>Chromatic Juggle<'));
    expect(items(html)).toHaveLength(76);
    expect(html.split('>Echo<span class="sr-only"> (επιλεγμένο)</span>')).toHaveLength(3);
    expect(html).toContain('placeholder="Αναζήτηση εφέ…"');
    expect(html).toContain('title="Ctrl+D: αγαπημένο"');
    expect(html).toContain('aria-label="Αφαίρεση από τα αγαπημένα"');
    expect(html).toContain('aria-label="Στα αγαπημένα"');
    // Screen readers hear the favourite state from the option's own text; the pointer-only star is hidden from them.
    expect(html).toContain('>Echo<span class="sr-only"> (επιλεγμένο)</span><span class="sr-only"> (αγαπημένο)</span>');
    expect(html).toContain('aria-hidden="true" aria-pressed="false" aria-label="Στα αγαπημένα"');
    expect(html).toContain('Σταμάτημα στη φράση');
    expect(html).toContain('Όταν το κλείνεις, σβήνει στην επόμενη γραμμή φράσης.');
    expect(html).not.toContain('Χρειάζεται BPM');
  });

  test('a BPM-less track disables the tempo presets and says why', () => {
    const all = items(panel(true));
    const item = (name: string) => all.find(chunk => chunk.includes(`>${name}<`)) ?? '';
    expect(item('Echo')).toContain('data-disabled="true"');
    expect(item('Echo')).toContain('Χρειάζεται BPM');
    expect(item('Reverse')).toContain('data-disabled="false"');
    expect(item('Reverse')).not.toContain('Χρειάζεται BPM');
  });

  test('search folds accents, case and final sigma, and needs every word', () => {
    const echo = ['Echo', 'Βασικά', 'Ηχώ συγχρονισμένη στο beat'];
    expect(fxPresetFilter('echo', 'ηχω', echo)).toBe(1);
    expect(fxPresetFilter('echo', 'ΗΧΏ', echo)).toBe(1);
    expect(fxPresetFilter('echo', 'echo beat', echo)).toBe(1);
    expect(fxPresetFilter('echo', 'echo reverb', echo)).toBe(0);
    expect(fxPresetFilter('lowpass', 'ψηλας', ['Lowpass', 'Φίλτρα', 'Κόβει τα ψηλάς'])).toBe(1);
  });
});

describe('unipolar knob', () => {
  const knob = (value: number, unipolar: boolean) => renderToString(<Knob label="WET" ariaLabel="Ποσότητα" unipolar={unipolar} value={value} onChange={() => {}} />);
  test('the arc runs from the left end and rests at -1', () => {
    expect(knob(-1, true).match(/<path/g)).toHaveLength(1);
    expect(knob(0.4, true)).toContain(`d="${knobArc(-135, 54)}"`);
    expect(knob(0, false).match(/<path/g)).toHaveLength(1); // bipolar still rests at the centre
    expect(knob(0, true)).toContain('aria-label="Ποσότητα"');
  });
});
