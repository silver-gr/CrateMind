"""Executable scope and generated state fixtures, not an installed-parity claim."""
from __future__ import annotations

import importlib.util
import json
import sqlite3
from copy import deepcopy
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = Path(__file__).parent / "fixtures/desktop_parity"
SPEC = importlib.util.spec_from_file_location(
    "desktop_parity_inventory", ROOT / "scripts/desktop/check_parity_inventory.py",
)
inventory = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(inventory)


def documents():
    return (json.loads(inventory.BASELINE.read_text()),
            json.loads(inventory.ACCEPTANCE.read_text()))


def test_approved_routes_screens_guards_and_oracles_have_acceptance_owners():
    report = inventory.validate_inventory(*documents())
    assert report == {
        "baseline_routes": 104, "retained_routes": 92, "deferred_routes": 12,
        "planned_routes": 9, "screens": 21,
        "behavioral_parity": "not established by inventory",
    }


def test_route_keys_ignore_parameter_names_but_preserve_converters_and_methods():
    assert inventory.route_key({"method": "get", "path": "/api/tracks/{id}"}) == (
        inventory.route_key({"method": "GET", "path": "/api/tracks/{track_id}"})
    )
    assert inventory.route_key({"method": "GET", "path": "/api/files/{path:path}"}) != (
        inventory.route_key({"method": "GET", "path": "/api/files/{id}"})
    )
    assert inventory.route_key({"method": "POST", "path": "/api/tracks/{id}"}) != (
        inventory.route_key({"method": "GET", "path": "/api/tracks/{id}"})
    )


def test_historical_handlers_and_source_lines_can_move():
    baseline, acceptance = documents()
    for route in baseline["routes"]:
        route.update(source="backend/app/another_module.py", line=999, handler="renamed")
        route["path"] = route["path"].replace("{track_id}", "{id}")
    inventory.validate_inventory(baseline, acceptance)
    inventory.compare_runtime(baseline, baseline["routes"], "web")


@pytest.mark.parametrize("change", ["missing", "duplicate", "owner", "guard", "capability",
                                          "planned", "screen", "oracle"])
def test_inventory_rejects_unclassified_or_unowned_contracts(change):
    baseline, acceptance = documents()
    if change == "missing":
        acceptance["routes"].pop()
    elif change == "duplicate":
        acceptance["routes"].append(deepcopy(acceptance["routes"][0]))
    elif change == "owner":
        acceptance["routes"][0]["verification_owner"] = ""
    elif change == "guard":
        baseline["routes"][-2]["desktop_guard"] = "read_shared"
    elif change == "capability":
        acceptance["routes"][0].pop("capability")
    elif change == "planned":
        acceptance["planned_routes"][0]["profiles"] = ["web"]
    elif change == "screen":
        acceptance["screens"]["/accidental-roadmap"] = acceptance["screens"]["/library"]
    elif change == "oracle":
        acceptance["behaviors"]["tracks"]["oracles"] = [
            "backend/tests/test_search.py::test_does_not_exist",
        ]
    with pytest.raises(ValueError):
        inventory.validate_inventory(baseline, acceptance)


def test_runtime_comparison_requires_retained_routes_and_classifies_new_routes():
    baseline, _ = documents()
    retained = [route for route in baseline["routes"]
                if route["desktop_disposition"] == "retain_shared_implementation"]
    inventory.compare_runtime(baseline, retained, "desktop-core")
    # Either absent deferred routes or registered feature-unavailable stubs are structural matches.
    inventory.compare_runtime(baseline, baseline["routes"], "desktop-core")
    desktop_planned = baseline["planned_routes"]
    inventory.compare_runtime(baseline, retained + desktop_planned, "desktop-core")
    internal = {"method": "GET", "path": "/api/desktop/health"}
    report = inventory.compare_runtime(baseline, retained + [internal], "desktop-core")
    assert report["internal_present"] == ["GET /api/desktop/health"]
    with pytest.raises(ValueError, match="missing="):
        inventory.compare_runtime(baseline, retained[1:], "desktop-core")
    with pytest.raises(ValueError, match="unclassified="):
        inventory.compare_runtime(baseline, retained + [{"method": "POST", "path": "/api/new"}],
                                  "desktop-core")
    with pytest.raises(ValueError, match="unclassified="):
        inventory.compare_runtime(baseline, baseline["routes"] + desktop_planned, "web")


@pytest.mark.parametrize("profile", ["web", "desktop-core"])
def test_playback_loudness_is_a_separately_owned_followup_for_both_profiles(profile):
    baseline, acceptance = documents()
    original = deepcopy(baseline)
    additions = inventory.validate_followups(baseline)
    key = "GET /api/tracks/{str}/playback-loudness"
    assert set(additions) == {key}
    followup = additions[key]
    assert followup["desktop_guard"] == "read_source_cache_only"
    assert followup["verification_owner"] == "playback_loudness"
    assert followup["oracle"].startswith("backend/tests/test_playback_loudness.py::")
    report = inventory.compare_runtime(baseline, baseline["routes"] + [followup], profile)
    assert report["followup_present"] == [key]
    assert report["planned_present"] == []
    assert baseline == original
    assert len(baseline["routes"]) == 104 and len(baseline["planned_routes"]) == 9
    assert len(acceptance["routes"]) == 104 and len(acceptance["planned_routes"]) == 9


@pytest.mark.parametrize("method,path", [
    ("POST", "/api/tracks/{id}/playback-loudness"),
    ("GET", "/api/tracks/{id}/playback-loudness/new"),
    ("GET", "/api/tracks/{id}/unreviewed-analysis"),
    ("GET", "/api/tracks/{id:path}/playback-loudness"),
])
@pytest.mark.parametrize("profile", ["web", "desktop-core"])
def test_followup_classification_does_not_allow_neighboring_routes(method, path, profile):
    baseline, _ = documents()
    actual = baseline["routes"] + [{"method": method, "path": path}]
    with pytest.raises(ValueError, match="unclassified="):
        inventory.compare_runtime(baseline, actual, profile)


@pytest.mark.parametrize("change", ["owner", "guard", "profile", "oracle", "overlap"])
def test_followup_requires_owner_source_cache_guard_both_profiles_and_real_oracle(monkeypatch, change):
    baseline, acceptance = documents()
    followups = deepcopy(inventory.FOLLOWUP_ROUTES)
    followup = followups[0]
    if change == "owner":
        followup["verification_owner"] = ""
    elif change == "guard":
        followup["desktop_guard"] = "allow_shared"
    elif change == "profile":
        followup["profiles"] = ["web"]
    elif change == "oracle":
        followup["oracle"] = "backend/tests/test_playback_loudness.py::test_does_not_exist"
    elif change == "overlap":
        followup.update(method=baseline["routes"][0]["method"], path=baseline["routes"][0]["path"])
    monkeypatch.setattr(inventory, "FOLLOWUP_ROUTES", followups)
    with pytest.raises(ValueError):
        inventory.validate_inventory(baseline, acceptance)


def test_web_runtime_discovery_uses_private_storage_and_keeps_parent_settings(monkeypatch):
    # Poisoned inherited settings must be discarded in the isolated child.
    monkeypatch.setenv("CRATEMIND_DB_PATH", "/must-never-open-real-catalog.sqlite")
    monkeypatch.setenv("CRATEMIND_IDENTITY_DB_PATH", "/must-never-open-real-identity.sqlite")
    baseline, _ = documents()
    routes = inventory.discover_runtime("web")
    assert inventory.compare_runtime(baseline, routes, "web")["observed_routes"] >= 104
    import os

    assert os.environ["CRATEMIND_DB_PATH"] == "/must-never-open-real-catalog.sqlite"


@pytest.fixture
def parity_client(request, monkeypatch):
    # Existing client fixture owns a private catalog/root. Clear inherited pairing/profile
    # overrides before its lifespan so backups can never attach a user's identity DB.
    for name in ("CRATEMIND_IDENTITY_DB_PATH", "CRATEMIND_DATASET_ROOT"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("CRATEMIND_RUNTIME_PROFILE", "web")
    from functools import lru_cache

    from app import config

    monkeypatch.setattr(config, "get_settings", lru_cache()(lambda: config.Settings(_env_file=None)))
    return request.getfixturevalue("client")


def test_generated_catalog_fixture_retains_mutations_and_stored_results(parity_client, tmp_path):
    from sqlmodel import Session, select

    from app import db as dbmod
    from app.models import (
        PlayEvent,
        SoundCloudTrack,
        Track,
        TrackCue,
        TrackDJProfile,
        TrackPairNote,
        TrackSoundCloudMatch,
        TrackTag,
    )
    from tests.conftest import make_wav

    client = parity_client
    state = json.loads((FIXTURES / "catalog_state.json").read_text())
    originals = {}
    with Session(dbmod.get_engine()) as session:
        for values in state["tracks"]:
            path = make_wav(tmp_path / "generated-audio" / values["file_name"])
            originals[path] = (path.read_bytes(), path.stat().st_mtime_ns)
            session.add(Track.model_validate({**values, "absolute_path": str(path)}))
        session.add(SoundCloudTrack.model_validate(state["provider_snapshot"]))
        session.commit()
        session.add(TrackSoundCloudMatch.model_validate({
            **state["provider_match"], "track_id": 1, "soundcloud_track_id": 9001,
        }))
        session.commit()

    def call(method, path, body=None):
        response = client.request(method, path, json=body)
        assert response.status_code in {200, 201}, response.text
        return response.json()

    cue = call("POST", "/api/tracks/1/cues", state["cue"])
    tag = call("POST", "/api/tags", state["tag"])
    call("POST", "/api/tracks/1/tags", {"tag_id": tag["id"]})
    call("PATCH", "/api/tracks/1/profile", state["profile"])
    dj_set = call("POST", "/api/sets", state["set"])
    for track_id in (1, 2):
        call("POST", f"/api/sets/{dj_set['id']}/tracks", {"track_id": track_id})
    call("PATCH", f"/api/sets/{dj_set['id']}/tracks/reorder", {"ordered_track_ids": [2, 1]})
    pair = call("POST", "/api/pair-notes", {
        **state["pair_note"], "from_track_id": 1, "to_track_id": 2,
    })
    call("POST", "/api/tracks/1/play", {**state["play"], "set_id": dj_set["id"]})
    detail = call("GET", "/api/tracks/1")
    assert all(detail["track"][key] == value for key, value in state["tracks"][0].items())
    assert all(detail["profile"][key] == value for key, value in state["profile"].items())
    assert detail["tags"] == [tag]
    assert detail["soundcloud"]["track"]["soundcloud_track_id"] == 9001
    assert call("GET", "/api/tracks/1/cues") == [cue]
    assert call("GET", "/api/pair-notes?track_id=1") == [pair]
    ordered = call("GET", f"/api/sets/{dj_set['id']}")
    assert [item["track"]["id"] for item in ordered["tracks"]] == [2, 1]
    # Reopen the database: validate durable values, not just echoed response bodies.
    with Session(dbmod.get_engine()) as session:
        assert session.get(TrackCue, cue["id"]).label == state["cue"]["label"]
        assert session.get(TrackDJProfile, 1).human_confirmed
        assert session.get(TrackTag, (1, tag["id"])) is not None
        assert session.get(TrackPairNote, pair["id"]).notes == state["pair_note"]["notes"]
        assert session.get(Track, 1).play_count == 1
        assert len(session.exec(select(PlayEvent)).all()) == 1
        assert session.get(SoundCloudTrack, 9001).raw_json == state["provider_snapshot"]["raw_json"]
        assert session.get(TrackSoundCloudMatch, 1).confirmed_at == "2026-01-01"
    assert all((path.read_bytes(), path.stat().st_mtime_ns) == original
               for path, original in originals.items())


def test_generated_identity_decisions_survive_reopen(tmp_path):
    from app.services import canonical_library as canonical
    from app.services import manual_identity
    from tests.test_canonical import entity, fixture_db, put

    pairs = json.loads((FIXTURES / "catalog_state.json").read_text())["identity_pairs"]
    db = fixture_db()
    try:
        for pair in pairs.values():
            for sid in pair:
                put(db, entity(sid, "local"))
        canonical.promote(db)
        db.commit()
        left, right = pairs["accepted"]
        preview = manual_identity.comparison(db, left, right)
        manual_identity.link(db, left, right, preview["token"], left, mirror_legacy=False)
        db.commit()
        left, right = pairs["rejected"]
        preview = manual_identity.comparison(db, left, right)
        manual_identity.reject(db, left, right, preview["token"])
        db.commit()
        path = tmp_path / "generated-identity.sqlite"
        with sqlite3.connect(path) as destination:
            db.backup(destination)
    finally:
        db.close()
    with sqlite3.connect(path) as restored:
        accepted = restored.execute(
            "SELECT left_id,right_id,acceptance_mode,revoked_at FROM identity_acceptances",
        ).fetchall()
        assert accepted == [(*pairs["accepted"], "human", None)]
        assert restored.execute(
            "SELECT left_id,right_id,reason FROM canonical_blocks",
        ).fetchall() == [(*pairs["rejected"], "human_rejection")]
        assert {row[0] for row in restored.execute("SELECT action FROM canonical_events")} >= {
            "human_identity_link", "human_identity_rejection",
        }
