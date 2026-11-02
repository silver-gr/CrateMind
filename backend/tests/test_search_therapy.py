"""Folded, prefix-aware search that survives SQLite's bound-variable cap."""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy.exc import OperationalError
from sqlmodel import Session, select

from app.db import reindex_track
from app.models import Track, TrackDJProfile
from app.services import search

BACKEND = Path(__file__).resolve().parents[1]


def _mk(db, path, *, artist=None, title=None, **profile) -> Track:
    t = Track(absolute_path=path, artist=artist, title=title, missing=False)
    db.add(t)
    db.commit()
    db.refresh(t)
    if profile:
        db.add(TrackDJProfile(track_id=t.id, **profile))
        db.commit()
    reindex_track(db, t.id)
    return t


def _titles(rows):
    return {t.title for t in rows}


def test_greek_accentless_final_sigma_and_prefix(db):
    _mk(db, "/manos.mp3", artist="Μάνος Χατζιδάκις", title="Χαλάρωση")
    _mk(db, "/kosmos.mp3", artist="Άλλος", title="Κόσμος")
    for q in ["μανος χατζιδακις", "ΜΑΝΟΣ", "χαλαρωση", "χατζιδ", "artist:μάνος", "artist:ΜΑΝΟΣ"]:
        assert _titles(search.search(db, q)) == {"Χαλάρωση"}, q
    for q in ["ΚΟΣΜΟΣ", "κοσμος"]:
        assert _titles(search.search(db, q)) == {"Κόσμος"}, q


def test_exclusion_is_exact_while_inclusion_is_prefix(db):
    _mk(db, "/a.mp3", title="Relax One")
    _mk(db, "/b.mp3", title="Relaxation Two")
    assert _titles(search.search(db, "relax")) == {"Relax One", "Relaxation Two"}
    assert _titles(search.search(db, "-relax")) == {"Relaxation Two"}


def test_accented_exclusion(db):
    _mk(db, "/a.mp3", title="Χαλάρωση Α")
    _mk(db, "/b.mp3", title="Ύπνος")
    for q in ["-χαλάρωση", "-ΧΑΛΑΡΩΣΗ", "-χαλαρωση"]:
        assert _titles(search.search(db, q)) == {"Ύπνος"}, q
    assert _titles(search.search(db, "ύπνος -χαλάρωση")) == {"Ύπνος"}


def test_elision_and_quoted_values(db):
    _mk(db, "/a.mp3", artist="Μάνος Χατζιδάκις", title="Σ' αγαπώ")
    _mk(db, "/b.mp3", artist="Other", title="Other")
    assert _titles(search.search(db, "Σ' αγαπώ")) == {"Σ' αγαπώ"}
    assert _titles(search.search(db, 'artist:"Μάνος Χατζιδάκις"')) == {"Σ' αγαπώ"}


def test_hostile_input_never_raises(db):
    _mk(db, "/a.mp3", artist="A", title="B")
    for q in ['"', 'a"b', "-", "*", "AND", "OR", "NOT", "(", "title:", ":", '""', "'"]:
        search.search(db, q)
        search.count(db, q)


def test_variable_cap_free_text_listing_and_exclusion(client, low_variable_limit):
    import app.db as dbmod

    with Session(dbmod.get_engine()) as session:
        tracks = [Track(absolute_path=f"/amb/{i}.mp3", title=f"Ambient {i}", missing=False) for i in range(150)]
        session.add_all(tracks)
        session.commit()
        for t in tracks:
            reindex_track(session, t.id, commit=False)
        session.commit()

    r = client.get("/api/tracks", params={"q": "ambient", "limit": 0})
    assert r.status_code == 200, r.text
    assert len(r.json()) == 150
    r = client.get("/api/tracks", params={"q": "untagged", "limit": 0})
    assert r.status_code == 200, r.text
    assert len(r.json()) == 150
    assert client.get("/api/tracks/count", params={"q": "ambient"}).json()["count"] == 150
    with Session(dbmod.get_engine()) as session:
        assert search.search(session, "ambient -ambient") == []
        assert len(search.search(session, "ambient -title999")) == 150


def test_low_variable_limit_fixture_really_limits(db, low_variable_limit):
    with pytest.raises(OperationalError):
        db.exec(select(Track.id).where(Track.id.in_(list(range(150))))).all()


def test_track_search_only_read_for_ids():
    app_dir = BACKEND / "app"
    allowed = {app_dir / "desktop_runtime" / "adoption.py", app_dir / "desktop_runtime" / "bootstrap.py"}
    pattern = re.compile(r"SELECT\s+(.{0,200}?)\s+FROM\s+[\"'`]?track_search\b", re.IGNORECASE | re.DOTALL)
    offenders = []
    for path in app_dir.rglob("*.py"):
        if path in allowed:
            continue
        for match in pattern.finditer(path.read_text(encoding="utf-8")):
            if match.group(1).strip().lower() != "rowid":
                offenders.append(f"{path.relative_to(BACKEND)}: {match.group(0)!r}")
    assert offenders == []


def test_frozen_self_test_covers_json_each_and_fold():
    result = subprocess.run(
        [sys.executable, "-m", "app.desktop_runtime.bootstrap", "--self-test"],
        cwd=BACKEND, capture_output=True, text=True, timeout=60,
    )
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout.strip().splitlines()[-1])
    assert payload["json_each"] == 2
    assert payload["fold"] == "μανοσ"


# --- valence, vocabulary tokens and folder (Task 6) ---------------------------

def _seeded(db):
    from app.services import facets

    facets.seed_preset(db, "therapy")
    return facets


def _tag(db, facets_mod, track, key, value):
    from app.models import Tag

    tag = db.exec(select(Tag).where(Tag.name == f"{key}:{value}")).one()
    facets_mod.apply_tag_changes(db, track.id, [tag.id], [])


def _ids(rows):
    return {t.id for t in rows}


def test_facet_token_matches_with_and_without_accents(db):
    facets_mod = _seeded(db)
    tagged, other = _mk(db, "/a.mp3", title="A"), _mk(db, "/b.mp3", title="B")
    _tag(db, facets_mod, tagged, "purpose", "χαλάρωση")
    for q in ["purpose:χαλάρωση", "purpose:χαλαρωση", "purpose:ΧΑΛΑΡΩΣΗ", 'purpose:"χαλάρωση"']:
        assert _ids(search.search(db, q)) == {tagged.id}, q
    assert search.search(db, "purpose:ενεργοποίηση") == []
    assert search.search(db, "purpose:άγνωστο") == []
    assert _ids(search.search(db, "-purpose:άγνωστο")) == {tagged.id, other.id}


def test_facet_multiword_value_needs_quotes(db):
    facets_mod = _seeded(db)
    t = _mk(db, "/a.mp3", title="A")
    _tag(db, facets_mod, t, "purpose", "συναισθηματική έκφραση")
    assert _ids(search.search(db, 'purpose:"συναισθηματική έκφραση"')) == {t.id}
    assert search.search(db, "purpose:συναισθηματική") == []


def test_has_any_and_missing(db):
    facets_mod = _seeded(db)
    a, b, untouched = _mk(db, "/a.mp3", title="A"), _mk(db, "/b.mp3", title="B"), _mk(db, "/c.mp3", title="C")
    _tag(db, facets_mod, a, "purpose", "χαλάρωση")
    _tag(db, facets_mod, b, "purpose", "ύπνος")
    _tag(db, facets_mod, untouched, "mood", "γαλήνια")
    assert _ids(search.search(db, "purpose:*")) == {a.id, b.id}
    assert _ids(search.search(db, "-purpose:*")) == {untouched.id}


def test_missing_facet_falls_through_to_free_text(db):
    a, b = _mk(db, "/a.mp3", title="A"), _mk(db, "/b.mp3", title="B")
    assert _ids(search.search(db, "-purpose:*")) == {a.id, b.id}


def test_folder_token_windows_paths(db):
    a = _mk(db, "C:\\Music\\Relax\\a.mp3", title="a")
    b = _mk(db, "/Users/x/Music/Relax/b.mp3", title="b")
    c = _mk(db, "C:\\Music\\Relaxation\\c.mp3", title="c")
    assert _ids(search.search(db, 'folder:"C:/Music/Relax/"')) == {a.id}
    assert _ids(search.search(db, 'folder:"c:\\music\\relax\\"')) == {a.id}
    assert _ids(search.search(db, "folder:relax")) == {a.id, b.id, c.id}


def test_valence_range(db):
    tracks = {v: _mk(db, f"/{v}.mp3", title=str(v), valence=v) for v in (5, 6, 7, 8, 9)}
    assert _ids(search.search(db, "valence:6-8")) == {tracks[v].id for v in (6, 7, 8)}
    assert _ids(search.search(db, "valence:7+")) == {tracks[v].id for v in (7, 8, 9)}
