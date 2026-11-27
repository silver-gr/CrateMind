"""Tuned transitions held by another set for this set's neighbouring pairs (read-only, hermetic fixtures)."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlmodel import Session, select

from app.models import AuditLog, SetTransition
from tests.test_set_transitions import _body, _engine, _set, _track


def _tracks(n: int) -> list[int]:
    return [_track(bpm=140.0, key_text="9A", duration=300.0) for _ in range(n)]


def _save(client, set_id: int, a: int, b: int, **kw) -> dict:
    response = client.post(f"/api/sets/{set_id}/transitions", json=_body(a, b, **kw))
    assert response.status_code == 200
    return response.json()


def _age(set_id: int, a: int, b: int, days: int) -> None:
    with Session(_engine()) as session:
        row = session.exec(select(SetTransition).where(SetTransition.set_id == set_id,
                                                       SetTransition.from_track_id == a,
                                                       SetTransition.to_track_id == b)).one()
        row.updated_at = datetime.now(UTC) - timedelta(days=days)
        session.add(row)
        session.commit()


def _elsewhere(client, set_id: int) -> list[dict]:
    response = client.get(f"/api/sets/{set_id}/transitions/elsewhere")
    assert response.status_code == 200
    return response.json()["pairs"]


def test_only_the_same_ordered_neighbouring_pair_is_offered(client):
    a, b, c = _tracks(3)
    here = _set(client, [a, b, c], "Εδώ")
    reversed_pair = _set(client, [b, a], "Ανάποδα")
    _save(client, reversed_pair, b, a, preset="slam", bars=1)
    not_adjacent = _set(client, [b, a, c], "Μακριά")
    _save(client, not_adjacent, a, c)            # saved, then the pair stopped being neighbours
    assert _elsewhere(client, here) == []

    source = _set(client, [c, a, b], "Πηγή")
    _save(client, source, a, b, preset="blend", bars=16, out_anchor_s=200.0, in_anchor_s=1.5)
    pairs = _elsewhere(client, here)
    assert [(p["from_track_id"], p["to_track_id"]) for p in pairs] == [(a, b)]
    offer = pairs[0]
    assert offer["source_set_id"] == source and offer["source_set_title"] == "Πηγή"
    assert offer["transition"] == {"preset": "blend", "bars": 16, "volume_curve": "overlap",
                                   "eq_curve": "three_band", "filter_curve": "none", "loop_beats": None,
                                   "out_anchor_s": 200.0, "in_anchor_s": 1.5, "tempo_match": True}
    assert offer["updated_at"]
    assert client.get("/api/sets/9999/transitions/elsewhere").status_code == 404


def test_newest_wins_and_the_same_set_is_excluded(client):
    a, b = _tracks(2)
    here = _set(client, [a, b], "Εδώ")
    _save(client, here, a, b, preset="slam", bars=1)          # this set's own row is never offered
    old = _set(client, [a, b], "Παλιό")
    new = _set(client, [a, b], "Νέο")
    _save(client, new, a, b, preset="fade", bars=4)
    _save(client, old, a, b, preset="melt", bars=8)
    _age(new, a, b, days=1)
    _age(old, a, b, days=3)
    _age(here, a, b, days=0)
    [offer] = _elsewhere(client, here)
    assert (offer["source_set_id"], offer["transition"]["preset"]) == (new, "fade")
    [offer] = _elsewhere(client, new)
    assert offer["source_set_id"] == here                     # the other sets, newest first


def test_deleted_sets_and_bare_auto_rows_are_not_offered(client):
    a, b = _tracks(2)
    here = _set(client, [a, b])
    bare = _set(client, [a, b], "Χωρίς ρύθμιση")
    _save(client, bare, a, b, preset="auto")                  # equal to the unsaved Auto: nothing to carry
    assert _elsewhere(client, here) == []
    gone = _set(client, [a, b], "Διαγραμμένο")
    _save(client, gone, a, b, preset="wave")
    assert [p["source_set_id"] for p in _elsewhere(client, here)] == [gone]
    assert client.delete(f"/api/sets/{gone}").status_code == 200
    assert _elsewhere(client, here) == []
    anchored = _set(client, [a, b], "Με σημεία")
    _save(client, anchored, a, b, preset="auto", out_anchor_s=100.0, in_anchor_s=0.0)
    assert [p["source_set_id"] for p in _elsewhere(client, here)] == [anchored]


def test_a_pair_twice_is_offered_once_and_nothing_is_written(client):
    a, b = _tracks(2)
    here = _set(client, [a, b, a, b])
    source = _set(client, [a, b], "Πηγή")
    _save(client, source, a, b, preset="rise")
    with Session(_engine()) as session:
        before = (len(session.exec(select(SetTransition)).all()), len(session.exec(select(AuditLog)).all()))
    assert [(p["from_track_id"], p["to_track_id"]) for p in _elsewhere(client, here)] == [(a, b)]
    with Session(_engine()) as session:
        after = (len(session.exec(select(SetTransition)).all()), len(session.exec(select(AuditLog)).all()))
    assert after == before


def test_using_an_offer_makes_an_independent_copy(client):
    a, b = _tracks(2)
    here = _set(client, [a, b])
    source = _set(client, [a, b], "Πηγή")
    original = _save(client, source, a, b, preset="blend", bars=16, out_anchor_s=120.0, in_anchor_s=2.0)
    [offer] = _elsewhere(client, here)
    copy = _save(client, here, a, b, **offer["transition"])  # what «Χρήση» posts
    assert copy["persisted"] and copy["id"] != original["id"] and copy["set_id"] == here
    _save(client, here, a, b, preset="slam", bars=1)          # editing the copy leaves the source alone
    source_rows = client.get(f"/api/sets/{source}/transitions").json()["transitions"]
    assert (source_rows[0]["preset"], source_rows[0]["bars"], source_rows[0]["updated_at"]) == \
        ("blend", 16, original["updated_at"])
