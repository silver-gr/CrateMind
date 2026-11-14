"""BPM consumers share source precedence without overwriting raw observations."""
from __future__ import annotations

import csv
from pathlib import Path

import pytest

from app.models import ArtistProfile, DJSet, SetTrack, Track
from app.services import metadata_reader, recommender, search


def _track(**values):
    return Track(absolute_path="/tempo.wav", **values)


@pytest.mark.parametrize("values, expected, source", [
    ({"bpm": 150, "bpm_analyzed": 145}, 150, "metadata"),
    ({"bpm": 0, "bpm_analyzed": 145}, 145, "local"),
    ({"bpm": -150, "bpm_analyzed": 145}, 145, "local"),
    ({"bpm": float("nan"), "bpm_analyzed": 145}, 145, "local"),
    ({"bpm": float("inf"), "bpm_analyzed": 145}, 145, "local"),
    ({"bpm_consensus": 148, "bpm_analyzed": 145}, 148, "consensus"),
    ({"bpm_consensus": 148, "bpm_consensus_sources": "local+essentia", "bpm_analyzed": 145}, 148, "local+essentia"),
    ({"bpm": 150, "bpm_consensus": 148, "bpm_consensus_sources": "manual:essentia"}, 148, "manual:essentia"),
    ({"bpm": 150, "bpm_consensus": 0, "bpm_consensus_sources": "manual:essentia"}, 150, "metadata"),
    ({"bpm": 145, "bpm_consensus": 72.5, "bpm_consensus_sources": "manual:octave"}, 72.5, "manual:octave"),
    ({"bpm_analyzed": 190, "bpm_consensus": 95, "bpm_consensus_sources": "manual:octave"}, 95, "manual:octave"),
    ({"bpm": 150, "bpm_consensus": 148, "bpm_consensus_sources": "local+essentia"}, 150, "metadata"),
    ({"bpm": 0, "bpm_consensus": -1, "bpm_analyzed": float("inf")}, None, None),
    ({"bpm": 350}, 350, "metadata"),
    # CrateMind's own grid tempo: second after manual.
    ({"bpm_grid": 146.0, "bpm_consensus": 145.19, "bpm_consensus_sources": "local+reccobeats", "bpm_analyzed": 146.02}, 146.0, "grid"),
    ({"bpm_grid": 146.0, "bpm_analyzed": 145.9}, 146.0, "grid"),
    ({"bpm_grid": 146.0}, 146.0, "grid"),
    ({"bpm_grid": 146.0, "bpm": 150, "bpm_consensus": 73.0, "bpm_consensus_sources": "manual:octave"}, 73.0, "manual:octave"),
    ({"bpm_grid": 149.7, "bpm": 150}, 149.7, "grid"),             # a tag it agrees with: the exact value wins
    ({"bpm_grid": 219.0, "bpm": 146}, 146, "metadata"),           # a tag it contradicts stays
    ({"bpm_grid": 132.0, "bpm_analyzed": 176.0}, 132.0, "grid"),  # the analysis' 4/3 error gives way
    ({"bpm_grid": 92.5, "bpm": 185}, 185.0, "grid"),              # the old value keeps deciding the octave
    ({"bpm_grid": 68.0, "bpm_analyzed": 272.0}, 272.0, "grid"),   # two octaves
    ({"bpm_grid": 0, "bpm_analyzed": 145}, 145, "local"),
    ({"bpm_grid": float("nan"), "bpm": 150}, 150, "metadata"),
])
def test_effective_bpm_policy(values, expected, source):
    from app.services.tempo import bpm_source, effective_bpm

    track = _track(**values)
    before = track.model_dump()
    assert effective_bpm(track) == expected
    assert bpm_source(track) == source
    assert track.model_dump() == before
    assert recommender.effective_bpm(track) == expected


@pytest.mark.parametrize("query, names", [
    ("bpm:145", {"zero", "analyzed"}),
    ("bpm:144-149", {"zero", "analyzed", "consensus", "manual"}),
    ("bpm:149+", {"metadata"}),
    ("bpm:146-", {"zero", "analyzed"}),
    ("-bpm:145", {"metadata", "consensus", "manual", "missing", "invalid"}),
    ("bpm:0", set()),
])
def test_search_and_count_use_effective_bpm(db, query, names):
    values = {
        "metadata": {"bpm": 150, "bpm_consensus": 148},
        "analyzed": {"bpm_analyzed": 145},
        "zero": {"bpm": 0, "bpm_analyzed": 145},
        "consensus": {"bpm_consensus": 148, "bpm_analyzed": 160},
        "manual": {"bpm": 180, "bpm_consensus": 147, "bpm_consensus_sources": "manual:local"},
        "missing": {},
        "invalid": {"bpm": float("inf"), "bpm_consensus": -1, "bpm_analyzed": 0},
    }
    for name, fields in values.items():
        db.add(Track(absolute_path=f"/{name}.wav", title=name, **fields))
    db.commit()
    assert {row.title for row in search.search(db, query)} == names
    assert search.count(db, query) == len(names)


def test_whole_bpm_range_matches_the_rounded_bpm(db):
    for name, value in {"low": 139.49, "edge_lo": 139.6, "edge_hi": 145.02, "high": 145.5}.items():
        db.add(Track(absolute_path=f"/{name}.wav", title=name, bpm_analyzed=value))
    db.commit()
    assert {row.title for row in search.search(db, "bpm:140-145")} == {"edge_lo", "edge_hi"}
    assert {row.title for row in search.search(db, "bpm:145-145")} == {"edge_hi"}
    assert {row.title for row in search.search(db, "-bpm:140-145")} == {"low", "high"}
    assert {row.title for row in search.search(db, "bpm:139.7-145.01")} == set()


def test_recommendation_and_set_analysis_use_consensus(db):
    from app.api.sets import analysis

    track = Track(absolute_path="/manual.wav", bpm=180, bpm_consensus=147,
                  bpm_consensus_sources="manual:local")
    zero = Track(absolute_path="/zero.wav", bpm=0, bpm_analyzed=148)
    dj_set = DJSet(title="Tempo")
    db.add_all([track, zero, dj_set])
    db.commit()
    db.add_all([SetTrack(set_id=dj_set.id, track_id=track.id, position=0),
                SetTrack(set_id=dj_set.id, track_id=zero.id, position=1)])
    db.commit()
    rows = recommender.recommend(db, recommender.Context(target_bpm=147))
    assert [(row["bpm"], row["bpm_is_analyzed"]) for row in rows] == [(147, True), (148, True)]
    assert all(any("BPM close" in reason for reason in row["reasons"]) for row in rows)
    assert analysis(dj_set.id, db)["bpm_curve"] == [147, 148]
    assert analysis(dj_set.id, db)["transition_warnings"] == []


def test_artist_prefill_uses_manual_bpm():
    from app.api.tracks import _artist_prefill_payload

    artist = ArtistProfile(normalized_name="act", canonical_name="Act",
                           typical_bpm_min=140, typical_bpm_max=150)
    track = _track(bpm=180, bpm_consensus=147, bpm_consensus_sources="manual:local")
    assert _artist_prefill_payload(track, artist)["bpm_conflict"] is False


@pytest.mark.parametrize("raw, expected", [("0", None), ("-145", None), ("NaN", None),
                                             ("Infinity", None), ("145.25 BPM", 145.25),
                                             ("1e309", None)])
def test_embedded_bpm_rejects_invalid_values(raw, expected):
    assert metadata_reader._coerce_bpm(raw) == expected


def test_invalid_embedded_bpm_allows_filename_fallback(monkeypatch):
    monkeypatch.setattr(metadata_reader, "_open_audio", lambda _path: {"bpm": ["0"]})
    assert metadata_reader.read_tags(Path("Artist - Track 145 BPM.mp3"))["bpm"] == 145


def test_exports_preserve_raw_bpm_and_show_effective(db, tmp_path):
    from app.services.exporter_csv import export_csv
    from app.services.exporter_markdown import export_markdown

    track = _track(bpm=0, bpm_analyzed=145, artist="Act", title="Track")
    db.add(track)
    db.commit()
    markdown = export_markdown(DJSet(title="Tempo"), [track], tmp_path / "set.md")
    assert "145 BPM" in markdown.read_text()
    exported = export_csv(db, [track], tmp_path / "tracks.csv")
    with exported.open() as handle:
        row = next(csv.DictReader(handle, delimiter=";"))
    assert float(row["bpm"]) == 0
    assert float(row["effective_bpm"]) == 145
    assert row["bpm_source"] == "local"
    assert track.bpm == 0


def test_duplicates_show_effective_bpm_without_changing_raw(db):
    from app.api.duplicates import list_duplicates
    from app.models import DuplicateGroup, DuplicateGroupTrack

    track = _track(bpm=0, bpm_analyzed=145)
    group = DuplicateGroup(reason="same_audio")
    db.add_all([track, group])
    db.commit()
    db.add(DuplicateGroupTrack(group_id=group.id, track_id=track.id))
    db.commit()
    assert list_duplicates(session=db)[0]["tracks"][0]["bpm"] == 145
    db.refresh(track)
    assert track.bpm == 0


def test_the_detector_hint_leaves_the_grid_tempo_out():
    from app.services.tempo import effective_bpm

    track = _track(bpm_grid=132.0, bpm_analyzed=176.0)
    assert effective_bpm(track) == 132.0
    assert effective_bpm(track, include_grid=False) == 176.0


@pytest.mark.parametrize("row, expected", [
    (dict(bpm=145.9997, anchor_s=0.2, confidence=0.95, straight=True, method="librosa-onset-multilag-v2@133-286"), 146.0),
    (dict(bpm=130.227, anchor_s=0.2, confidence=0.8, straight=True, method=None), 130.23),
    (dict(bpm=140.0, anchor_s=0.2, confidence=0.79, straight=True, method=None), None),   # not confident
    (dict(bpm=140.0, anchor_s=0.2, confidence=0.95, straight=False, method=None), None),  # a beat list
    (dict(bpm=140.0, anchor_s=None, confidence=0.95, straight=True, method=None), None),  # no grid
    (dict(bpm=None, anchor_s=0.2, confidence=0.95, straight=True, method=None), None),
    (dict(bpm=90.0, anchor_s=0.2, confidence=0.95, straight=True, method="librosa-onset-wide-v1@40-240"), None),  # Therapy
])
def test_which_grid_rows_set_the_bpm(row, expected):
    from app.services.tempo import grid_tempo

    assert grid_tempo(row["bpm"], row["anchor_s"], row["confidence"], row["straight"], row["method"]) == expected


def test_search_finds_a_track_by_its_grid_tempo(db):
    db.add(Track(absolute_path="/grid.wav", title="grid", bpm_grid=146.0, bpm_consensus=145.19,
                 bpm_consensus_sources="local+reccobeats", bpm_analyzed=146.02))
    db.add(Track(absolute_path="/other.wav", title="other", bpm_consensus=145.19, bpm_consensus_sources="local+reccobeats"))
    db.commit()
    assert {row.title for row in search.search(db, "bpm:146")} == {"grid"}
    assert {row.title for row in search.search(db, "bpm:145.5-146.5")} == {"grid"}
    assert {row.title for row in search.search(db, "bpm:145.19")} == {"other"}
