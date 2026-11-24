"""Deck rescue: one JSON file in the catalog's cache folder, validated on the way in and on the way out."""
from __future__ import annotations

import copy
import json
import time

import pytest

from app.api import deck_rescue


def _deck(track_id=7, **patch):
    return {"track_id": track_id, "position_s": 61.25, "pitch": 0.25, "range": 0.16, "keylock": True,
            "eq": {"hi": 0, "mid": -0.5, "lo": 1}, "filter": 0, "trim": 0.1,
            "loop": {"start_s": 60, "end_s": 62}, **patch}


def _body(**patch):
    return {"v": 1, "decks": {"A": _deck(), "B": None},
            "mixer": {"volume": {"A": 1, "B": 0.5}, "crossfader": -1, "master": 0.8}, **patch}


def _files(root):
    return {str(p.relative_to(root)) for p in root.rglob("*") if p.is_file()}


def test_round_trip_writes_one_file_in_the_cache_folder(client, tmp_path):
    assert client.get("/api/deck-rescue").json() == {"snapshot": None, "age_s": None}
    before = _files(tmp_path)
    assert client.post("/api/deck-rescue", json=_body()).status_code == 204
    # Only the snapshot is new: no temp file is left, and nothing lands outside the cache folder.
    assert _files(tmp_path) - before == {"cache/deck-rescue.json"}
    got = client.get("/api/deck-rescue").json()
    saved_at = got["snapshot"].pop("saved_at")
    assert got["snapshot"] == _body() and abs(saved_at - time.time()) < 5 and 0 <= got["age_s"] < 5
    # A second write replaces the file in place.
    assert client.post("/api/deck-rescue", json=_body(decks={"A": None, "B": _deck(9, loop=None)})).status_code == 204
    assert _files(tmp_path) - before == {"cache/deck-rescue.json"}
    assert client.get("/api/deck-rescue").json()["snapshot"]["decks"] == {"A": None, "B": _deck(9, loop=None)}
    assert client.delete("/api/deck-rescue").status_code == 204
    assert client.delete("/api/deck-rescue").status_code == 204  # idempotent
    assert _files(tmp_path) - before == set()
    assert client.get("/api/deck-rescue").json() == {"snapshot": None, "age_s": None}


def test_expired_or_unreadable_file_reads_as_nothing_and_is_left_alone(client, tmp_path):
    path = tmp_path / "cache" / "deck-rescue.json"
    assert client.post("/api/deck-rescue", json=_body()).status_code == 204
    saved = json.loads(path.read_text())

    def served(value) -> bool:
        path.write_text(value if isinstance(value, str) else json.dumps(value))
        answer = client.get("/api/deck-rescue").json()
        assert path.is_file()  # GET never deletes
        return answer["snapshot"] is not None

    assert served(saved)
    assert not served({**saved, "saved_at": time.time() - deck_rescue.MAX_AGE_S - 60})
    assert served({**saved, "saved_at": time.time() - deck_rescue.MAX_AGE_S + 60})
    # A clock that was set back: the snapshot counts as just saved.
    path.write_text(json.dumps({**saved, "saved_at": time.time() + 3600}))
    assert client.get("/api/deck-rescue").json()["age_s"] == 0
    assert not served("{not json")
    assert not served({**saved, "v": 2})
    assert not served({**saved, "extra": 1})
    assert not served(json.dumps(saved) + " " * deck_rescue.MAX_BYTES)


@pytest.mark.parametrize("change", [
    lambda b: b.update(extra=1),
    lambda b: b.update(v=2),
    lambda b: b["decks"].update(A=None),  # no deck holds a track
    lambda b: b["decks"]["A"].update(playing=True),
    lambda b: b["decks"]["A"].update(track_id=0),
    lambda b: b["decks"]["A"].update(pitch=1.5),
    lambda b: b["decks"]["A"].update(range=0.1),
    lambda b: b["decks"]["A"].update(position_s=-1),
    lambda b: b["decks"]["A"].update(position_s=None),  # what JSON.stringify sends for NaN or Infinity
    lambda b: b["decks"]["A"].update(loop={"start_s": 5, "end_s": 5}),
    lambda b: b["decks"]["A"]["eq"].update(lo=-2),
    lambda b: b["mixer"].update(master=1.2),
    lambda b: b["mixer"]["volume"].pop("B"),
])
def test_invalid_snapshot_is_refused_and_writes_nothing(client, tmp_path, change):
    body = copy.deepcopy(_body())
    change(body)
    assert client.post("/api/deck-rescue", json=body).status_code == 422
    assert not (tmp_path / "cache" / "deck-rescue.json").exists()

