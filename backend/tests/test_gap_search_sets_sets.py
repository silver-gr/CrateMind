"""Set gaps a DJ hits while building live: adding to another set, positions
after a removal, reorder over gaps, repeat deletes, log-play with repeats,
and what a set delete leaves of the history."""
from __future__ import annotations

import pytest
from sqlmodel import Session, select

from app.models import PlayEvent, SetTrack, Track


def _tracks(*names: str) -> list[int]:
    from app.db import get_engine

    with Session(get_engine(), expire_on_commit=False) as session:
        rows = [Track(absolute_path=f"/fx/{n}.wav", file_name=f"{n}.wav", title=n, artist="Fixture", missing=False)
                for n in names]
        session.add_all(rows)
        session.commit()
        return [t.id for t in rows]


def _set(client, title="Πανσέληνος") -> int:
    r = client.post("/api/sets", json={"title": title})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _add(client, set_id, track_id, **extra):
    return client.post(f"/api/sets/{set_id}/tracks", json={"track_id": track_id, **extra})


def _rows(client, set_id) -> list[tuple[int, int, str | None]]:
    body = client.get(f"/api/sets/{set_id}").json()
    return [(row["position"], row["track"]["id"], row["note"]) for row in body["tracks"]]


def test_adding_to_another_set_appends_there_and_leaves_the_source(client):
    a, b, c = _tracks("a", "b", "c")
    source, other = _set(client, "Πηγή"), _set(client, "Άλλο")
    for t in (a, b):
        assert _add(client, source, t).status_code == 200
    assert _add(client, other, c).json()["position"] == 0

    r = _add(client, other, b)
    assert r.json() == {"set_id": other, "position": 1, "track_id": b}
    assert _rows(client, source) == [(0, a, None), (1, b, None)]
    assert _rows(client, other) == [(0, c, None), (1, b, None)]
    # the same track again in the same set is a new occurrence at the end
    assert _add(client, other, b, note="ξανά").json()["position"] == 2
    assert _rows(client, other)[-1] == (2, b, "ξανά")


def test_add_after_removing_the_middle_track_never_reuses_a_position(client):
    a, b, c, d = _tracks("a", "b", "c", "d")
    sid = _set(client)
    for t in (a, b, c):
        _add(client, sid, t)
    assert client.delete(f"/api/sets/{sid}/tracks/{b}", params={"position": 1}).status_code == 200
    assert _add(client, sid, d).json()["position"] == 3
    assert [t for _p, t, _n in _rows(client, sid)] == [a, c, d]


def test_add_after_removing_the_last_track_continues_from_the_new_last(client):
    a, b, c = _tracks("a", "b", "c")
    sid = _set(client)
    for t in (a, b):
        _add(client, sid, t)
    client.delete(f"/api/sets/{sid}/tracks/{b}", params={"position": 1})
    assert _add(client, sid, c).json()["position"] == 1
    client.delete(f"/api/sets/{sid}/tracks/{a}", params={"position": 0})
    client.delete(f"/api/sets/{sid}/tracks/{c}", params={"position": 1})
    assert _rows(client, sid) == []
    assert _add(client, sid, a).json()["position"] == 0


@pytest.mark.parametrize("set_exists, track_exists", [(False, True), (True, False)])
def test_add_to_a_missing_set_or_a_missing_track_is_404_and_writes_nothing(client, set_exists, track_exists):
    (a,) = _tracks("a")
    sid = _set(client) if set_exists else 999
    r = _add(client, sid, a if track_exists else 999)
    assert r.status_code == 404
    from app.db import get_engine

    with Session(get_engine()) as session:
        assert session.exec(select(SetTrack)).all() == []


def test_reorder_over_gaps_compacts_positions_and_keeps_notes(client):
    a, b, c, d = _tracks("a", "b", "c", "d")
    sid = _set(client)
    _add(client, sid, a)
    _add(client, sid, b, note="drop")
    _add(client, sid, c)
    _add(client, sid, d, note="κλείσιμο")
    client.delete(f"/api/sets/{sid}/tracks/{c}", params={"position": 2})
    assert [p for p, _t, _n in _rows(client, sid)] == [0, 1, 3]

    r = client.patch(f"/api/sets/{sid}/tracks/reorder",
                     json={"ordered_track_ids": [d, a, b], "ordered_positions": [3, 0, 1]})
    assert r.status_code == 200, r.text
    assert _rows(client, sid) == [(0, d, "κλείσιμο"), (1, a, None), (2, b, "drop")]
    # a later add follows the compacted positions
    assert _add(client, sid, c).json()["position"] == 3


def test_reorder_to_the_same_order_is_idempotent(client):
    a, b = _tracks("a", "b")
    sid = _set(client)
    _add(client, sid, a, note="άνοιγμα")
    _add(client, sid, b)
    before = _rows(client, sid)
    for _ in range(2):
        r = client.patch(f"/api/sets/{sid}/tracks/reorder", json={"ordered_track_ids": [a, b], "ordered_positions": [0, 1]})
        assert r.status_code == 200
        assert _rows(client, sid) == before


def test_reorder_of_an_empty_set_succeeds_and_a_nonempty_payload_is_stale(client):
    (a,) = _tracks("a")
    sid = _set(client)
    assert client.patch(f"/api/sets/{sid}/tracks/reorder", json={"ordered_track_ids": []}).status_code == 200
    assert client.patch(f"/api/sets/{sid}/tracks/reorder", json={"ordered_track_ids": [a]}).status_code == 409
    assert client.patch("/api/sets/999/tracks/reorder", json={"ordered_track_ids": []}).status_code == 404


def test_deleting_a_set_twice_and_using_it_afterwards(client):
    a, b = _tracks("a", "b")
    sid = _set(client)
    _add(client, sid, a)
    _add(client, sid, a)
    _add(client, sid, b)
    first = client.delete(f"/api/sets/{sid}")
    assert first.json() == {"deleted": True, "set_id": sid, "track_count": 3}   # repeats count
    assert client.delete(f"/api/sets/{sid}").status_code == 404
    assert client.get(f"/api/sets/{sid}").status_code == 404
    assert _add(client, sid, a).status_code == 404
    assert client.post(f"/api/sets/{sid}/log-play", json={}).status_code == 404
    assert all(s["id"] != sid for s in client.get("/api/sets").json())


def test_log_play_counts_every_occurrence_and_a_set_delete_keeps_the_history(client):
    a, b = _tracks("a", "b")
    sid = _set(client)
    for t in (a, b, a):
        _add(client, sid, t)
    assert client.post(f"/api/sets/{sid}/log-play", json={"context": "πρόβα"}).json() == {
        "set_id": sid, "tracks_logged": 3}
    from app.db import get_engine

    with Session(get_engine()) as session:
        assert (session.get(Track, a).play_count, session.get(Track, b).play_count) == (2, 1)

    assert client.delete(f"/api/sets/{sid}").status_code == 200
    history = client.get("/api/history").json()["plays"]
    assert sorted(p["track_id"] for p in history) == sorted([a, a, b])
    assert {p["set_id"] for p in history} == {None}
    with Session(get_engine()) as session:
        # deleting a set never lowers play counts or removes plays
        assert (session.get(Track, a).play_count, session.get(Track, b).play_count) == (2, 1)
        assert len(session.exec(select(PlayEvent)).all()) == 3


def test_sets_list_newest_first_and_keep_unicode_titles(client):
    first = _set(client, "Σετ Πανσέληνος 🌕")
    second = _set(client, "Ψυχεδέλεια · Ά")
    listed = client.get("/api/sets").json()
    assert [s["id"] for s in listed[:2]] == [second, first]
    assert [s["title"] for s in listed[:2]] == ["Ψυχεδέλεια · Ά", "Σετ Πανσέληνος 🌕"]


def test_saved_from_history_then_deleted_keeps_the_plays(client):
    from datetime import UTC, datetime, timedelta

    a, b = _tracks("a", "b")
    start = datetime.now(UTC) - timedelta(hours=1)
    ids = []
    for n, t in enumerate((a, b)):
        r = client.post("/api/history/plays", json={
            "track_id": t, "deck": "AB"[n], "started_at": (start + timedelta(minutes=n)).isoformat(),
            "ended_at": (start + timedelta(minutes=n, seconds=45)).isoformat(), "played_seconds": 45})
        ids.append(r.json()["id"])
    saved = client.post("/api/history/save-set", json={"play_ids": ids, "title": "Χθες"}).json()
    assert client.delete(f"/api/sets/{saved['set_id']}").json()["track_count"] == 2
    assert sorted(p["id"] for p in client.get("/api/history").json()["plays"]) == sorted(ids)


def test_adding_at_a_taken_position_is_refused_not_a_server_error(client):
    a, b = _tracks("taken-a", "taken-b")
    set_id = _set(client)
    assert _add(client, set_id, a).status_code == 200
    r = _add(client, set_id, b, position=0)
    assert r.status_code == 409
    assert _rows(client, set_id) == [(0, a, None)]
    assert _add(client, set_id, b, position=1).status_code == 200
