"""Harmonic counts and filters share the effective, normalized musical key."""
from __future__ import annotations

import pytest
from sqlmodel import Session

from app.db import get_engine
from app.models import Track
from app.services import recommender, search


@pytest.mark.parametrize(("raw", "expected"), [
    ("8A", "8a"), (" 8 a ", "8a"), ("A minor", "8a"),
    ("A min", "8a"), ("Am", "8a"), ("A moll", "8a"),
    ("G♯ minor", "1a"), ("A♭m", "1a"), ("B# major", "8b"),
    ("C♭", "1b"), ("F♭ major", "12b"), ("F♯ dur", "2b"),
    ("AM", "11b"), ("A MAJOR", "11b"), ("C-sharp minor", "12a"),
    ("D flat major", "3b"), ("F♯ minor", "11a"), ("G♭m", "11a"),
    ("1m", "8a"), ("1d", "8b"), ("6m", "1a"), ("12d", "7b"),
    ("0A", None), ("13B", None), ("99A", None), ("unknown", None),
    ("Am7", None), ("C dorian", None), ("C diminished", None),
    ("", None), (None, None),
])
def test_normalization(raw, expected):
    assert recommender.to_camelot(raw) == expected


def _seed(session):
    rows = [
        Track(absolute_path="/tag.wav", key_text="A minor", key_analyzed="C major"),
        Track(absolute_path="/camelot.wav", key_text="8a"),
        Track(absolute_path="/analyzed.wav", key_analyzed="A minor"),
        Track(absolute_path="/whitespace.wav", key_text=" \t ", key_analyzed="C major"),
        Track(absolute_path="/unicode.wav", key_text="A♭m"),
        Track(absolute_path="/unknown.wav", key_text="unknown", key_analyzed="A minor"),
        Track(absolute_path="/invalid.wav", key_analyzed="13A"),
        Track(absolute_path="/empty.wav", key_text=" ", key_analyzed="\t"),
        Track(absolute_path="/null.wav"),
    ]
    session.add_all(rows)
    session.commit()


def test_key_filter_normalizes_and_uses_analyzed_fallback(db):
    _seed(db)
    expected = {"/tag.wav", "/camelot.wav", "/analyzed.wav"}
    for query in ['key:8A', 'key:am', 'key:"A minor"']:
        assert {t.absolute_path for t in search.search(db, query)} == expected
        assert search.count(db, query) == len(expected)
    assert {t.absolute_path for t in search.search(db, "key:8B")} == {"/whitespace.wav"}
    assert {t.absolute_path for t in search.search(db, "key:1A")} == {"/unicode.wav"}


def test_negative_key_filter_includes_unknown_and_missing(db):
    _seed(db)
    assert {t.absolute_path for t in search.search(db, "-key:8A")} == {
        "/whitespace.wav", "/unicode.wav", "/unknown.wav", "/invalid.wav", "/empty.wav", "/null.wav",
    }
    assert search.count(db, "key:13A") == 0
    assert search.count(db, "-key:13A") == 9


def test_key_stats_endpoint_and_library_filters_agree(client):
    with Session(get_engine()) as session:
        _seed(session)
    response = client.get("/api/tracks/key-stats")
    assert response.status_code == 200
    stats = response.json()
    assert {k: v for k, v in stats.items() if k != "counts"} == {
        "total": 9, "keyed": 5, "missing": 2, "unrecognized": 2,
        "metadata": 3, "analyzed": 2,
    }
    assert len(stats["counts"]) == 24
    assert stats["counts"]["8A"] == 3
    assert stats["counts"]["8B"] == 1
    assert stats["counts"]["1A"] == 1
    assert sum(stats["counts"].values()) == stats["keyed"]
    for code, expected in stats["counts"].items():
        assert client.get("/api/tracks/count", params={"q": f"key:{code}"}).json()["count"] == expected
        rows = client.get("/api/tracks/search", params={"q": f"key:{code}"}).json()
        assert len(rows) == expected


def test_empty_key_stats_is_success_with_zero_counts(client):
    response = client.get("/api/tracks/key-stats")
    assert response.status_code == 200
    stats = response.json()
    assert stats["total"] == stats["keyed"] == stats["missing"] == stats["unrecognized"] == 0
    assert stats["metadata"] == stats["analyzed"] == 0
    assert len(stats["counts"]) == 24 and set(stats["counts"].values()) == {0}


def test_stats_failure_propagates_instead_of_becoming_empty_library(client, monkeypatch):
    from app.services import musical_key

    def fail(_session):
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(musical_key, "key_stats", fail)
    with pytest.raises(RuntimeError, match="database unavailable"):
        client.get("/api/tracks/key-stats")


def test_whitespace_metadata_uses_analyzed_key_in_recommender(db):
    track = Track(absolute_path="/fallback.wav", key_text=" \t", key_analyzed="A minor")
    assert recommender.effective_key(track) == "A minor"
