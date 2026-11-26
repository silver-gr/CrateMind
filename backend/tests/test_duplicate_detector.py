"""Duplicate detection: exact grouping + remix-safety (no false auto-merge)."""
from __future__ import annotations

from app.models import Track
from app.services import duplicate_detector, hashing
from tests.conftest import make_wav


def test_quick_hash_deterministic(tmp_path):
    p = make_wav(tmp_path / "a.wav", freq_seed=3)
    assert hashing.quick_hash(p) == hashing.quick_hash(p)


def _add(db, **kw) -> Track:
    t = Track(**kw)
    db.add(t)
    db.commit()
    db.refresh(t)
    return t


def test_exact_byte_duplicates_grouped(db):
    _add(db, absolute_path="/x/a.wav", artist="A", title="X", quick_hash="HASH1", duration=200)
    _add(db, absolute_path="/y/a.wav", artist="A", title="X", quick_hash="HASH1", duration=200)
    result = duplicate_detector.detect(db)
    assert result["exact_groups"] == 1


def test_radio_edit_not_merged_with_extended(db):
    # same artist/title, very different durations -> NOT one exact group;
    # they must stay in separate duration clusters (human review).
    _add(db, absolute_path="/a.mp3", artist="Mandragora", title="X Radio Edit",
         quick_hash="H_A", duration=200)
    _add(db, absolute_path="/b.mp3", artist="Mandragora", title="X (Extended)",
         quick_hash="H_B", duration=400)
    result = duplicate_detector.detect(db)
    assert result["exact_groups"] == 0
    # different durations beyond tolerance -> no metadata group either
    assert result["metadata_groups"] == 0


def test_same_recording_metadata_suspect(db):
    _add(db, absolute_path="/a.wav", artist="Astrix", title="Y", quick_hash="A1", duration=300)
    _add(db, absolute_path="/b.mp3", artist="Astrix", title="Y", quick_hash="B2", duration=302)
    result = duplicate_detector.detect(db)
    assert result["metadata_groups"] == 1


def test_a_decided_group_is_not_flagged_again(db):
    """Resolving or ignoring a group is a human decision: the next run must not rebuild it as a new group
    (2026-11-18: «The Drop» came back on every refresh of «Διπλότυπα»). A new copy is new and is flagged."""
    from sqlmodel import select
    from app.models import DuplicateGroup, DuplicateGroupTrack

    a = _add(db, absolute_path="/a.wav", artist="Universum Psy", title="The Drop", quick_hash="A1", duration=440)
    b = _add(db, absolute_path="/b.mp3", artist="Universum Psy", title="The Drop", quick_hash="B2", duration=441)
    c = _add(db, absolute_path="/c.wav", artist="Kick", title="Same", quick_hash="SAME", duration=300)
    d = _add(db, absolute_path="/d.wav", artist="Kick", title="Same", quick_hash="SAME", duration=300)
    assert duplicate_detector.detect(db)["groups_created"] == 2
    for group, status in zip(db.exec(select(DuplicateGroup).order_by(DuplicateGroup.id)).all(), ("ignored", "resolved")):
        group.status = status
        db.add(group)
    db.commit()

    assert duplicate_detector.detect(db)["groups_created"] == 0
    assert duplicate_detector.detect(db)["groups_created"] == 0
    assert db.exec(select(DuplicateGroup).where(DuplicateGroup.status == "needs_review")).all() == []

    e = _add(db, absolute_path="/e.flac", artist="Universum Psy", title="The Drop", quick_hash="E5", duration=440)
    assert duplicate_detector.detect(db)["metadata_groups"] == 1
    new = db.exec(select(DuplicateGroup).where(DuplicateGroup.status == "needs_review")).one()
    members = {m.track_id for m in db.exec(select(DuplicateGroupTrack).where(DuplicateGroupTrack.group_id == new.id))}
    assert members == {a.id, b.id, e.id}
    assert {c.id, d.id}.isdisjoint(members)


def test_audio_pass_groups_a_preview_with_its_full_track(db):
    """Different credits and a preview length slip past the metadata pass; the fingerprint pass catches them,
    but never pairs a remix with the original or re-flags a decided group."""
    import json
    from pathlib import Path
    from sqlmodel import select
    from app.models import DuplicateGroup, DuplicateGroupTrack, Fingerprint

    fp = json.loads((Path(__file__).parent / "fixtures" / "fingerprints.json").read_text())
    full = _add(db, absolute_path="/full.mp3", artist="DARK JOCHEN", title="DRAGON FIGHTER", quick_hash="F", duration=443)
    preview = _add(db, absolute_path="/p.mp3", artist="Dark Jochen vs Nobody", title="DRAGON FIGHTER (200Bpm)",
                   quick_hash="P", duration=221)
    remix = _add(db, absolute_path="/r.mp3", artist="DARK JOCHEN", title="Dragon Fighter (VIP Remix)", quick_hash="R", duration=470)
    other = _add(db, absolute_path="/o.mp3", artist="Someone", title="Else", quick_hash="O", duration=400)
    for track, key in ((full, "full"), (preview, "preview"), (remix, "full"), (other, "other")):
        db.add(Fingerprint(track_id=track.id, chromaprint=fp[key]))
    db.commit()

    result = duplicate_detector.detect(db)
    assert (result["metadata_groups"], result["audio_groups"]) == (0, 1)
    group = db.exec(select(DuplicateGroup).where(DuplicateGroup.status == "needs_review")).one()
    assert group.reason == duplicate_detector.AUDIO_REASON
    members = {m.track_id for m in db.exec(select(DuplicateGroupTrack).where(DuplicateGroupTrack.group_id == group.id))}
    assert members == {full.id, preview.id}

    group.status = "resolved"; db.add(group); db.commit()
    assert duplicate_detector.detect(db)["audio_groups"] == 0


def test_title_similarity_ignores_brackets_bpm_and_credit_order():
    assert duplicate_detector.title_similarity("DRAGON FIGHTER", "Dragon Fighter (200Bpm)") >= 0.9
    assert duplicate_detector.title_similarity("Storie Di Tutti I Giorni", "Storie di tutti i giorni") == 1.0
    assert duplicate_detector.title_similarity("Multidimensional Music - Prozyk - Zweigesang", "Zweigesang") >= 0.9
    assert duplicate_detector.title_similarity("Abduction", "Continuum") < 0.75


def _file(track_id, extension="mp3", bitrate=320000, duration=300.0, has_taste=False, codec=None):
    return {"track_id": track_id, "extension": extension, "codec": codec, "bitrate": bitrate,
            "duration": duration, "has_taste": has_taste}


def test_suggested_keeper_gives_the_first_reason_that_tells_the_files_apart():
    from app.services.duplicate_detector import suggest_keeper

    # Lossless beats a lossy file that has the user's work, a higher bitrate and more length.
    assert suggest_keeper([_file(1, has_taste=True, duration=400.0), _file(2, "flac", 900000)]) == {
        "track_id": 2, "reason": "lossless"}
    assert suggest_keeper([_file(1, "m4a", 256000), _file(2, "m4a", 800000, codec="alac")])["reason"] == "lossless"
    assert suggest_keeper([_file(1, bitrate=192000), _file(2), _file(3, bitrate=128000)]) == {
        "track_id": 2, "reason": "bitrate"}
    # Lossless bitrates (WAV against FLAC) and near-equal VBR rates decide nothing; the user's work does.
    assert suggest_keeper([_file(1, "wav", 1411000), _file(2, "flac", 900000, has_taste=True)]) == {
        "track_id": 2, "reason": "taste"}
    assert suggest_keeper([_file(1, bitrate=320000), _file(2, bitrate=318000, has_taste=True)])["reason"] == "taste"
    assert suggest_keeper([_file(1, duration=90.0), _file(2, duration=412.0)]) == {"track_id": 2, "reason": "longer"}
    assert suggest_keeper([_file(1), _file(2)]) is None
    assert suggest_keeper([_file(1)]) is None


def test_duplicate_list_suggests_a_keeper_and_never_a_missing_file(client):
    from sqlmodel import Session

    from app.db import get_engine
    from app.models import DuplicateGroup, DuplicateGroupTrack, PlayEvent, Track

    with Session(get_engine()) as session:
        tracks = [Track(absolute_path="/lib/a.mp3", file_name="a.mp3", extension="mp3", bitrate=320000, duration=300),
                  Track(absolute_path="/lib/b.mp3", file_name="b.mp3", extension="mp3", bitrate=320000, duration=300),
                  Track(absolute_path="/lib/c.flac", file_name="c.flac", extension="flac", duration=300, missing=True)]
        group = DuplicateGroup(reason="exact: identical quick_hash")
        session.add_all([*tracks, group])
        session.flush()
        session.add_all([DuplicateGroupTrack(group_id=group.id, track_id=t.id) for t in tracks])
        session.add(PlayEvent(track_id=tracks[1].id))
        session.commit()
        played = tracks[1].id
    (listed,) = client.get("/api/duplicates").json()
    assert listed["suggested_keep"] == {"track_id": played, "reason": "taste"}
    assert len(listed["tracks"]) == 3 and all("role" in t for t in listed["tracks"])
