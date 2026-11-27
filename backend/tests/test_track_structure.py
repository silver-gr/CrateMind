"""Sections and phrase lines from the low end (services/track_structure.py), on hand-built features."""
import numpy as np

from app.services import beatgrid_detect, track_structure
from app.services.track_structure import PHRASE_BEATS, detect_structure, structure_from_beats

BEAT_S = 0.4


def _features(layout: list[tuple[int, bool]], seed: int = 3) -> tuple[np.ndarray, np.ndarray]:
    """Eight bands per beat for runs of (beats, bass on): the sub-bass high or low, the rest flat."""
    rng = np.random.default_rng(seed)
    on = np.concatenate([np.full(beats, 1.0 if bass else 0.0) for beats, bass in layout])
    per_beat = np.vstack([0.5 + 4.5 * on + rng.normal(0, 0.1, len(on)), np.tile(2.0 + on, (7, 1))])
    return per_beat, 0.5 + np.arange(len(on)) * BEAT_S


def _beat(structure_times, times) -> list[int]:
    return [int(np.argmin(np.abs(times - t))) for t in structure_times]


def test_sections_anchors_and_phrase_lines_of_a_known_layout():
    # Intro, bass, a four-bar break, bass with a two-beat dropout (a fill, not a section), outro.
    per_beat, times = _features([(32, False), (128, True), (16, False), (24, True), (2, False), (102, True), (32, False)])
    s = structure_from_beats(per_beat, times)
    assert s is not None and s.quality > 0.9
    assert [(sec.beats, sec.bass) for sec in s.sections] == [(32, False), (128, True), (16, False), (128, True), (32, False)]
    assert [sec.start_s for sec in s.sections] == [round(float(times[i]), 3) for i in (0, 32, 160, 176, 304)]
    assert _beat(s.anchors, times) == [32, 176]
    # The intro is counted back from the first bass; each anchor restarts the count.
    assert _beat(s.phrases, times) == [0, 32, 64, 96, 128, 160, 176, 208, 240, 272, 304]
    assert s.sections[1].level == 1.0 and s.sections[0].level < 1.0


def test_a_phrase_line_just_before_the_next_anchor_gives_way_to_it():
    per_beat, times = _features([(32, False), (56, True), (12, False), (100, True)])   # anchors at 32 and 100
    s = structure_from_beats(per_beat, times)
    assert _beat(s.anchors, times) == [32, 100]
    assert _beat(s.phrases, times) == [0, 32, 64, 100, 132, 164, 196]     # 96 is four beats before 100: dropped


def test_bass_from_the_first_beat_makes_the_start_an_anchor():
    per_beat, times = _features([(96, True), (32, False), (64, True)])
    s = structure_from_beats(per_beat, times)
    assert _beat(s.anchors, times) == [0, 128]
    assert _beat(s.phrases, times)[:4] == [0, 32, 64, 96]


def test_a_short_lead_in_without_bass_does_not_move_the_first_anchor():
    per_beat, times = _features([(3, False), (125, True), (32, False), (96, True)])
    s = structure_from_beats(per_beat, times)
    assert [(sec.beats, sec.bass) for sec in s.sections][:2] == [(3, False), (125, True)]
    assert _beat(s.anchors, times) == [3, 160]
    assert _beat(s.phrases, times)[:4] == [3, 35, 67, 99]


def test_bass_with_only_brief_dropouts_has_no_sections_to_show():
    per_beat, times = _features([(60, True), (4, False), (60, True), (4, False), (60, True), (4, False), (60, True), (4, False), (60, True)])
    assert structure_from_beats(per_beat, times) is None


def test_a_track_that_starts_on_the_first_beat_keeps_that_beat():
    """A grid whose first beat sits at 0:00 (before the first frame's centre): beat 0 stays beat 0."""
    fps = beatgrid_detect.FPS
    beat_times = 0.0 + np.arange(260) * BEAT_S
    n_frames = int((beat_times[-1] + 1) * fps)
    seconds = np.arange(n_frames) / fps + beatgrid_detect._FRAME0_S
    bass = (seconds < beat_times[128]) | (seconds >= beat_times[160])
    bands = np.vstack([np.where(bass, 5.0, 0.5), np.full((7, n_frames), 2.0)])
    s = detect_structure(bands, beat_times)
    assert s.anchors == (0.0, round(float(beat_times[160]), 3))
    assert s.phrases[:5] == (0.0, 12.8, 25.6, 38.4, 51.2)
    early = detect_structure(bands, beat_times - 0.02)          # the grid's first downbeat a little before 0:00
    assert early.anchors[0] == -0.02 and early.sections[0].beats == 128


def test_no_structure_without_a_clear_bass_split_or_on_a_short_track():
    rng = np.random.default_rng(5)
    noise = np.vstack([rng.normal(3, 1, 400), np.tile(2.0, (7, 400))])
    assert structure_from_beats(noise, np.arange(400) * BEAT_S) is None            # one bell curve: about 0.64
    flat = np.full((8, 400), 2.0)
    assert structure_from_beats(flat, np.arange(400) * BEAT_S) is None
    per_beat, times = _features([(16, False), (40, True)])
    assert structure_from_beats(per_beat, times) is None                            # under 64 beats
    assert track_structure.MIN_QUALITY > 0.64


def test_detect_structure_reads_band_frames_along_the_grid():
    # Frames of band energy with the sub-bass on from beat 32 to beat 160 of a 0.4 s grid.
    fps = beatgrid_detect.FPS
    beat_times = 0.25 + np.arange(260) * BEAT_S
    n_frames = int((beat_times[-1] + 1) * fps)
    seconds = np.arange(n_frames) / fps + beatgrid_detect._FRAME0_S
    bass = ((seconds >= beat_times[32]) & (seconds < beat_times[160])) | (seconds >= beat_times[192])
    bands = np.vstack([np.where(bass, 5.0, 0.5), np.full((7, n_frames), 2.0)])
    s = detect_structure(bands, beat_times)
    assert s is not None
    assert s.anchors == (round(float(beat_times[32]), 3), round(float(beat_times[192]), 3))
    assert [sec.bass for sec in s.sections] == [False, True, False, True]
    gaps = np.diff([t for t in s.phrases if beat_times[32] <= t < beat_times[160]])
    assert np.allclose(gaps, PHRASE_BEATS * BEAT_S, atol=1e-3)
    assert detect_structure(bands, beat_times[:40]) is None


def _layout(s) -> list[tuple[int, bool]]:
    return [(sec.beats, sec.bass) for sec in s.sections]


def test_short_pauses_between_bass_runs_are_fills_and_the_bass_coming_back_restarts_the_count():
    per_beat, times = _features([(32, False), (56, True), (8, False), (56, True), (9, False), (55, True), (11, False), (53, True), (32, False)])
    s = structure_from_beats(per_beat, times)
    assert _layout(s) == [(32, False), (248, True), (32, False)]                    # no section for a stop under three bars
    assert _beat(s.anchors, times) == [32, 96, 161, 227]                            # version 2 dropped the last three
    assert _beat(s.phrases, times) == [0, 32, 64, 96, 128, 161, 193, 227, 259, 291]
    assert [(_beat([f.start_s], times)[0], f.beats) for f in s.fills] == [(88, 8), (152, 9), (216, 11)]


def test_a_real_break_and_a_three_bar_gap_restart_the_count():
    per_beat, times = _features([(32, False), (64, True), (32, False), (64, True), (12, False), (64, True), (32, False)])
    s = structure_from_beats(per_beat, times)
    assert _layout(s) == [(32, False), (64, True), (32, False), (64, True), (12, False), (64, True), (32, False)]
    assert _beat(s.anchors, times) == [32, 128, 204] and s.fills == ()
    per_beat, times = _features([(32, False), (64, True), (32, False), (64, True), (11, False), (64, True), (32, False)])
    s = structure_from_beats(per_beat, times)
    assert _layout(s) == [(32, False), (64, True), (32, False), (139, True), (32, False)]   # 11 beats: the last one absorbed
    assert _beat(s.anchors, times) == [32, 128, 203] and len(s.fills) == 1                 # ... but the bass after it is an entrance


def test_a_short_lead_in_and_closing_stay_sections():
    per_beat, times = _features([(9, False), (120, True), (32, False), (100, True), (10, False)])
    s = structure_from_beats(per_beat, times)
    assert _layout(s) == [(9, False), (120, True), (32, False), (100, True), (10, False)]
    assert _beat(s.anchors, times) == [9, 161] and s.fills == ()


def test_the_first_anchor_after_a_pause_is_kept():
    """The first bass fades in (no anchor), pauses for two bars and comes back hard: that return is the first anchor."""
    per_beat, times = _features([(32, False), (40, True), (8, False), (120, True), (32, False)])
    per_beat[0, 32:48] = np.linspace(0.5, 5.0, 16)                 # a filter opening: no beat where the bass comes in
    per_beat[1, 32:48] = np.linspace(2.0, 3.0, 16)
    s = structure_from_beats(per_beat, times)
    assert _layout(s) == [(42, False), (158, True), (32, False)]   # the quiet start of the fade belongs to the intro
    assert _beat(s.anchors, times) == [80] and len(s.fills) == 1


def test_the_one_class_guard_runs_before_the_pauses_are_absorbed():
    per_beat, times = _features([(60, True), (8, False)] * 3 + [(60, True), (10, False)])
    s = structure_from_beats(per_beat, times)
    assert s is not None and _layout(s) == [(264, True), (10, False)]      # bass on 96% of the beats after absorbing
    assert _beat(s.anchors, times) == [0, 68, 136, 204]


def test_a_kick_roll_one_beat_before_the_bar_line_counts_from_the_bar_line():
    per_beat, times = _features([(31, False), (129, True), (32, False), (96, True)])
    s = structure_from_beats(per_beat, times, downbeat=0)
    assert _beat(s.anchors, times) == [32, 192]
    assert _beat(s.phrases, times)[:3] == [0, 32, 64]
    assert s.sections[1].start_s == round(float(times[31]), 3)      # the section stays where it was measured
    assert _beat(structure_from_beats(per_beat, times).anchors, times) == [31, 192]     # no bar line: nothing moves
    per_beat, times = _features([(30, False), (130, True), (32, False), (96, True)])
    assert _beat(structure_from_beats(per_beat, times, downbeat=0).anchors, times) == [30, 192]   # two beats off: stays


def test_an_anchor_one_beat_after_the_bar_line_moves_back_and_beat_zero_never_moves():
    per_beat, times = _features([(33, False), (127, True), (32, False), (96, True)])
    assert _beat(structure_from_beats(per_beat, times, downbeat=0).anchors, times) == [32, 192]
    per_beat, times = _features([(96, True), (32, False), (64, True)])
    assert _beat(structure_from_beats(per_beat, times, downbeat=1).anchors, times) == [0, 129]


def test_detect_structure_keeps_the_bar_line_when_beats_before_the_audio_are_dropped():
    fps = beatgrid_detect.FPS
    beat_times = -0.8 + np.arange(262) * BEAT_S                 # beats 0 and 1 lie before the audio
    n_frames = int((beat_times[-1] + 1) * fps)
    seconds = np.arange(n_frames) / fps + beatgrid_detect._FRAME0_S
    bass = ((seconds >= beat_times[34]) & (seconds < beat_times[162])) | (seconds >= beat_times[194])
    bands = np.vstack([np.where(bass, 5.0, 0.5), np.full((7, n_frames), 2.0)])
    assert _beat(detect_structure(bands, beat_times).anchors, beat_times) == [34, 194]
    # Beat 1 is on the bar line, so the bass at beat 34 is one beat late: it counts from 33.
    assert _beat(detect_structure(bands, beat_times, downbeat=1).anchors, beat_times) == [33, 193]


def test_intro_and_outro_come_out_as_version_1_measured_them():
    """The owner finds intros and outros almost perfect: a pause inside the bass changes neither."""
    per_beat, times = _features([(64, False), (60, True), (8, False), (60, True), (32, False), (128, True), (64, False)])
    for s in (structure_from_beats(per_beat, times), structure_from_beats(per_beat, times, downbeat=0)):
        # Version 1 gave sections (64, off) … (64, off) from beat 352, anchors 64, 132, 224 and these lines.
        assert _layout(s)[0] == (64, False) and _layout(s)[-1] == (64, False)
        assert s.sections[-1].start_s == round(float(times[352]), 3)
        assert _beat(s.anchors, times)[0] == 64 and _beat(s.anchors, times)[-1] == 224
        lines = _beat(s.phrases, times)
        assert [k for k in lines if k <= 64] == [0, 32, 64]
        assert [k for k in lines if k >= 224] == [224, 256, 288, 320, 352, 384]


# What a beat holds, per band (0-60, 60-120, 120-250 Hz) as (level, level in the first eighth of the beat): a kick-bass
# leaves a dip before every kick, so its energy moves inside the beat; a drone does not.
_KINDS = {
    "off": ((0.5, 0.5), (0.5, 0.5), (1.5, 1.5)),
    "bass": ((5.0, 3.0), (5.5, 3.5), (4.0, 2.0)),
    "note": ((2.5, 1.0), (5.5, 3.5), (4.0, 2.0)),          # the bass a note higher: it leaves the band below 60 Hz
    "drone": ((4.5, 4.5), (4.0, 4.0), (1.0, 1.0)),         # a sub drone: loud, and still
    "held": ((5.0, 5.0), (5.5, 5.5), (4.0, 4.0)),          # as loud as the kick-bass, no kick on this beat
    "weak": ((2.5, 1.0), (3.0, 1.5), (1.5, 1.5)),          # a quiet kick
    "build": ((4.0, 2.0), (4.5, 2.5), (1.5, 1.5)),         # the kick-bass, quieter and without its body
    "no sub": ((0.5, 0.5), (1.5, 0.5), (4.0, 2.0)),        # the kick-bass with its low end cut
}


def _track(layout: list[tuple[int, str]]) -> tuple[np.ndarray, np.ndarray]:
    """Band frames and beat times for runs of (beats, kind of beat): the three low bands follow `_KINDS`, the rest is flat."""
    kinds = [kind for beats, kind in layout for _ in range(beats)]
    beat_times = 0.25 + np.arange(len(kinds) + 1) * BEAT_S
    fps = beatgrid_detect.FPS
    seconds = np.arange(int((beat_times[-1] + 0.5) * fps)) / fps + beatgrid_detect._FRAME0_S + beatgrid_detect._ONSET_LEAD_S
    position = (seconds - beat_times[0]) / BEAT_S
    beat = np.clip(np.floor(position).astype(int), 0, len(kinds) - 1)
    before = position < 0
    dip = (position - np.floor(position)) < 0.125
    bands = np.full((8, len(seconds)), 2.0)
    for band in range(3):
        levels = np.array([_KINDS[kind][band] for kind in kinds])
        bands[band] = np.where(before, _KINDS["off"][band][0], np.where(dip, levels[beat, 1], levels[beat, 0]))
    return bands, beat_times


def _beats(s, beat_times) -> list[tuple[int, int, bool]]:
    return [(_beat([sec.start_s], beat_times)[0], sec.beats, sec.bass) for sec in s.sections]


def test_a_sub_drone_inside_a_break_is_not_bass():
    """In My Mind (2025 version), 2:22: the sub stays loud through the break, with no kick. The break starts where the kick stops."""
    bands, beat_times = _track([(32, "off"), (128, "bass"), (56, "drone"), (8, "off"), (128, "bass"), (32, "off")])
    s = detect_structure(bands, beat_times, downbeat=0)
    assert _beats(s, beat_times) == [(0, 32, False), (32, 128, True), (160, 64, False), (224, 128, True), (352, 32, False)]
    assert _beat(s.anchors, beat_times) == [32, 224]


def test_a_bass_note_change_under_a_running_kick_is_no_pause():
    """The same track from 3:12: every 16 bars the bass plays 4 bars a note higher and leaves the band below 60 Hz."""
    bands, beat_times = _track([(32, "off")] + [(48, "bass"), (16, "note")] * 3 + [(32, "off")])
    s = detect_structure(bands, beat_times, downbeat=0)
    assert _beats(s, beat_times) == [(0, 32, False), (32, 192, True), (224, 32, False)]
    assert _beat(s.anchors, beat_times) == [32] and s.fills == ()


def test_a_build_up_with_bass_then_a_short_silence_then_the_drop():
    """The same track's start: a build-up that already has bass from bar 17, two bars with no low end, the drop at bar 33."""
    bands, beat_times = _track([(64, "off"), (56, "build"), (8, "off"), (128, "bass"), (32, "off")])
    s = detect_structure(bands, beat_times, downbeat=0)
    assert _beats(s, beat_times) == [(0, 64, False), (64, 56, True), (120, 8, False), (128, 128, True), (256, 32, False)]   # the stop stays a section
    assert 128 in _beat(s.anchors, beat_times) and s.fills == ()
    assert [k for k in _beat(s.phrases, beat_times) if k >= 128] == [128, 160, 192, 224, 256]      # the count restarts on the drop
    # Between two bass runs of the same strength the same stop is a fill: no section, but the entrance after it is kept.
    bands, beat_times = _track([(64, "off"), (56, "bass"), (8, "off"), (128, "bass"), (32, "off")])
    s = detect_structure(bands, beat_times, downbeat=0)
    assert _beats(s, beat_times) == [(0, 64, False), (64, 192, True), (256, 32, False)]
    assert _beat(s.anchors, beat_times) == [64, 128] and [f.beats for f in s.fills] == [8]


def test_a_bar_of_silence_before_the_drop_never_hides_the_drop():
    """After a long break: a short build-up, one bar with no low end, the drop. The drop is an entrance, whatever came before,
    and however short the tease (three bars here is under the six bars a fill inside the bass needs)."""
    for tease in ("build", "bass"):
        for beats in (28, 12):
            drop = 196 + beats
            bands, beat_times = _track([(32, "off"), (96, "bass"), (64, "off"), (beats, tease), (4, "off"), (128, "bass"), (32, "off")])
            s = detect_structure(bands, beat_times, downbeat=0)
            anchors = _beat(s.anchors, beat_times)
            assert drop in anchors and drop in _beat(s.phrases, beat_times) and drop + 32 in _beat(s.phrases, beat_times)
            assert _beats(s, beat_times)[2] == (128, 64, False)             # the long break is untouched


def test_a_groove_of_short_stops_restarts_no_count():
    """Two bars of bass, one bar off, over and over: the returns are no drops. Only the fill after a full phrase counts."""
    bands, beat_times = _track([(32, "off"), (64, "bass")] + [(4, "off"), (8, "bass")] * 3 + [(4, "off"), (64, "bass"), (32, "off")])
    s = detect_structure(bands, beat_times, downbeat=0)
    assert _beats(s, beat_times) == [(0, 32, False), (32, 168, True), (200, 32, False)]
    assert _beat(s.anchors, beat_times) == [32, 100]                     # not 112, 124 and 136 too
    assert [(_beat([f.start_s], beat_times)[0], f.beats) for f in s.fills] == [(96, 4), (108, 4), (120, 4), (132, 4)]
    assert _beat(s.phrases, beat_times) == [0, 32, 64, 100, 132, 164, 196, 228]


def test_a_quiet_intro_with_a_weak_kick_stays_intro():
    """Not Like You, bars 33 to 80: a quiet kick long before the drop at bar 97."""
    bands, beat_times = _track([(32, "off"), (64, "weak"), (32, "off"), (128, "bass"), (32, "off"), (96, "bass")])
    s = detect_structure(bands, beat_times, downbeat=0)
    assert _beats(s, beat_times) == [(0, 128, False), (128, 128, True), (256, 32, False), (288, 96, True)]
    assert _beat(s.anchors, beat_times) == [128, 288]


def test_the_kick_bass_without_its_sub_counts_after_a_short_stop_inside_the_bass():
    """Not Like You, bar 281: one bar of transition, then the kick-bass with its weight at 120-500 Hz, then the full drop."""
    bands, beat_times = _track([(32, "off"), (128, "bass"), (4, "off"), (64, "no sub"), (16, "off"), (64, "bass"), (32, "off")])
    s = detect_structure(bands, beat_times, downbeat=0)
    assert _beats(s, beat_times) == [(0, 32, False), (32, 196, True), (228, 16, False), (244, 64, True), (308, 32, False)]
    assert _beat(s.anchors, beat_times) == [32, 164, 244]
    # Not when the full bass never returns (an outro with the low end cut), and not before the first bass (an intro).
    bands, beat_times = _track([(32, "off"), (128, "bass"), (4, "off"), (64, "no sub"), (64, "off")])
    assert _beats(detect_structure(bands, beat_times, downbeat=0), beat_times) == [(0, 32, False), (32, 128, True), (160, 132, False)]
    bands, beat_times = _track([(32, "off"), (64, "no sub"), (4, "off"), (128, "bass"), (32, "off"), (64, "bass")])
    assert _beats(detect_structure(bands, beat_times, downbeat=0), beat_times)[:2] == [(0, 100, False), (100, 128, True)]


def test_a_one_bar_stop_inside_the_bass_is_no_section_and_restarts_the_count():
    bands, beat_times = _track([(32, "off"), (60, "bass"), (4, "off"), (100, "bass"), (32, "off")])
    s = detect_structure(bands, beat_times, downbeat=0)
    assert _beats(s, beat_times) == [(0, 32, False), (32, 164, True), (196, 32, False)]
    assert _beat(s.anchors, beat_times) == [32, 96] and [(_beat([f.start_s], beat_times)[0], f.beats) for f in s.fills] == [(92, 4)]
    assert _beat(s.phrases, beat_times) == [0, 32, 64, 96, 128, 160, 192, 224]
    two = _track([(32, "off"), (62, "bass"), (2, "off"), (100, "bass"), (32, "off")])     # two beats: a flicker, nothing restarts
    assert _beat(detect_structure(*two, downbeat=0).anchors, two[1]) == [32]


def test_a_kick_on_every_second_beat_is_still_bass():
    bands, beat_times = _track([(32, "off")] + [(1, "bass"), (1, "held")] * 64 + [(32, "off")])
    assert _beats(detect_structure(bands, beat_times, downbeat=0), beat_times) == [(0, 32, False), (32, 128, True), (160, 32, False)]


def test_tempo_factor_follows_the_deck_s_octave_fold():
    assert track_structure.tempo_factor(290.0, 145.0) == 0.5
    assert track_structure.tempo_factor(72.5, 145.0) == 2.0
    assert track_structure.tempo_factor(145.0, 146.0) == 1.0
    assert track_structure.tempo_factor(140.0, 210.0) == 1.0       # 3/2 is no octave: the grid stays
    assert track_structure.tempo_factor(140.0, None) == 1.0 and track_structure.tempo_factor(None, 140.0) == 1.0


def test_fold_beats_keeps_the_bar_line():
    times = np.arange(10) * 0.2
    half, down = track_structure.fold_beats(times, 3, 0.5)         # every second beat, from the bar line on
    assert np.allclose(half, times[1::2]) and down == 1 and np.isclose(half[down], times[3])
    double, down = track_structure.fold_beats(times[:3], 1, 2.0)
    assert np.allclose(double, [0.0, 0.1, 0.2, 0.3, 0.4]) and down == 2
    same, down = track_structure.fold_beats(times, 3, 1.0)
    assert same is not None and np.allclose(same, times) and down == 3


def test_structure_routes_serve_stored_rows_only(client):
    import json

    from sqlmodel import Session

    from app.db import get_engine
    from app.models import Track, TrackStructure

    data = {"sections": [{"start_s": 0.25, "beats": 32, "bass": False, "level": 0.4}, {"start_s": 13.964, "beats": 96, "bass": True, "level": 1.0}],
            "anchors": [13.964], "phrases": [0.25, 13.964, 27.679]}
    with Session(get_engine(), expire_on_commit=False) as session:
        tracks = [Track(absolute_path=f"/x/{name}.mp3", file_name=f"{name}.mp3", duration=100.0) for name in ("phrased", "empty", "new")]
        for track in tracks:
            session.add(track)
        session.commit()
        phrased, empty, new = (track.id for track in tracks)
        session.add(TrackStructure(track_id=phrased, version=track_structure.VERSION, quality=0.9, data=json.dumps(data)))
        session.add(TrackStructure(track_id=empty, version=track_structure.VERSION))      # measured: nothing to read
        session.commit()

    assert client.get(f"/api/tracks/{phrased}/structure").json() == {"track_id": phrased, "version": track_structure.VERSION, "quality": 0.9, **data}
    for missing in (empty, new, 999_999):
        assert client.get(f"/api/tracks/{missing}/structure").status_code == 404
    many = client.get(f"/api/tracks/structures?ids={phrased},{empty},{new},999999")
    assert many.json() == {str(phrased): {"quality": 0.9, "sections": data["sections"]}}
    assert client.get("/api/tracks/structures?ids=").json() == {}
    assert client.get("/api/tracks/structures?ids=" + ",".join(map(str, range(301)))).status_code == 422
    assert client.get("/api/tracks/structures?ids=1,x").status_code == 422
