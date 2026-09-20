"""Embedded audio artwork extraction and SoundCloud fallback."""
from __future__ import annotations

import base64
import logging
from pathlib import Path
from typing import Optional, Tuple

from fastapi import HTTPException
from fastapi.responses import FileResponse, RedirectResponse
from mutagen import File
from mutagen.mp4 import MP4Cover
from sqlmodel import Session, select

from ..config import get_settings
from ..models import SoundCloudTrack, Track, TrackSoundCloudMatch

logger = logging.getLogger(__name__)


def _artwork_cache_dir() -> Path:
    settings = get_settings()
    d = settings.db_file.parent / "cache" / "artwork"
    d.mkdir(parents=True, exist_ok=True)
    return d


def extract_embedded_artwork(audio_path: str) -> Optional[Tuple[bytes, str]]:
    """Extract embedded artwork bytes and MIME type from an audio file using mutagen.

    Supports:
    - ID3 (MP3, AIFF, WAV with ID3): APIC frames
    - MP4 / M4A: covr atoms
    - FLAC / OGG: Picture objects and METADATA_BLOCK_PICTURE
    """
    path = Path(audio_path)
    if not path.is_file():
        return None

    try:
        f = File(str(path))
        if not f:
            return None

        # 1. ID3 tags (MP3, AIFF, WAV with ID3)
        if f.tags:
            for k, v in f.tags.items():
                if k.startswith("APIC"):
                    mime = getattr(v, "mime", "image/jpeg") or "image/jpeg"
                    return v.data, mime
                elif k == "covr" and v:
                    cov = v[0]
                    fmt = getattr(cov, "imageformat", None)
                    mime = "image/png" if fmt == MP4Cover.FORMAT_PNG else "image/jpeg"
                    return bytes(cov), mime
                elif k.lower() == "metadata_block_picture" and v:
                    try:
                        raw = base64.b64decode(v[0])
                        from mutagen.flac import Picture
                        pic = Picture(raw)
                        return pic.data, pic.mime or "image/jpeg"
                    except Exception:
                        pass

        # 2. FLAC pictures attribute
        if hasattr(f, "pictures") and f.pictures:
            pic = f.pictures[0]
            mime = getattr(pic, "mime", "image/jpeg") or "image/jpeg"
            return pic.data, mime

    except Exception as exc:
        logger.debug("mutagen artwork extraction failed for %s: %s", audio_path, exc)

    return None


def get_track_artwork_response(session: Session, track_id: int):
    """Serve track artwork from cache/file, fallback to SoundCloud, or 404."""
    track = session.get(Track, track_id)
    if track is None:
        raise HTTPException(404, "track not found")

    cache_dir = _artwork_cache_dir()
    cache_jpg = cache_dir / f"{track_id}.jpg"
    cache_png = cache_dir / f"{track_id}.png"
    cache_none = cache_dir / f"{track_id}.none"

    # Fast path 1: cached embedded artwork
    if cache_jpg.is_file():
        return FileResponse(
            cache_jpg,
            media_type="image/jpeg",
            headers={"Cache-Control": "public, max-age=604800, immutable"},
        )
    if cache_png.is_file():
        return FileResponse(
            cache_png,
            media_type="image/png",
            headers={"Cache-Control": "public, max-age=604800, immutable"},
        )

    # Extraction path: if we haven't already marked it as having no embedded art
    if not cache_none.is_file() and track.absolute_path:
        art = extract_embedded_artwork(track.absolute_path)
        if art:
            data, mime = art
            is_png = "png" in mime.lower()
            out_file = cache_png if is_png else cache_jpg
            try:
                out_file.write_bytes(data)
                return FileResponse(
                    out_file,
                    media_type="image/png" if is_png else "image/jpeg",
                    headers={"Cache-Control": "public, max-age=604800, immutable"},
                )
            except Exception as exc:
                logger.warning("failed writing artwork cache for track %s: %s", track_id, exc)
                from fastapi import Response
                return Response(
                    content=data,
                    media_type=mime,
                    headers={"Cache-Control": "public, max-age=604800, immutable"},
                )
        else:
            try:
                cache_none.touch()
            except Exception:
                pass

    # Fast path 2: fallback to SoundCloud artwork
    sc_art = session.exec(
        select(SoundCloudTrack.artwork_url)
        .join(
            TrackSoundCloudMatch,
            TrackSoundCloudMatch.soundcloud_track_id == SoundCloudTrack.soundcloud_track_id,
        )
        .where(TrackSoundCloudMatch.track_id == track_id)
    ).first()

    if sc_art:
        return RedirectResponse(
            url=sc_art,
            status_code=307,
            headers={"Cache-Control": "public, max-age=86400"},
        )

    raise HTTPException(404, "artwork not found")
