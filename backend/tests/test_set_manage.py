import json

from sqlmodel import Session, select

from app.models import AuditLog, SetTrack, Track


def engine():
    import app.db as dbmod
    return dbmod.get_engine()


def test_rename_changes_only_the_title_and_audits(client):
    created = client.post("/api/sets", json={"title": "Draft", "notes": "keep"}).json()

    res = client.post(f"/api/sets/{created['id']}", json={"title": "  Goa night  "})

    assert res.status_code == 200
    assert res.json()["title"] == "Goa night"
    stored = client.get(f"/api/sets/{created['id']}").json()["set"]
    assert stored["title"] == "Goa night" and stored["notes"] == "keep"
    with Session(engine()) as session:
        entry = session.exec(select(AuditLog).where(AuditLog.action == "set.rename")).one()
    assert entry.entity_id == created["id"]
    assert json.loads(entry.before_json) == {"title": "Draft"}
    assert json.loads(entry.after_json) == {"title": "Goa night"}


def test_rename_refuses_an_empty_title_and_an_unknown_set(client):
    created = client.post("/api/sets", json={"title": "Draft"}).json()

    assert client.post(f"/api/sets/{created['id']}", json={"title": "   "}).status_code == 400
    assert client.post(f"/api/sets/{created['id']}", json={}).status_code == 422
    assert client.post("/api/sets/999", json={"title": "X"}).status_code == 404
    assert client.get(f"/api/sets/{created['id']}").json()["set"]["title"] == "Draft"
    with Session(engine()) as session:
        assert session.exec(select(AuditLog).where(AuditLog.action == "set.rename")).all() == []


def test_summary_lists_every_set_with_track_count_and_length(client):
    full = client.post("/api/sets", json={"title": "Full"}).json()
    empty = client.post("/api/sets", json={"title": "Empty"}).json()
    with Session(engine()) as session:
        session.add_all([
            Track(id=1, absolute_path="/fixture/a.wav", duration=400.5),
            Track(id=2, absolute_path="/fixture/b.wav", duration=None),
            Track(id=3, absolute_path="/fixture/c.wav", duration=300.0),
        ])
        session.commit()
        session.add_all([SetTrack(set_id=full["id"], position=i, track_id=t) for i, t in enumerate((1, 2, 3))])
        session.commit()

    rows = client.get("/api/sets/summary").json()

    assert [(r["id"], r["title"], r["track_count"], r["duration_seconds"]) for r in rows] == [
        (empty["id"], "Empty", 0, 0.0),
        (full["id"], "Full", 3, 700.5),
    ]
    assert all(r["created_at"] for r in rows)
