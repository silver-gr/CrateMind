"""Sections and phrase lines from the sub-bass (services/track_structure.py), on hand-built features."""
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
