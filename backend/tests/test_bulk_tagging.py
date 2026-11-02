"""Transactional bulk edit: tags, query scope, diff audit, one commit."""
from __future__ import annotations

import hashlib
import json

import pytest
from sqlalchemy import event, func
from sqlmodel import Session, select

from app.db import reindex_track
from app.models import AuditLog, Tag, Track, TrackDJProfile, TrackTag
from app.services import facets, search
from tests.conftest import make_wav


def _engine():
    import app.db as dbmod

    return dbmod.get_engine()


def _tracks(n: int, title: str = "Track {i}", profile: dict | None = None, paths=None) -> list[int]:
    with Session(_engine()) as session:
        rows = [Track(absolute_path=str(paths[i]) if paths else f"/bulk/{title.format(i=i)}.mp3",
                      title=title.format(i=i)) for i in range(n)]
        session.add_all(rows)
        session.commit()
        for row in rows:
            if profile:
                session.add(TrackDJProfile(track_id=row.id, **profile))
        session.commit()
        for row in rows:
            reindex_track(session, row.id, commit=False)
        session.commit()
        return [row.id for row in rows]


def _purpose_value() -> int:
    with Session(_engine()) as session:
        facets.seed_preset(session, "therapy")
        return session.exec(select(Tag.id).where(Tag.name == "purpose:χαλάρωση")).one()


def _voice() -> tuple[int, int]:
    with Session(_engine()) as session:
        voice = facets.create_facet(session, "Τραγουδιστής", False, key="vox")
        a, b = facets.add_value(session, voice.id, "Α"), facets.add_value(session, voice.id, "Β")
        return a.id, b.id


def _snapshot():
    with Session(_engine()) as session:
        return (
            sorted((r.track_id, r.tag_id) for r in session.exec(select(TrackTag)).all()),
            sorted((p.track_id, p.energy, p.valence) for p in session.exec(select(TrackDJProfile)).all()),
            session.execute(select(func.count()).select_from(AuditLog)).scalar_one(),
        )


def _batch(client, body):
    return client.post("/api/tracks/batch-profile", json=body)


def test_tag_only_bulk_creates_no_profiles(client):
    ids = _tracks(3)
    value = _purpose_value()
    r = _batch(client, {"track_ids": ids, "add_tag_ids": [value]})
    assert r.status_code == 200, r.text
    assert r.json()["updated"] == 3
    with Session(_engine()) as session:
        assert session.exec(select(TrackDJProfile)).all() == []
        assert len(search.search(session, "untagged")) == 3
        assert {t.id for t in search.search(session, "χαλαρωση")} == set(ids)


def test_one_commit_and_diff_audit_rows(client):
    ids = _tracks(2, profile={"energy": 5})
    value = _purpose_value()
    commits = []
    listener = lambda _conn: commits.append(1)  # noqa: E731
    event.listen(_engine(), "commit", listener)
    try:
        r = _batch(client, {"track_ids": ids, "profile": {"energy": 8}, "add_tag_ids": [value]})
    finally:
        event.remove(_engine(), "commit", listener)
    assert r.status_code == 200, r.text
    assert len(commits) == 1
    with Session(_engine()) as session:
        rows = session.exec(select(AuditLog).where(AuditLog.action == "batch_update")).all()
    assert sorted(row.entity_id for row in rows) == sorted(ids)
    for row in rows:
        assert json.loads(row.before_json) == {"energy": 5}
        assert json.loads(row.after_json) == {"energy": 8, "tags_added": [value]}
        assert len(row.before_json) + len(row.after_json) < 200

    a, b = _voice()
    _batch(client, {"track_ids": ids[:1], "add_tag_ids": [a]})
    _batch(client, {"track_ids": ids[:1], "add_tag_ids": [b]})
    with Session(_engine()) as session:
        last = session.exec(select(AuditLog).where(AuditLog.action == "batch_update").order_by(AuditLog.id.desc())).first()
    assert json.loads(last.before_json) == {"tags_removed": [a]}
    assert json.loads(last.after_json) == {"tags_added": [b]}


def test_single_value_replace_count_and_dry_run(client):
    t1, t2, t3 = _tracks(3)
    a, b = _voice()
    _batch(client, {"track_ids": [t1], "add_tag_ids": [a]})
    _batch(client, {"track_ids": [t3], "add_tag_ids": [b]})
    before = _snapshot()
    r = _batch(client, {"track_ids": [t1, t2, t3], "add_tag_ids": [a], "dry_run": True})
    assert r.json() == {"updated": 0, "matched": 3, "replaced": 1, "dry_run": True}
    assert _snapshot() == before
    r = _batch(client, {"track_ids": [t1, t2, t3], "add_tag_ids": [a]})
    assert r.json() == {"updated": 3, "matched": 3, "replaced": 1, "dry_run": False}
    with Session(_engine()) as session:
        assert sorted(session.exec(select(TrackTag.tag_id).where(TrackTag.track_id == t3)).all()) == [a]


def test_query_scope_resolved_by_subquery(client, low_variable_limit):
    _tracks(150, title="Ambient {i}")
    value = _purpose_value()
    r = _batch(client, {"query": "ambient", "add_tag_ids": [value]})
    assert r.status_code == 200, r.text
    assert r.json()["matched"] == 150


def test_unresolvable_requests_write_nothing(client):
    ids = _tracks(2)
    a, b = _voice()
    before = _snapshot()
    cases = [
        ({"track_ids": ids, "add_tag_ids": [999999]}, 404, "Άγνωστο tag."),
        ({"track_ids": ids, "query": "x", "add_tag_ids": [a]}, 422, "Δώσε είτε κομμάτια είτε αναζήτηση."),
        ({"add_tag_ids": [a]}, 422, "Δώσε είτε κομμάτια είτε αναζήτηση."),
        ({"track_ids": ids}, 422, "Δεν ζητήθηκε καμία αλλαγή."),
        ({"track_ids": ids, "profile": {}}, 422, "Δεν ζητήθηκε καμία αλλαγή."),
        ({"track_ids": ids, "add_tag_ids": [a, b]}, 422, None),
    ]
    for body, status, detail in cases:
        r = _batch(client, body)
        assert r.status_code == status, (body, r.text)
        if detail:
            assert r.json()["detail"] == detail
        assert _snapshot() == before, body
    r = _batch(client, {"query": "nothingmatcheshere", "add_tag_ids": [a]})
    assert r.status_code == 200 and r.json()["updated"] == 0
    assert _snapshot() == before


def test_one_audit_row_and_one_reindex_per_track(client, monkeypatch):
    import app.db as dbmod

    ids = _tracks(3)
    value = _purpose_value()
    calls = []
    real = dbmod.reindex_track

    def spy(session, track_id, **kwargs):
        calls.append(track_id)
        return real(session, track_id, **kwargs)

    monkeypatch.setattr(dbmod, "reindex_track", spy)
    r = _batch(client, {"track_ids": ids, "profile": {"energy": 4}, "add_tag_ids": [value]})
    assert r.status_code == 200, r.text
    assert sorted(calls) == sorted(ids)
    with Session(_engine()) as session:
        assert len(session.exec(select(AuditLog).where(AuditLog.action == "batch_update")).all()) == 3


def test_failure_mid_batch_rolls_back_everything(client, monkeypatch):
    ids = _tracks(3)
    value = _purpose_value()
    before = _snapshot()
    real = facets.apply_tag_changes
    calls = []

    def flaky(*args, **kwargs):
        calls.append(1)
        if len(calls) == 2:
            raise RuntimeError("boom")
        return real(*args, **kwargs)

    monkeypatch.setattr(facets, "apply_tag_changes", flaky)
    with pytest.raises(RuntimeError):
        _batch(client, {"track_ids": ids, "profile": {"energy": 3}, "add_tag_ids": [value]})
    assert _snapshot() == before


def test_empty_query_scope_is_whole_library(client):
    _tracks(4)
    value = _purpose_value()
    r = _batch(client, {"query": "", "add_tag_ids": [value], "dry_run": True})
    assert r.json()["matched"] == 4


def test_bulk_never_touches_audio_files(client, tmp_path):
    paths = [make_wav(tmp_path / "lib" / f"{i}.wav", freq_seed=i + 1) for i in range(2)]
    ids = _tracks(2, paths=paths)
    value = _purpose_value()

    def fingerprint():
        return [(hashlib.sha256(p.read_bytes()).hexdigest(), p.stat().st_mtime_ns) for p in paths]

    before = fingerprint()
    r = _batch(client, {"track_ids": ids, "profile": {"energy": 7, "valence": 3}, "add_tag_ids": [value]})
    assert r.status_code == 200, r.text
    assert fingerprint() == before


def test_legacy_clients_unchanged(client):
    ids = _tracks(2)
    r = _batch(client, {"track_ids": ids, "profile": {"energy": 6}})
    assert r.status_code == 200, r.text
    assert r.json()["updated"] == 2
    with Session(_engine()) as session:
        assert sorted(p.energy for p in session.exec(select(TrackDJProfile)).all()) == [6, 6]
