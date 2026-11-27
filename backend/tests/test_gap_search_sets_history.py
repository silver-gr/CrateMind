"""History keyset paging gaps: legacy rows without a time, adopted rows in
another text form, time zones, exact page boundaries and deletes between pages."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone

import pytest
from sqlalchemy import text
from sqlmodel import Session

from app.models import Track


def _track(name="a") -> int:
    from app.db import get_engine

    with Session(get_engine(), expire_on_commit=False) as session:
        track = Track(absolute_path=f"/h/{name}.wav", file_name=f"{name}.wav", title=name, missing=False)
        session.add(track)
        session.commit()
        return track.id


def _play(client, track_id, start: datetime, seconds=40.0) -> int:
    r = client.post("/api/history/plays", json={
        "track_id": track_id, "deck": "A", "started_at": start.isoformat(),
        "ended_at": (start + timedelta(seconds=seconds)).isoformat(), "played_seconds": seconds})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _raw(track_id, played_at) -> int:
    from app.db import get_engine

    with Session(get_engine()) as session:
        session.execute(text("INSERT INTO play_events (track_id, played_at) VALUES (:t, :p)"),
                        {"t": track_id, "p": played_at})
        session.commit()
        return session.execute(text("SELECT max(id) FROM play_events")).scalar_one()


def _walk(client, limit) -> list[int]:
    seen, before = [], None
    for _ in range(100):
        page = client.get("/api/history", params={"limit": limit, **({"before_id": before} if before else {})})
        assert page.status_code == 200, page.text
        body = page.json()
        seen += [p["id"] for p in body["plays"]]
        if not body["has_more"]:
            return seen
        before = seen[-1]
    raise AssertionError("paging never ended")


@pytest.mark.parametrize("limit", [1, 2, 3, 7])
def test_pages_through_legacy_rows_without_a_time_and_adopted_text_forms(client, limit):
    tid = _track()
    base = datetime(2026, 11, 20, 22, 0, tzinfo=UTC)
    recent = [_play(client, tid, base + timedelta(minutes=m)) for m in (0, 5, 10)]
    no_time = [_raw(tid, None), _raw(tid, None)]
    # an adopted 'T…Z' row between the second and third recorded play
    adopted = _raw(tid, "2026-11-20T22:07:00Z")
    whole = client.get("/api/history").json()["plays"]
    # newest first by the instant; rows without a time go last, newest id first
    expected = [recent[2], adopted, recent[1], recent[0]] + sorted(no_time, reverse=True)
    assert [p["id"] for p in whole] == expected
    assert _walk(client, limit) == expected


def test_orders_by_the_instant_whatever_the_offset_it_was_sent_with(client):
    tid = _track()
    athens = timezone(timedelta(hours=2))
    # 12:00 in Athens is 10:00 UTC, so the 11:00 UTC play is the newer one
    early = _play(client, tid, datetime(2026, 11, 20, 12, 0, tzinfo=athens))
    later = _play(client, tid, datetime(2026, 11, 20, 11, 0, tzinfo=UTC))
    plays = client.get("/api/history").json()["plays"]
    assert [p["id"] for p in plays] == [later, early]
    assert datetime.fromisoformat(plays[1]["played_at"]).replace(tzinfo=UTC) == datetime(2026, 11, 20, 10, 0, tzinfo=UTC)
    assert _walk(client, 1) == [later, early]


@pytest.mark.parametrize("count, limit, has_more", [(3, 3, False), (3, 2, True), (1, 1, False), (4, 1000, False)])
def test_has_more_is_exact_at_the_page_boundary(client, count, limit, has_more):
    tid = _track()
    base = datetime(2026, 11, 20, 20, 0, tzinfo=UTC)
    for m in range(count):
        _play(client, tid, base + timedelta(minutes=m))
    body = client.get("/api/history", params={"limit": limit}).json()
    assert len(body["plays"]) == min(count, limit)
    assert body["has_more"] is has_more


def test_an_empty_history_and_the_limit_bounds(client):
    assert client.get("/api/history").json() == {"plays": [], "has_more": False}
    assert client.get("/api/history", params={"limit": 1000}).status_code == 200
    assert client.get("/api/history", params={"limit": 1001}).status_code == 422


def test_deleting_plays_between_pages_neither_skips_nor_repeats(client):
    a, b = _track("a"), _track("b")
    base = datetime(2026, 11, 21, 23, 0, tzinfo=UTC)
    ids = [_play(client, a if m % 2 else b, base + timedelta(minutes=m)) for m in range(6)]
    newest_first = ids[::-1]
    first = client.get("/api/history", params={"limit": 2}).json()
    assert [p["id"] for p in first["plays"]] == newest_first[:2]
    # delete one shown play and one not yet shown; the cursor play still exists
    assert client.post("/api/history/delete", json={"ids": [newest_first[0], newest_first[3]]}).json() == {"deleted": 2}
    rest = client.get("/api/history", params={"limit": 10, "before_id": newest_first[1]}).json()
    assert [p["id"] for p in rest["plays"]] == [newest_first[2], newest_first[4], newest_first[5]]
    assert rest["has_more"] is False
    # the deleted cursor play is gone: the documented 404 asks for a reload
    assert client.get("/api/history", params={"before_id": newest_first[0]}).status_code == 404


def test_same_instant_plays_page_by_id_and_carry_their_own_track(client):
    a, b, c = _track("a"), _track("b"), _track("c")
    at = datetime(2026, 11, 22, 1, 30, tzinfo=UTC)
    ids = [_play(client, t, at) for t in (a, b, c)]
    pages = []
    before = None
    for _ in range(3):
        body = client.get("/api/history", params={"limit": 1, **({"before_id": before} if before else {})}).json()
        pages.append((body["plays"][0]["id"], body["plays"][0]["track"]["id"]))
        before = body["plays"][0]["id"]
    assert pages == [(ids[2], c), (ids[1], b), (ids[0], a)]
