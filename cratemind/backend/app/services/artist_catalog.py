"""ArtistProfile rebuild helpers."""
from __future__ import annotations

from collections import Counter
from datetime import UTC, datetime

from sqlmodel import Session, select

from ..models import ArtistProfile, Track
from .artist_normalizer import normalize_primary_artist_name, primary_artist_name


def rebuild_artist_profiles(session: Session) -> dict[str, int]:
    """Refresh track artist keys and aggregate ArtistProfile rows from tracks."""
    tracks = session.exec(
        select(Track).where(Track.missing == False)  # noqa: E712
    ).all()

    buckets: dict[str, Counter[str]] = {}
    updated_tracks = 0
    now = datetime.now(UTC)

    for track in tracks:
        normalized = normalize_primary_artist_name(track.artist)
        if track.artist_normalized != normalized:
            track.artist_normalized = normalized
            session.add(track)
            updated_tracks += 1
        if normalized is None:
            continue
        canonical = primary_artist_name(track.artist) or track.artist or normalized
        buckets.setdefault(normalized, Counter())[canonical] += 1

    existing = {
        profile.normalized_name: profile
        for profile in session.exec(select(ArtistProfile)).all()
    }

    created = 0
    updated_profiles = 0
    for normalized_name, names in buckets.items():
        profile = existing.get(normalized_name)
        if profile is None:
            profile = ArtistProfile(
                normalized_name=normalized_name,
                canonical_name=names.most_common(1)[0][0],
                track_count=sum(names.values()),
            )
            created += 1
        else:
            profile.canonical_name = names.most_common(1)[0][0]
            profile.track_count = sum(names.values())
            profile.updated_at = now
            updated_profiles += 1
        session.add(profile)

    for normalized_name, profile in existing.items():
        if normalized_name in buckets:
            continue
        if profile.track_count != 0:
            profile.track_count = 0
            profile.updated_at = now
            session.add(profile)
            updated_profiles += 1

    session.commit()
    return {
        "tracks_seen": len(tracks),
        "tracks_updated": updated_tracks,
        "artists_seen": len(buckets),
        "artists_created": created,
        "artists_updated": updated_profiles,
    }
