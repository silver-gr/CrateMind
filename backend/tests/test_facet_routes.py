"""Facet routes, tag-route guards and the legacy JSON import of facets."""
from __future__ import annotations

from sqlalchemy import func, text
from sqlmodel import Session, select

from app.db import reindex_track
from app.models import AuditLog, Facet, SavedSearch, Tag, Track, TrackTag
from app.services import facets

GUARD = "Οι τιμές λεξιλογίων αλλάζουν μόνο από τα Λεξιλόγια ή την ουρά ταξινόμησης."


def _engine():
    import app.db as dbmod

    return dbmod.get_engine()


def _tracks(n: int, prefix: str = "t") -> list[int]:
    with Session(_engine()) as session:
        rows = [Track(absolute_path=f"/{prefix}/{i}.mp3", title=f"{prefix} {i}") for i in range(n)]
        session.add_all(rows)
        session.commit()
        for row in rows:
            reindex_track(session, row.id, commit=False)
        session.commit()
        return [row.id for row in rows]


def _assign(track_ids: list[int], value_id: int) -> None:
    with Session(_engine()) as session:
        for track_id in track_ids:
            facets.apply_tag_changes(session, track_id, [value_id], [])


def _tag_count() -> int:
    with Session(_engine()) as session:
        return session.execute(select(func.count()).select_from(Tag)).scalar_one()


def test_facet_routes_crud_and_counts(client):
    t1, t2, t3 = _tracks(3)
    r = client.post("/api/facets", json={"key": "voice", "label": "Φωνή", "multi": False})
    assert r.status_code == 200, r.text
    voice = r.json()
    assert (voice["key"], voice["label"], voice["multi"], voice["values"]) == ("voice", "Φωνή", False, [])
    assert client.post("/api/facets", json={"key": "voice", "label": "Άλλη", "multi": True}).status_code == 409
    assert client.post("/api/facets", json={"key": "energy", "label": "Χ", "multi": True}).status_code == 422
    mood = client.post("/api/facets", json={"label": "Διάθεση", "multi": True}).json()
    assert mood["key"] == "diathesi"

    organic = client.post(f"/api/facets/{voice['id']}/values", json={"value": "οργανικό"}).json()
    lyrics = client.post(f"/api/facets/{voice['id']}/values", json={"value": "στίχοι"}).json()
    assert organic["value"] == "οργανικό" and organic["count"] == 0
    dup = client.post(f"/api/facets/{voice['id']}/values", json={"value": "ΟΡΓΑΝΙΚΟ"})
    assert dup.status_code == 409 and dup.json()["detail"].startswith("Υπάρχει ήδη τιμή")
    assert client.post("/api/facets/999/values", json={"value": "x"}).status_code == 404

    _assign([t1, t2], organic["id"])
    with Session(_engine()) as session:
        session.add(SavedSearch(name="Οργανικά", query="voice:οργανικο"))
        session.commit()

    renamed = client.post(f"/api/facets/values/{organic['id']}", json={"value": "ενόργανο"})
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["rewritten_searches"] == 1 and renamed.json()["value"] == "ενόργανο"

    listed = client.get("/api/facets").json()
    assert [f["key"] for f in listed] == ["voice", "diathesi"]
    assert [(v["value"], v["count"]) for v in listed[0]["values"]] == [("ενόργανο", 2), ("στίχοι", 0)]

    counts = client.get("/api/facets/counts", params={"q": ""}).json()
    assert counts["total"] == 3 and counts["counts"][str(organic["id"])] == 2
    counts = client.get("/api/facets/counts", params={"q": "voice:ενόργανο"}).json()
    assert counts["total"] == 2 and counts["counts"][str(organic["id"])] == 2
    assert counts["counts"].get(str(lyrics["id"]), 0) == 0

    r = client.delete(f"/api/facets/values/{organic['id']}")
    assert r.status_code == 409
    assert r.json()["detail"].startswith("Η τιμή «ενόργανο» χρησιμοποιείται σε 2 κομμάτια.")
    r = client.delete(f"/api/facets/values/{organic['id']}", params={"force": "true"})
    assert r.json() == {"removed_assignments": 2, "broken_searches": ["Οργανικά"]}

    updated = client.post(f"/api/facets/{voice['id']}", json={"label": "Φωνητικά", "sort_order": 5})
    assert updated.status_code == 200 and updated.json()["label"] == "Φωνητικά"
    r = client.delete(f"/api/facets/{voice['id']}")
    assert r.status_code == 409 and r.json()["detail"].startswith("Το λεξιλόγιο «Φωνητικά» έχει 1 τιμή")
    assert client.delete(f"/api/facets/{voice['id']}", params={"force": "true"}).json() == {
        "deleted_values": 1, "untagged_tracks": 0,
    }

    first = client.post("/api/facets/presets/therapy").json()
    assert first == {"created_facets": 8, "created_values": 47, "adopted_tags": 0}
    assert client.post("/api/facets/presets/therapy").json() == {
        "created_facets": 0, "created_values": 0, "adopted_tags": 0,
    }
    assert client.post("/api/facets/presets/unknown").status_code == 404


def test_counts_with_low_variable_limit(client, low_variable_limit):
    ids = _tracks(150, "amb")
    voice = client.post("/api/facets", json={"key": "voice", "label": "Φωνή", "multi": False}).json()
    value = client.post(f"/api/facets/{voice['id']}/values", json={"value": "οργανικό"}).json()
    with Session(_engine()) as session:
        session.add_all([TrackTag(track_id=i, tag_id=value["id"]) for i in ids])
        session.commit()
    r = client.get("/api/facets/counts", params={"q": "amb"})
    assert r.status_code == 200, r.text
    assert r.json()["total"] == 150 and r.json()["counts"][str(value["id"])] == 150


def test_tag_routes_cannot_bypass_single_value_rule(client):
    (track,) = _tracks(1)
    voice = client.post("/api/facets", json={"key": "voice", "label": "Φωνή", "multi": False}).json()
    value = client.post(f"/api/facets/{voice['id']}/values", json={"value": "οργανικό"}).json()
    attempts = [
        ("/api/tags", {"name": "voice:οργανικό"}),
        ("/api/tags", {"name": "voice:νέο"}),
        ("/api/tags", {"name": "x", "category": "voice"}),
        (f"/api/tracks/{track}/tags", {"name": "voice:οργανικό"}),
        (f"/api/tracks/{track}/tags", {"name": "voice:άλλο"}),
        (f"/api/tracks/{track}/tags", {"tag_id": value["id"]}),
    ]
    for path, body in attempts:
        before = _tag_count()
        r = client.post(path, json=body)
        assert (r.status_code, r.json()["detail"]) == (400, GUARD), (path, body)
        assert _tag_count() == before, (path, body)

    r = client.post(f"/api/tracks/{track}/tags", json={"name": "ordinary"})
    assert r.status_code == 200

    # A category-owned tag without the value prefix is refused on the tag_id path too.
    with Session(_engine()) as session:
        owned = Tag(name="legacy", category="voice")
        session.add(owned)
        session.commit()
        owned_id = owned.id
    r = client.post(f"/api/tracks/{track}/tags", json={"tag_id": owned_id})
    assert (r.status_code, r.json()["detail"]) == (400, GUARD)

    _assign([track], value["id"])
    with Session(_engine()) as session:
        assert "οργανικο" in session.execute(text("SELECT tags FROM track_search WHERE rowid = :id"), {"id": track}).scalar_one()
    r = client.delete(f"/api/tracks/{track}/tags/{value['id']}")
    assert r.status_code == 200
    with Session(_engine()) as session:
        assert session.get(TrackTag, (track, value["id"])) is None
        assert "οργανικο" not in session.execute(text("SELECT tags FROM track_search WHERE rowid = :id"), {"id": track}).scalar_one()
        assert session.exec(select(AuditLog).where(AuditLog.action == "tags_update")).all()


def _legacy_payload():
    return {
        "version": 2,
        "tracks": [{"id": 1, "absolute_path": "/legacy/1.mp3"}],
        "facets": [
            {"id": 1, "key": "voice", "label": "Φωνή", "multi": False, "sort_order": 0},
            {"id": 2, "key": "energy", "label": "x", "multi": True, "sort_order": 1},
        ],
        "tags": [
            {"id": 10, "name": "voice:οργανικό", "category": "voice"},
            {"id": 11, "name": "voice:με στίχους", "category": "voice"},
            {"id": 12, "name": "plain", "category": None},
            {"id": 13, "name": "energy:high", "category": "energy"},
        ],
        "track_tags": [
            {"track_id": 1, "tag_id": 10},
            {"track_id": 1, "tag_id": 11},
            {"track_id": 1, "tag_id": 12},
            {"track_id": 1, "tag_id": 13},
        ],
    }


def _state(db, track_id):
    return (
        sorted(db.exec(select(Tag.name).join(TrackTag, TrackTag.tag_id == Tag.id).where(TrackTag.track_id == track_id)).all()),
        sorted(db.exec(select(Facet.key)).all()),
        sorted(db.exec(select(Tag.name)).all()),
    )


def test_legacy_import_restores_facets_through_the_service(db):
    from app.services.legacy_import import import_metadata

    track = Track(absolute_path="/legacy/1.mp3")
    db.add(track)
    db.commit()
    result = import_metadata(db, _legacy_payload())
    assert result["replaced_facet_values"] == 1
    assert result["skipped_facets"] == 1
    assert result["skipped_facet_links"] == 1
    voice = db.exec(select(Facet).where(Facet.key == "voice")).one()
    assert (voice.label, voice.multi) == ("Φωνή", False)
    state = _state(db, track.id)
    assert state[0] == ["plain", "voice:με στίχους"]
    assert state[1] == ["voice"]

    import_metadata(db, _legacy_payload())
    assert _state(db, track.id) == state
