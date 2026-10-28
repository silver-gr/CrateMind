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
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))


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
