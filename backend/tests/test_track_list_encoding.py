"""GET /api/tracks returns its rows without FastAPI's second jsonable_encoder pass: the body must stay byte for byte
what that pass rendered, NaN, datetimes and nulls included."""
from __future__ import annotations

import json
from datetime import UTC, datetime

from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from sqlmodel import Session

from app.api.tracks import _list_payload
from app.models import Track, TrackDJProfile


def test_list_body_is_what_the_encoder_pass_rendered(client):
    import app.db as dbmod

    with Session(dbmod.get_engine()) as s:
        a = Track(absolute_path="/fixture/a.mp3", file_name="a.mp3", extension=".mp3", title="Ωδή – «Infinity» NaN",
                  artist="Άρτιστ", bpm=float("nan"), loudness_lufs=-9.25, play_count=3, missing=False,
                  last_played_at=datetime(2026, 11, 28, 1, 2, 3, 456789, tzinfo=UTC), analyzed_at=datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC))
        b = Track(absolute_path="/fixture/b.mp3", file_name="b.mp3", extension=".mp3", title=None, play_count=0, missing=True)
        s.add_all([a, b])
        s.commit()
        s.add(TrackDJProfile(track_id=a.id, energy=7, personal_status="approved"))
        s.commit()
        tracks = [s.get(Track, a.id), s.get(Track, b.id)]
        payload = _list_payload(s, tracks)
        # The skipped pass changes nothing: the same rows render to the same bytes with or without it.
        expected = JSONResponse(jsonable_encoder(payload)).body
        assert JSONResponse(payload).body == expected

    # The row's key order may differ between two builds (set iteration), so the route is compared as parsed JSON, by id.
    body = client.get("/api/tracks?limit=10000").content
    by_id = lambda raw: sorted(json.loads(raw), key=lambda row: row["id"])  # noqa: E731
    assert by_id(body) == by_id(expected)
    assert b'"last_played_at":"2026-11-28T01:02:03.456789' in body
    assert b'"bpm":null' in body  # a NaN column is a null, as before
