"""The /tracks list endpoints merge a small DJ-profile summary per row.

Tagged tracks expose their profile fields inline; untagged tracks (which have
no lazily-created profile row) still carry the keys, as null.
"""
from __future__ import annotations

from sqlmodel import Session


def _seed_tagged_and_untagged() -> tuple[int, int]:
    """Insert one track WITH a profile and one WITHOUT. Returns their ids."""
    import app.db as dbmod
    from app.models import Track, TrackDJProfile

    with Session(dbmod.get_engine()) as s:
        tagged = Track(absolute_path="/lib/tagged.wav", missing=False)
        untagged = Track(absolute_path="/lib/untagged.wav", missing=False)
        s.add(tagged)
        s.add(untagged)
        s.commit()
        s.refresh(tagged)
        s.refresh(untagged)
        s.add(TrackDJProfile(
            track_id=tagged.id,
            personal_status="approved",
            energy=9,
            darkness=7,
            set_role="bridge",
        ))
        s.commit()
        return tagged.id, untagged.id


def test_list_tracks_merges_profile_summary(client):
    tagged_id, untagged_id = _seed_tagged_and_untagged()

    rows = client.get("/api/tracks").json()
    by_id = {r["id"]: r for r in rows}
    assert tagged_id in by_id
    assert untagged_id in by_id

    tagged = by_id[tagged_id]
    assert tagged["personal_status"] == "approved"
    assert tagged["energy"] == 9
    assert tagged["darkness"] == 7
    assert tagged["set_role"] == "bridge"

    # Untagged track has no profile row -> keys present but null, no crash.
    untagged = by_id[untagged_id]
    assert untagged["personal_status"] is None
    assert untagged["energy"] is None
    assert untagged["darkness"] is None
    assert untagged["set_role"] is None
