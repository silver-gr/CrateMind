"""Each set exports M3U/CSV to its own file, so one set's export never refuses or replaces another's."""
from __future__ import annotations

from pathlib import Path

from sqlmodel import Session

import app.db as dbmod
from app.models import Track
from tests.conftest import make_wav


def _set_with_track(client, path: Path, title: str) -> int:
    with Session(dbmod.get_engine()) as s:
        track = Track(absolute_path=str(path), file_name=path.name, missing=False)
        s.add(track)
        s.commit()
        s.refresh(track)
        track_id = track.id
    set_id = client.post("/api/sets", json={"title": title}).json()["id"]
    client.post(f"/api/sets/{set_id}/tracks", json={"track_id": track_id})
    return set_id


def test_each_set_exports_to_its_own_file(client, tmp_path):
    a = _set_with_track(client, make_wav(tmp_path / "lib" / "a.wav"), "A")
    b = _set_with_track(client, make_wav(tmp_path / "lib" / "b.wav", freq_seed=1), "B")
    for fmt, ext in (("m3u", "m3u8"), ("csv", "csv")):
        names = []
        for set_id in (a, b):
            response = client.post(f"/api/export/{fmt}", json={"set_id": set_id})
            assert response.status_code == 200, response.text
            names.append(Path(response.json()["path"]).name)
        assert names == [f"set-{a}.{ext}", f"set-{b}.{ext}"]
        # Exporting the same set again replaces its own file when asked.
        assert client.post(f"/api/export/{fmt}", json={"set_id": a, "overwrite": True}).status_code == 200
        assert client.post(f"/api/export/{fmt}", json={"set_id": a}).status_code == 409


def test_non_set_exports_keep_the_shared_name(client, tmp_path):
    _set_with_track(client, make_wav(tmp_path / "lib" / "a.wav"), "A")
    response = client.post("/api/export/csv", json={"all_tracks": True})
    assert Path(response.json()["path"]).name == "cratemind.csv"
