"""The set-story reader (batch 1): chapters from tempo plateaus, parentheses, entries and drift."""
import json

from sqlmodel import Session

from app.models import DJSet, SetTrack, Track, TrackStructure
from app.services.set_story import StoryRow, read_story


def rows(*bpms, duration=360.0, **fields):
    return [StoryRow(bpm=b, duration=duration, **fields) for b in bpms]


def shape(reading):
    return [(c["kind"], c["first_row"], c["last_row"]) for c in reading["chapters"]]


def test_one_band_is_one_steady_chapter_with_a_padded_range():
    reading = read_story(rows(180, 181, 182, 183, 184, 182, 181, 180, 182, 183))
    assert shape(reading) == [("plateau", 0, 9)]
    chapter = reading["chapters"][0]
    assert chapter["entry"] is None
    assert chapter["lo"] == 179.3 and chapter["hi"] == 184.7  # median 182 ±1.5% is wider than 180-184
    assert chapter["seconds"] == 3600 and chapter["start_seconds"] == 0
    assert reading["parentheses"] == [] and reading["crate"] is False


def test_two_bands_with_a_three_four_jump():
    reading = read_story(rows(*[200] * 8, *[150] * 8))
    assert shape(reading) == [("plateau", 0, 7), ("plateau", 8, 15)]
    second = reading["chapters"][1]
    assert second["entry"] == {"kind": "jump", "from_bpm": 200, "to_bpm": 150, "three_four": True}
    assert second["start_seconds"] == 8 * 360


def test_200_to_146_is_three_four_and_182_to_146_is_a_plain_jump():
    assert read_story(rows(*[200] * 4, *[146] * 4))["chapters"][1]["entry"]["three_four"] is True
    entry = read_story(rows(*[182] * 4, *[146] * 4))["chapters"][1]["entry"]
    assert entry["kind"] == "jump" and entry["three_four"] is False


def test_a_step_between_bands_is_not_a_jump():
    entry = read_story(rows(*[140] * 4, *[150] * 4))["chapters"][1]["entry"]
    assert entry["kind"] == "step"


def test_a_one_track_visit_is_a_parenthesis_inside_one_chapter():
    reading = read_story(rows(148, 148, 148, 200, 146, 148, 148))
    assert shape(reading) == [("plateau", 0, 6)]
    assert reading["parentheses"] == [{"row": 3, "chapter": 0, "bpm": 200, "before_bpm": 148, "after_bpm": 146}]
    assert reading["chapters"][0]["hi"] < 160  # the visit does not widen the range


def test_a_wandering_stretch_fuses_into_one_wide_chapter():
    reading = read_story(rows(145, 145, 145, 145, 150, 162, 174, 158, 180, 166))
    assert shape(reading) == [("plateau", 0, 3), ("wander", 4, 9)]
    wander = reading["chapters"][1]
    assert wander["lo"] == 150 and wander["hi"] == 180
    assert wander["entry"]["kind"] == "step"  # 145 → 150 is 3.4%


def test_an_arch_reads_as_three_chapters_up_and_back():
    reading = read_story(rows(*[180] * 6, *[200] * 6, *[181] * 6))
    assert shape(reading) == [("plateau", 0, 5), ("plateau", 6, 11), ("plateau", 12, 17)]
    up, down = reading["chapters"][1]["entry"], reading["chapters"][2]["entry"]
    assert (up["kind"], up["from_bpm"], up["to_bpm"]) == ("step", 180, 200)
    assert (down["kind"], down["from_bpm"], down["to_bpm"]) == ("step", 200, 181)


def test_a_lone_short_run_joins_the_nearer_neighbour():
    # 170 sits between bands at 160 and 200; it joins 160 (6.25% away, just over 6%: the chapter turns wide).
    reading = read_story(rows(*[160] * 4, 170, *[200] * 4))
    assert shape(reading) == [("wander", 0, 4), ("plateau", 5, 8)]
    reading = read_story(rows(*[160] * 4, 165, *[200] * 4))
    assert shape(reading) == [("plateau", 0, 4), ("plateau", 5, 8)]


def test_never_more_than_six_chapters():
    bands = [130, 145, 160, 178, 196, 216, 238]
    reading = read_story(rows(*[b for band in bands for b in [band] * 3]))
    assert len(reading["chapters"]) == 6
    assert reading["chapters"][-1]["last_row"] == 20


def test_half_and_double_time_tracks_are_folded_onto_the_median():
    reading = read_story(rows(150, 151, 75, 150, 300, 149))
    assert reading["folded"] == [2, 4]
    assert shape(reading) == [("plateau", 0, 5)]


def test_a_set_of_two_tracks_and_an_empty_set():
    assert shape(read_story(rows(150, 152))) == [("wander", 0, 1)]
    empty = read_story([])
    assert empty["chapters"] == [] and empty["parentheses"] == [] and empty["track_count"] == 0


def test_tracks_with_no_bpm_are_counted_and_kept_in_place():
    reading = read_story(rows(None, 148, None, 149, 150, None))
    assert reading["unknown"]["bpm"] == 3
    assert shape(reading) == [("plateau", 0, 5)]
    assert reading["chapters"][0]["unknown"]["bpm"] == 3
    nothing = read_story(rows(None, None))
    assert nothing["chapters"] == [] and nothing["unknown"]["bpm"] == 2


def test_no_bpm_rows_between_bands_belong_to_the_chapter_before():
    reading = read_story(rows(*[200] * 3, None, *[150] * 3))
    assert shape(reading) == [("plateau", 0, 3), ("plateau", 4, 6)]


def test_drift_reports_a_quieter_end_of_two_db():
    tracks = [StoryRow(bpm=150, duration=360, lufs=-8.0 if i < 6 else -10.0, bass_share=0.77) for i in range(9)]
    drift = read_story(tracks)["chapters"][0]["drift"]
    assert drift == {"tempo": None, "lufs": [-8.0, -10.0], "bass": None}


def test_drift_ignores_half_a_db_and_short_chapters():
    tracks = [StoryRow(bpm=150, duration=360, lufs=-8.0 if i < 6 else -8.5) for i in range(9)]
    assert read_story(tracks)["chapters"][0]["drift"] is None
    short = [StoryRow(bpm=150, duration=360, lufs=-8.0 if i < 4 else -11.0) for i in range(7)]
    assert read_story(short)["chapters"][0]["drift"] is None


def test_drift_in_tempo_and_bass_share():
    bpms = [180, 181, 182, 183, 184, 185, 186, 187, 188]
    tracks = [StoryRow(bpm=b, duration=360, bass_share=0.77 if i < 3 else 0.64) for i, b in enumerate(bpms)]
    drift = read_story(tracks)["chapters"][0]["drift"]
    assert drift["tempo"] == [181, 187] and drift["bass"] == [0.77, 0.64] and drift["lufs"] is None


def test_chapter_facts_style_key_artist_and_loudness_change():
    first = [StoryRow(bpm=182, duration=360, lufs=-9.0, style="Hi-Tech", key="8a", artist="Virtuanoise")
             for _ in range(4)]
    second = [StoryRow(bpm=146, duration=360, lufs=-8.0, style="Full-On", key=k, artist=a)
              for k, a in (("8a", "A"), ("8a", "B"), ("9a", "Unknown Artist"), ("9a", "unknown artist"))]
    one, two = read_story(first + second)["chapters"]
    assert one["style"] == {"name": "Hi-Tech", "count": 4, "of": 4}
    assert one["key"] == {"name": "8A", "count": 4, "of": 4}
    assert one["artist"] == {"name": "Virtuanoise", "count": 4}
    assert two["key"] is None  # 8A and 9A tie: no home key
    assert two["artist"] is None  # placeholder names do not count as a repeated artist
    assert two["lufs_change"] == 1.0


def test_over_four_hours_reads_as_a_crate():
    assert read_story(rows(*[150] * 41))["crate"] is True
    assert read_story(rows(*[150] * 40))["crate"] is False


def test_story_route_reads_the_set_in_order(client):
    from app.db import get_engine

    with Session(get_engine()) as s:
        s.add(DJSet(id=1, title="Story"))
        for i, bpm in enumerate([*[200] * 4, *[150] * 4]):
            s.add(Track(id=i + 1, absolute_path=f"/fixture/{i}.wav", bpm=bpm, duration=300, loudness_lufs=-8.0))
        s.commit()
        s.add_all([SetTrack(set_id=1, position=i, track_id=i + 1) for i in range(8)])
        s.add(TrackStructure(track_id=1, version=1, data=json.dumps(
            {"sections": [{"start_s": 0, "beats": 32, "bass": False, "level": 0.4},
                          {"start_s": 10, "beats": 96, "bass": True, "level": 1.0}]})))
        s.commit()
    response = client.get("/api/sets/1/story")
    assert response.status_code == 200
    reading = response.json()["reading"]
    assert [(c["first_row"], c["last_row"]) for c in reading["chapters"]] == [(0, 3), (4, 7)]
    assert reading["chapters"][1]["entry"]["three_four"] is True
    assert reading["chapters"][0]["unknown"]["bass"] == 3  # one track has a structure: 75% bass
    assert client.get("/api/sets/99/story").status_code == 404


def test_a_far_off_last_track_joins_the_chapter_before_it():
    """A short tail far from the chapter before it and with nothing after it used to raise TypeError."""
    for tail in (1400, 1500, 1600):
        story = read_story(rows(150, 150, 150, 150, tail))
        assert story is not None
