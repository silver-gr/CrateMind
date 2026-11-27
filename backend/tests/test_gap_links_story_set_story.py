"""Set story reader: edge cases a DJ meets live (one track, missing BPM, half/double folds, 3:4 jumps, big sets)."""
import math

import pytest

from app.services.set_story import StoryRow, read_story


def rows(*bpms, duration=360.0, **fields):
    return [StoryRow(bpm=b, duration=duration, **fields) for b in bpms]


def shape(reading):
    return [(c["kind"], c["first_row"], c["last_row"]) for c in reading["chapters"]]


def test_one_track_is_one_chapter_with_no_entry_and_a_padded_range():
    reading = read_story(rows(140))
    assert shape(reading) == [("wander", 0, 0)]
    chapter = reading["chapters"][0]
    assert chapter["entry"] is None and chapter["drift"] is None
    assert (chapter["lo"], chapter["median"], chapter["hi"]) == (137.9, 140, 142.1)
    assert reading["folded"] == [] and reading["parentheses"] == []


@pytest.mark.parametrize("bpm", [None, 0, 0.0])
def test_one_track_with_no_usable_bpm_has_no_chapter_but_is_counted(bpm):
    reading = read_story([StoryRow(bpm=bpm, duration=200.0)])
    assert reading["chapters"] == [] and reading["track_count"] == 1
    assert reading["unknown"] == {"bpm": 1, "duration": 0} and reading["seconds"] == 200.0


def test_a_zero_bpm_row_is_unknown_and_never_drags_the_median():
    # A zero read as a tempo would put the median at 0 and break every ratio.
    reading = read_story(rows(150, 0, 151, 0, 150, 0, 0))
    assert reading["unknown"]["bpm"] == 4
    assert shape(reading) == [("plateau", 0, 6)] and reading["chapters"][0]["median"] == 150


def test_missing_durations_are_counted_and_do_not_move_the_chapter_clock():
    tracks = [StoryRow(bpm=200, duration=300.0), StoryRow(bpm=200, duration=None), StoryRow(bpm=200, duration=300.0),
              StoryRow(bpm=150, duration=None), StoryRow(bpm=150, duration=300.0), StoryRow(bpm=150, duration=300.0)]
    reading = read_story(tracks)
    assert reading["unknown"]["duration"] == 2 and reading["seconds"] == 1200.0
    first, second = reading["chapters"]
    assert (first["seconds"], second["start_seconds"], second["seconds"]) == (600.0, 600.0, 600.0)


@pytest.mark.parametrize("x,folded", [
    (194.0, True), (206.0, True), (200.0, True),    # double time, inside ±3% of 2×
    (193.0, False), (207.0, False),                 # just outside
    (48.5, True), (51.5, True), (50.0, True),       # half time, inside ±3% of ½
    (48.0, False), (52.0, False),
    (133.3, False), (75.0, False),                  # 4:3 and 3:4 are never folded
])
def test_fold_window_around_half_and_double_the_median(x, folded):
    reading = read_story(rows(100, 100, 100, 100, x))  # the median stays 100
    assert reading["folded"] == ([4] if folded else [])


def test_the_majority_tempo_wins_the_fold():
    # Five tracks at 150 and four logged at half time: the 75s are read as 150, one chapter.
    reading = read_story(rows(150, 75, 150, 75, 150, 75, 150, 75, 150))
    assert reading["folded"] == [1, 3, 5, 7]
    assert shape(reading) == [("plateau", 0, 8)] and reading["chapters"][0]["median"] == 150


def test_a_half_time_track_opening_a_chapter_is_entered_at_its_folded_tempo():
    reading = read_story(rows(200, 200, 200, 200, 75, 150, 150, 150, 150))
    assert reading["folded"] == [4]
    assert shape(reading) == [("plateau", 0, 3), ("plateau", 4, 8)]
    assert reading["chapters"][1]["entry"] == {"kind": "jump", "from_bpm": 200, "to_bpm": 150, "three_four": True}


def test_double_time_tracks_at_the_end_are_no_tempo_drift():
    reading = read_story(rows(150, 150, 150, 150, 150, 150, 300, 300, 300))
    assert reading["folded"] == [6, 7, 8]
    assert shape(reading) == [("plateau", 0, 8)] and reading["chapters"][0]["drift"] is None


@pytest.mark.parametrize("before,after,kind,three_four", [
    (150, 200, "jump", True),     # 3:4 going up (4:3)
    (200, 150, "jump", True),     # and down
    (200, 155.8, "jump", True),   # 0.779, inside 4% of 0.75
    (200, 157, "jump", False),    # 0.785, outside
    (150, 180, "step", False),    # exactly 20% is still a step
    (150, 181, "jump", False),    # just over 20%: a jump, nowhere near 3:4
    (140, 150, "step", False),
])
def test_entry_kind_and_three_four_boundaries(before, after, kind, three_four):
    entry = read_story(rows(*[before] * 4, *[after] * 4))["chapters"][1]["entry"]
    assert (entry["kind"], entry["three_four"]) == (kind, three_four)
    assert (entry["from_bpm"], entry["to_bpm"]) == (before, after)


def test_an_entry_starts_from_the_last_track_of_the_chapter_before_not_its_median():
    reading = read_story(rows(140, 142, 144, 146, 148, 160, 160, 160, 160))
    assert shape(reading) == [("plateau", 0, 4), ("plateau", 5, 8)]
    assert reading["chapters"][0]["median"] == 144
    entry = reading["chapters"][1]["entry"]
    assert (entry["kind"], entry["from_bpm"], entry["to_bpm"]) == ("step", 148, 160)


def test_two_parentheses_in_one_plateau_and_never_two_in_a_row():
    reading = read_story(rows(148, 148, 148, 200, 148, 200, 148, 148))
    assert shape(reading) == [("plateau", 0, 7)]
    assert [p["row"] for p in reading["parentheses"]] == [3, 5]


def test_a_parenthesis_reads_its_neighbours_across_rows_with_no_bpm():
    reading = read_story(rows(148, 148, None, 200, 147, 148))
    assert shape(reading) == [("plateau", 0, 5)]
    assert reading["parentheses"] == [{"row": 3, "chapter": 0, "bpm": 200, "before_bpm": 148, "after_bpm": 147}]


def test_an_outlier_opening_or_closing_the_set_is_no_parenthesis():
    assert read_story(rows(200, 148, 148, 148))["parentheses"] == []
    assert read_story(rows(148, 148, 148, 200))["parentheses"] == []


def test_leading_rows_with_no_bpm_belong_to_the_first_chapter():
    reading = read_story(rows(None, None, 200, 200, 200, 150, 150, 150))
    assert shape(reading) == [("plateau", 0, 4), ("plateau", 5, 7)]
    assert reading["chapters"][0]["unknown"]["bpm"] == 2


def test_drift_needs_half_the_values_known_at_each_end():
    lufs = [None, None, -8.0, -8.0, -8.0, -8.0, -11.0, -11.0, -11.0]   # only one of the first three is measured
    tracks = [StoryRow(bpm=150, duration=360, lufs=v) for v in lufs]
    assert read_story(tracks)["chapters"][0]["drift"] is None
    lufs[1] = -8.0                                                    # two of three: enough
    tracks = [StoryRow(bpm=150, duration=360, lufs=v) for v in lufs]
    assert read_story(tracks)["chapters"][0]["drift"] == {"tempo": None, "lufs": [-8.0, -11.0], "bass": None}


def test_chapter_loudness_and_its_change_need_half_the_tracks_measured():
    first = [StoryRow(bpm=200, duration=360, lufs=None)] * 3 + [StoryRow(bpm=200, duration=360, lufs=-9.0)]
    second = [StoryRow(bpm=150, duration=360, lufs=-8.0)] * 4
    third = [StoryRow(bpm=110, duration=360, lufs=-10.0)] * 4
    one, two, three = read_story(first + second + third)["chapters"]
    assert one["lufs"] is None and one["unknown"]["lufs"] == 3
    assert two["lufs"] == -8.0 and two["lufs_change"] is None        # nothing to compare with
    assert three["lufs_change"] == -2.0


@pytest.mark.parametrize("artists,expected", [
    (["Ξύλινα Σπαθιά"] * 3 + ["Άλλος"], {"name": "Ξύλινα Σπαθιά", "count": 3}),
    ([" VA ", "Various Artists", "UNKNOWN", "misc"], None),          # placeholders in any case and spacing
    (["", None, "Alpha", "Beta"], None),                              # no name twice
    (["Αλφα", "αλφα", "Beta", "Gamma"], None),                        # case-different spellings are not merged
])
def test_repeated_artist_with_unicode_and_placeholder_names(artists, expected):
    tracks = [StoryRow(bpm=150, duration=360, artist=a) for a in artists]
    assert read_story(tracks)["chapters"][0]["artist"] == expected


@pytest.mark.parametrize("styles,expected", [
    (["Full-On", "Full-On", "Dark", "Forest"], {"name": "Full-On", "count": 2, "of": 4}),   # half is enough
    (["Full-On", "Full-On", "Dark", "Forest", "Hi-Tech"], None),                             # under half
    (["Full-On", None, None, None], None),                                                    # one is not a lead
])
def test_a_chapter_style_needs_half_its_known_styles(styles, expected):
    tracks = [StoryRow(bpm=150, duration=360, style=s) for s in styles]
    assert read_story(tracks)["chapters"][0]["style"] == expected


def _generated(name):
    if name == "sine":
        return [round(150 + 40 * math.sin(i / 9), 1) for i in range(400)]
    if name == "saw":
        return [100 + (i % 50) * 2 for i in range(400)]
    if name == "steps":
        return [band for band in (120, 138, 150, 174, 200, 145, 128, 190, 160, 132) for _ in range(40)]
    if name == "holes":
        return [None if i % 3 == 0 else 140 + (i % 7) for i in range(400)]
    raise ValueError(name)


@pytest.mark.parametrize("name", ["sine", "saw", "steps", "holes"])
def test_a_long_set_reads_as_at_most_six_chapters_that_tile_every_row(name):
    bpms = _generated(name)
    reading = read_story(rows(*bpms, duration=300.0))
    chapters = reading["chapters"]
    assert 1 <= len(chapters) <= 6
    assert chapters[0]["first_row"] == 0 and chapters[-1]["last_row"] == len(bpms) - 1
    for before, after in zip(chapters, chapters[1:]):
        assert after["first_row"] == before["last_row"] + 1
    assert sum(c["track_count"] for c in chapters) == len(bpms)
    for c in chapters:
        assert c["lo"] <= c["median"] <= c["hi"]
        assert c["start_seconds"] == c["first_row"] * 300.0
    for p in reading["parentheses"]:
        c = chapters[p["chapter"]]
        assert c["first_row"] <= p["row"] <= c["last_row"]
    assert reading["crate"] is True  # 400 × 5 min


def test_the_reading_is_deterministic_and_does_not_mutate_its_rows():
    tracks = rows(200, 200, 75, 150, 150, 300, 150, None, 181, 181, 181)
    snapshot = list(tracks)
    assert read_story(tracks) == read_story(tracks)
    assert tracks == snapshot
