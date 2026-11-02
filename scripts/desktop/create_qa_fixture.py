#!/usr/bin/env python3
"""Generate synthetic codec/library fixtures; never accepts existing user data."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))


def add_artist_result_fixtures(session):
    """Three hand-built profiles for the fixture-only Luna result UI probe."""
    from app.models import ArtistProfile, ArtistReview

    stamp = datetime.now(UTC)

    def candidate(artist_id, genre, source_name):
        url = f"https://label.example/{source_name}"
        research = {
            "workflow": "artist-genre-research-v1", "status": "classified",
            "sources": [{"url": url, "evidence": f"Δοκιμαστική πηγή που τεκμηριώνει το είδος {genre}."}],
            "outside_genre": None, "reason": f"Η δοκιμαστική κυκλοφορία τεκμηριώνει το είδος {genre}.",
            "model": "gpt-6-luna", "reasoning_effort": "max",
        }
        return {
            "scene_cluster": genre.lower(), "primary_subgenre": genre,
            "secondary_subgenres_json": "[]", "confidence_label": "high", "needs_review": True,
            "notes": research["reason"], "research": research,
            "raw_llm_json": json.dumps({
                "workflow": research["workflow"], "research": research,
                "finding": {"artist_id": artist_id, "identity_match": True,
                            "primary_subgenre": genre},
                "observed_sources": [url], "search_calls": 1,
            }, ensure_ascii=False),
        }

    legacy = ArtistProfile(
        id=71001, normalized_name="δοκιμή παλαιού προφίλ", canonical_name="Δοκιμή παλαιού προφίλ",
        track_count=2, scene_cluster="full-on", primary_subgenre="Full-On",
        confidence_label="low", needs_review=True, last_enriched_at=stamp,
        raw_llm_json=json.dumps({"model": "gemini", "primary_subgenre": "Full-On"}),
        notes="Παλαιά δοκιμαστική εκτίμηση που δεν πρέπει να εμφανιστεί ως αποτέλεσμα Luna.",
    )
    confirmed_finding = candidate(71002, "Forest", "native-qa-confirmed-forest")
    confirmed = ArtistProfile(
        id=71002, normalized_name="δοκιμή επιβεβαιωμένου luna", canonical_name="Δοκιμή επιβεβαιωμένου Luna",
        track_count=2, last_enriched_at=stamp,
        **{key: value for key, value in confirmed_finding.items() if key not in {"research", "needs_review"}},
        needs_review=False,
    )
    pending = ArtistProfile(
        id=71003, normalized_name="δοκιμή πρότασης luna", canonical_name="Δοκιμή πρότασης Luna",
        track_count=2, scene_cluster="forest", primary_subgenre="Forest", confidence_label="low",
        needs_review=True, last_enriched_at=stamp, typical_bpm_min=147, typical_bpm_max=153,
        energy_min=4, energy_max=6, set_role_hints_json='["peak"]',
        notes="Παλαιά δοκιμαστική περιγραφή που δεν πρέπει να εμφανιστεί στην κάρτα.",
        raw_llm_json=json.dumps({"model": "gemini", "primary_subgenre": "Forest"}),
    )
    session.add_all([legacy, confirmed, pending])
    session.flush()
    session.add_all([
        ArtistReview(
            artist_id=legacy.id, state="ready", baseline_json=legacy.model_dump_json(),
            candidate_json=json.dumps({"primary_subgenre": "Full-On", "raw_llm_json": legacy.raw_llm_json}),
        ),
        ArtistReview(
            artist_id=confirmed.id, state="confirmed", baseline_json=confirmed.model_dump_json(),
            candidate_json=json.dumps(confirmed_finding, ensure_ascii=False),
            confirmed_choice="candidate", confirmed_at=stamp,
        ),
        ArtistReview(
            artist_id=pending.id, state="ready", baseline_json=pending.model_dump_json(),
            candidate_json=json.dumps(candidate(pending.id, "Hi-Tech", "native-qa-ready-hitech"), ensure_ascii=False),
        ),
    ])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ffmpeg", type=Path, required=True)
    args = parser.parse_args()
    root = Path(tempfile.mkdtemp(prefix="cratemind-native-qa-"))
    (root / ".cratemind-qa-fixture").write_text("generated fixture; no user data\n")
    media = root / "generated-media"
    media.mkdir()
    from app.library_exchange.operations import initialize_empty
    from app.library_exchange.state import atomic_json
    from app.models import Track, TrackCue, TrackDJProfile, Tag, TrackTag, DJSet, SetTrack
    from sqlmodel import Session, create_engine
    dataset = initialize_empty(root)
    os.environ.update(CRATEMIND_RUNTIME_PROFILE="desktop-core", CRATEMIND_DATASET_ROOT=str(root))
    descriptors = []
    engine = create_engine(f"sqlite:///{dataset.catalog_path}")
    encoders = {"wav": "pcm_s16le", "mp3": "libmp3lame", "flac": "flac",
                "m4a": "aac", "ogg": "vorbis", "opus": "libopus", "aiff": "pcm_s16be"}
    with Session(engine) as session:
        for index, (extension, encoder) in enumerate(encoders.items()):
            audio = media / f"Δοκιμή {index + 1}.{extension}"
            subprocess.run([str(args.ffmpeg.resolve()), "-hide_banner", "-loglevel", "error",
                            "-f", "lavfi", "-i", f"sine=frequency={220 + index * 55}:duration=8",
                            "-ac", "2", "-ar", "44100" if extension != "opus" else "48000",
                            "-c:a", encoder, "-strict", "-2", str(audio)], check=True, timeout=30,
                           stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            track = Track(absolute_path=f"/Original/Library/{audio.name}",
                          volume_root="/Original/Library", file_name=audio.name,
                          extension=extension, artist="Δοκιμαστικός καλλιτέχνης", title=f"Δοκιμή {extension}",
                          duration=8, bpm=128 + index, key_text="Am", file_size=audio.stat().st_size,
                          modified_time=audio.stat().st_mtime)
            session.add(track)
            session.flush()
            session.add(TrackDJProfile(track_id=track.id, energy=7, set_role="peak", human_confirmed=True))
            descriptors.append({"id": track.id, "codec": extension, "source": str(audio),
                                "sha256": hashlib.sha256(audio.read_bytes()).hexdigest(),
                                "mtime_ns": audio.stat().st_mtime_ns})
        tag = Tag(name="Δοκιμή", category="style")
        session.add(tag)
        dj_set = DJSet(title="Δοκιμαστικό set")
        session.add(dj_set)
        session.flush()
        session.add(TrackTag(track_id=1, tag_id=tag.id))
        session.add(SetTrack(set_id=dj_set.id, track_id=1, position=0))
        session.add(TrackCue(track_id=1, position_ms=1500, kind="cue", label="Επιστροφή"))
        add_artist_result_fixtures(session)
        session.commit()
        from app.db import reindex_all
        reindex_all(session)
        session.commit()
    engine.dispose()
    state = json.loads(dataset.exchange_state_path.read_text())
    state["logical_roots"] = [{"root_key": "qa-library", "logical_prefix": "/Original/Library", "logical_flavor": "posix"}]
    atomic_json(dataset.exchange_state_path, state)
    atomic_json(root / "desktop-config.json", {"version": 1, "revision": "qa-fixture", "library_roots": [{
        "root_key": "qa-library", "logical_prefix": "/Original/Library", "logical_flavor": "posix",
        "local_prefix": str(media), "enabled": True,
    }]})
    atomic_json(root / "preferences.json", {"cratemind-theme": "light"})
    atomic_json(root / "native-qa-provenance.json", {"tracks": descriptors})
    atomic_json(root / "native-qa-fixtures.json", {"tracks": [
        {"id": item["id"], "codec": item["codec"]} for item in descriptors
    ]})
    print(json.dumps({"app_data": str(root), "tracks": len(descriptors)}))


if __name__ == "__main__":
    main()
