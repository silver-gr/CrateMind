"""M3U8 export content + overwrite protection."""
from __future__ import annotations

import pytest

from app.models import Track
from app.services import exporter_m3u


def _tracks():
    return [
        Track(absolute_path="/music/a.wav", artist="Astrix", title="Deep Jungle Walk", duration=420),
        Track(absolute_path="/music/b.mp3", artist="Mandragora", title="X", duration=380),
    ]


def test_export_writes_extm3u(tmp_path):
    dest = tmp_path / "set.m3u8"
    exporter_m3u.export_m3u(_tracks(), dest)
    text = dest.read_text(encoding="utf-8")
    assert text.startswith("#EXTM3U")
    assert "#EXTINF:420,Astrix - Deep Jungle Walk" in text
    assert "/music/a.wav" in text
    assert "/music/b.mp3" in text


def test_overwrite_protection(tmp_path):
    dest = tmp_path / "set.m3u8"
    exporter_m3u.export_m3u(_tracks(), dest)
    with pytest.raises(FileExistsError):
        exporter_m3u.export_m3u(_tracks(), dest)
    # explicit overwrite succeeds
    exporter_m3u.export_m3u(_tracks(), dest, overwrite=True)
