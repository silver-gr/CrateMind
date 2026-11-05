"""Per-set transitions: routes, audit, cascade and backup (hermetic fixtures only)."""
from __future__ import annotations

import itertools
import json

import pytest
from sqlalchemy import text
from sqlmodel import Session, select

from app.models import AuditLog, DJSet, SetTrack, SetTransition, Track, TrackDJProfile
from app.services.set_transitions import PRESETS, PairInput, ProfileHints, resolve_auto

_paths = itertools.count()


def _engine():
    from app.db import get_engine
    return get_engine()


def _track(**kw) -> int:
    n = next(_paths)
    with Session(_engine(), expire_on_commit=False) as session:
        track = Track(absolute_path=f"/x/st-{n}.wav", file_name=f"st-{n}.wav", missing=False, **kw)
        session.add(track)
        session.commit()
        return track.id


def _set(client, track_ids: list[int], title: str = "Set") -> int:
    set_id = client.post("/api/sets", json={"title": title}).json()["id"]
    for tid in track_ids:
        assert client.post(f"/api/sets/{set_id}/tracks", json={"track_id": tid}).status_code == 200
    return set_id


@pytest.fixture
def three(client):
    a = _track(bpm=140.0, key_text="9A", duration=300.0)
    b = _track(bpm=141.0, key_text="9A", duration=280.0)
    c = _track(bpm=160.0, key_text="3B", duration=260.0)
    with Session(_engine()) as session:
        session.add(TrackDJProfile(track_id=c, transition_role="safe_blend"))
        session.commit()
    return _set(client, [a, b, c]), (a, b, c)


def _body(a: int, b: int, **kw) -> dict:
    return {"from_track_id": a, "to_track_id": b, "preset": "blend", "bars": 8,
            "volume_curve": "overlap", "eq_curve": "three_band", "filter_curve": "none", **kw}


def _list(client, set_id: int) -> list[dict]:
    response = client.get(f"/api/sets/{set_id}/transitions")
    assert response.status_code == 200
    return response.json()["transitions"]


def test_list_returns_auto_for_unsaved_pairs(client, three):
    set_id, (a, b, c) = three
    rows = _list(client, set_id)
    assert [(r["from_track_id"], r["to_track_id"]) for r in rows] == [(a, b), (b, c)]
    expected = [
        resolve_auto(PairInput(140.0, 141.0, "9A", "9A", None, None)),
        resolve_auto(PairInput(141.0, 160.0, "9A", "3B", None, ProfileHints("safe_blend", None, None))),
    ]
    for row, want in zip(rows, expected):
        assert row["persisted"] is False and row["id"] is None and row["updated_at"] is None
        assert row["set_id"] == set_id
        assert row["preset"] == "auto"
        assert row["resolved_preset"] in PRESETS and row["resolved_preset"] == want.preset
        assert row["out_anchor_s"] is None and row["in_anchor_s"] is None
        assert row["reasons"] and row["reasons"] == list(want.reasons)
        assert (row["bars"], row["volume_curve"], row["eq_curve"], row["filter_curve"], row["loop_beats"],
                row["tempo_match"]) == (want.bars, want.volume_curve, want.eq_curve, want.filter_curve,
                                        want.loop_beats, want.tempo_match)
    assert [r["resolved_preset"] for r in rows] == ["blend", "blend"]
    assert "profile_blend" in rows[1]["reasons"]
    assert client.get("/api/sets/9999/transitions").status_code == 404


def test_saved_auto_keeps_resolved_preset(client, three):
    set_id, (a, b, _c) = three
    url = f"/api/sets/{set_id}/transitions"
    saved = client.post(url, json=_body(a, b, preset="auto", out_anchor_s=200.5, in_anchor_s=0.25))
    assert saved.status_code == 200, saved.text
    out = saved.json()
    assert out["persisted"] is True and isinstance(out["id"], int) and out["updated_at"]
    assert out["preset"] == "auto" and out["resolved_preset"] == "blend"
    assert out["out_anchor_s"] == 200.5 and out["in_anchor_s"] == 0.25
    first = _list(client, set_id)[0]
    assert first["persisted"] is True and first["preset"] == "auto" and first["resolved_preset"] == "blend"
    assert first["out_anchor_s"] == 200.5 and first["reasons"]


def test_upsert_round_trip_and_validation(client, three):
    set_id, (a, b, c) = three
    url = f"/api/sets/{set_id}/transitions"
    first = client.post(url, json=_body(a, b))
    assert first.status_code == 200, first.text
    out = first.json()
    assert out["persisted"] is True and out["preset"] == "blend" and out["bars"] == 8
    assert out["resolved_preset"] is None and out["reasons"] == []
    again = client.post(url, json=_body(a, b, bars=4, loop_beats=16, tempo_match=False)).json()
    assert again["id"] == out["id"] and again["bars"] == 4 and again["loop_beats"] == 16
    assert again["tempo_match"] is False
    stored = _list(client, set_id)[0]
    assert stored["persisted"] is True and stored["bars"] == 4 and stored["id"] == out["id"]
    none = client.post(url, json=_body(b, c, preset="none", bars=0, volume_curve="center_cut",
                                      eq_curve="none")).json()
    assert none["preset"] == "none" and none["bars"] == 0
    for bad in (
        _body(a, b, bars=40),
        _body(a, b, bars=-1),
        _body(a, b, loop_beats=3),
        _body(a, b, bars=1, loop_beats=16),
        _body(a, b, preset="none", bars=2),
        _body(a, b, preset="fade", bars=0),
        _body(a, b, preset="bogus"),
        _body(a, b, volume_curve="bogus"),
        _body(a, b, out_anchor_s=300.0),     # from-track duration is 300 s
        _body(a, b, in_anchor_s=280.0),      # to-track duration is 280 s
        _body(a, b, out_anchor_s=-0.5),
    ):
        assert client.post(url, json=bad).status_code == 422, bad
    nan = json.dumps(_body(a, b, out_anchor_s=float("nan")))  # json.dumps writes a bare NaN
    assert client.post(url, content=nan, headers={"content-type": "application/json"}).status_code == 422
    outsider = _track(bpm=120.0)
    assert client.post(url, json=_body(a, outsider)).status_code == 404
    assert client.post("/api/sets/9999/transitions", json=_body(a, b)).status_code == 404
    assert client.delete(f"/api/sets/9999/transitions/{a}/{b}").status_code == 404
    assert _list(client, set_id)[0]["bars"] == 4


def test_delete_resets_to_auto(client, three):
    set_id, (a, b, _c) = three
    assert client.post(f"/api/sets/{set_id}/transitions", json=_body(a, b, preset="slam", bars=1,
                                                                      volume_curve="center_cut",
                                                                      eq_curve="bass_cut_quick")).status_code == 200
    url = f"/api/sets/{set_id}/transitions/{a}/{b}"
    assert client.delete(url).json() == {"removed": True}
    assert client.delete(url).json() == {"removed": False}
    first = _list(client, set_id)[0]
    assert first["persisted"] is False and first["preset"] == "auto" and first["resolved_preset"] == "blend"


def test_reorder_keeps_transition_by_pair(client, three):
    set_id, (a, b, c) = three
    assert client.post(f"/api/sets/{set_id}/transitions",
                       json=_body(a, b, preset="slam", bars=1, volume_curve="center_cut",
                                  eq_curve="bass_cut_quick")).status_code == 200
    reorder = f"/api/sets/{set_id}/tracks/reorder"
    assert client.patch(reorder, json={"ordered_track_ids": [c, a, b]}).status_code == 200
    rows = _list(client, set_id)
    assert [(r["from_track_id"], r["to_track_id"], r["persisted"]) for r in rows] == [
        (c, a, False), (a, b, True)]
    assert rows[1]["preset"] == "slam"
    # The pair is no longer adjacent: its row is kept but ignored on read.
    assert client.patch(reorder, json={"ordered_track_ids": [b, a, c]}).status_code == 200
    assert [r["persisted"] for r in _list(client, set_id)] == [False, False]
    with Session(_engine()) as session:
        assert len(session.exec(select(SetTransition)).all()) == 1


def test_track_delete_cascades(client, three):
    set_id, (a, b, c) = three
    url = f"/api/sets/{set_id}/transitions"
    assert client.post(url, json=_body(a, b)).status_code == 200
    assert client.post(url, json=_body(b, c)).status_code == 200
    with Session(_engine()) as session:
        session.exec(text("PRAGMA foreign_keys=ON"))
        # set_tracks.track_id has no cascade: remove the membership first.
        session.exec(text("DELETE FROM set_tracks WHERE track_id = :i").bindparams(i=a))
        session.exec(text("DELETE FROM tracks WHERE id = :i").bindparams(i=a))
        session.commit()
        remaining = session.exec(select(SetTransition)).all()
        assert [(r.from_track_id, r.to_track_id) for r in remaining] == [(b, c)]


def test_audit_rows_written(client, three):
    set_id, (a, b, _c) = three
    assert client.post(f"/api/sets/{set_id}/transitions", json=_body(a, b)).status_code == 200
    assert client.post(f"/api/sets/{set_id}/transitions", json=_body(a, b, bars=4)).status_code == 200
    assert client.delete(f"/api/sets/{set_id}/transitions/{a}/{b}").json() == {"removed": True}
    with Session(_engine()) as session:
        rows = session.exec(select(AuditLog).where(AuditLog.entity_type == "set_transition")
                            .order_by(AuditLog.id)).all()
    assert [r.action for r in rows] == ["set_transition_update", "set_transition_update",
                                        "set_transition_delete"]
    assert rows[0].before_json is None and '"bars": 8' in rows[0].after_json
    assert '"bars": 8' in rows[1].before_json and '"bars": 4' in rows[1].after_json
    assert '"bars": 4' in rows[2].before_json and rows[2].after_json is None


def test_backup_round_trip(client, three):
    from app.services.backup import _export_metadata
    from app.services.legacy_import import import_metadata

    set_id, (a, b, c) = three
    assert client.post(f"/api/sets/{set_id}/transitions",
                       json=_body(a, b, preset="slam", bars=1, volume_curve="center_cut",
                                  eq_curve="bass_cut_quick", out_anchor_s=250.0)).status_code == 200
    with Session(_engine()) as session:
        payload = _export_metadata(session)
        paths = {t.id: t.absolute_path for t in session.exec(select(Track)).all()}
    assert len(payload["set_transitions"]) == 1
    exported = payload["set_transitions"][0]
    assert (exported["set_id"], exported["from_track_id"], exported["to_track_id"]) == (set_id, a, b)
    assert exported["preset"] == "slam" and exported["out_anchor_s"] == 250.0

    # Old ids differ from local ids: the importer must remap set and both tracks.
    old = {a: 900, b: 901, c: 902}
    legacy = {
        "version": 2,
        "tracks": [{"id": old[t], "absolute_path": paths[t]} for t in (a, b, c)]
        + [{"id": 999, "absolute_path": "/gone/missing.wav"}],
        "sets": [{"id": 70, "title": "Set"}, {"id": 71, "title": "Imported"}],
        "set_tracks": [{"set_id": 71, "position": i, "track_id": old[t]} for i, t in enumerate((a, b, c))],
        "set_transitions": [
            {**exported, "set_id": 70, "from_track_id": 901, "to_track_id": 902},  # existing set: skipped
            {**exported, "set_id": 71, "from_track_id": 900, "to_track_id": 901},  # imported
            {**exported, "set_id": 71, "from_track_id": 901, "to_track_id": 999},  # unmatched track
            {**exported, "set_id": 71, "from_track_id": 901, "to_track_id": 902, "bars": 99},  # invalid
            {**exported, "set_id": 71, "from_track_id": 901, "to_track_id": 902, "out_anchor_s": 280.0},  # past end
        ],
    }
    with Session(_engine()) as session:
        result = import_metadata(session, legacy)
        assert result["sets"] == 1 and result["set_transitions"] == 1
        assert result["skipped_set_transitions"] == 3
        new_set = session.exec(select(DJSet).where(DJSet.title == "Imported")).one()
        imported = session.exec(select(SetTransition).where(SetTransition.set_id == new_set.id)).all()
        assert [(r.from_track_id, r.to_track_id, r.preset, r.out_anchor_s) for r in imported] == [
            (a, b, "slam", 250.0)]
        assert len(session.exec(select(SetTransition).where(SetTransition.set_id == set_id)).all()) == 1
        assert len(session.exec(select(SetTrack).where(SetTrack.set_id == new_set.id)).all()) == 3
        new_set_id = new_set.id
    rows = _list(client, new_set_id)
    assert [(r["from_track_id"], r["to_track_id"], r["persisted"]) for r in rows] == [(a, b, True), (b, c, False)]
    with Session(_engine()) as session:
        again = import_metadata(session, legacy)
    assert again["set_transitions"] == 0 and again["sets"] == 0
