"""Set analysis curves fall back to analyzed BPM when no tag BPM exists."""
from __future__ import annotations

import app.db as dbmod
from app.models import Track
from sqlmodel import Session


def _make_track(**kw) -> int:
    with Session(dbmod.get_engine()) as s:
        t = Track(missing=False, **kw)
        s.add(t)
        s.commit()
        s.refresh(t)
        return t.id


def test_bpm_curve_uses_analyzed_fallback(client):
    tid = _make_track(absolute_path="/only-analyzed.wav", bpm=None, bpm_analyzed=142.0)
    set_id = client.post("/api/sets", json={"title": "T"}).json()["id"]
    client.post(f"/api/sets/{set_id}/tracks", json={"track_id": tid})
    analysis = client.get(f"/api/sets/{set_id}/analysis").json()
    assert analysis["bpm_curve"] == [142.0]
