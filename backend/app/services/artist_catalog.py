"""ArtistProfile rebuild helpers.

With «Καθαρά ονόματα» on, an artist is the artist folder the names job chose (`track_names.folder`), keyed
`"act:" + names_store.act_key(folder)` in `tracks.artist_normalized`; a track with an open or no-artist row
has no artist, and a track without a row keeps today's key. With the switch off every key is today's
(`normalize_primary_artist_name`). The two key sets live side by side in `artist_profiles` (a colon never
appears in today's keys); no profile or review is ever deleted or re-pointed by a switch change. A new key
gets a copy of one old profile and its review when the two map one to one by majority (`carry_sources`).
"""
from __future__ import annotations

import logging
import threading
from collections import Counter, defaultdict
from datetime import UTC, datetime
from typing import NamedTuple

from sqlmodel import Session, select

from ..models import ArtistProfile, ArtistReview, Track, TrackName
from . import names_store, names_switch
from .artist_intelligence import PLACEHOLDER_ARTISTS
from .artist_normalizer import normalize_primary_artist_name, primary_artist_name

logger = logging.getLogger(__name__)
ACT_PREFIX = "act:"
UNKNOWN_FOLDER = "Unknown Artist"  # the engine's folder for a track with no artist (names.UNKNOWN_ARTIST)
_ACT_STATUSES = ("sure", "look", "hand")
_PROFILE_COPY = ("aliases_json", "scene_cluster", "primary_subgenre", "secondary_subgenres_json",
                 "typical_bpm_min", "typical_bpm_max", "energy_min", "energy_max", "set_role_hints_json",
                 "confidence_label", "needs_review", "notes", "raw_llm_json", "last_enriched_at")
_REVIEW_COPY = ("baseline_json", "candidate_json", "state", "error", "confirmed_choice", "confirmed_at",
                "updated_at")
# The scan, a names run, the switch and «Ενημέρωση λίστας» all rebuild; one at a time, so no two create a key.
_LOCK = threading.Lock()


class Carry(NamedTuple):
    sources: dict[str, str]  # new key -> the old key whose profile it copies
    merges: dict[str, list[str]]  # new key -> its two or more old keys
    splits: dict[str, list[str]]  # old key -> its two or more new keys


def carry_sources(previous: dict[int, str | None], new: dict[int, str | None],
                  placeholders=PLACEHOLDER_ARTISTS) -> Carry:
    """Pure. `previous` and `new` map track id -> artist key (None: no artist). A new key copies an old one when
    that old key gave it more of its tracks than any other old key did (a tie copies nothing) and more than half
    of that old key's tracks went to it. A placeholder or missing old key is no source, and its tracks count on
    neither side; an old key's tracks that now have no artist still count as gone elsewhere."""
    flows: Counter[tuple[str, str]] = Counter()
    out_of: Counter[str] = Counter()
    for track_id, old in previous.items():
        if old is None or old in placeholders:
            continue
        out_of[old] += 1
        key = new.get(track_id)
        if key is None or key in placeholders:
            continue
        flows[(old, key)] += 1
    olds: dict[str, list[str]] = defaultdict(list)
    news: dict[str, list[str]] = defaultdict(list)
    for old, key in flows:
        olds[key].append(old)
        news[old].append(key)
    sources = {}
    for key, givers in olds.items():
        shares = sorted((flows[(old, key)] for old in givers), reverse=True)
        old = max(givers, key=lambda o: flows[(o, key)])
        if (len(shares) == 1 or shares[0] > shares[1]) and 2 * shares[0] > out_of[old]:
            sources[key] = old
    return Carry(sources,
                 {k: sorted(v) for k, v in olds.items() if len(v) > 1},
                 {k: sorted(v) for k, v in news.items() if len(v) > 1})


def _today(track: Track) -> tuple[str | None, str | None]:
    normalized = normalize_primary_artist_name(track.artist)
    if normalized is None:
        return None, None
    return normalized, primary_artist_name(track.artist) or track.artist or normalized


def _keys(session: Session, tracks: list[Track]) -> dict[int, tuple[str | None, str | None]]:
    """Track id -> (artist key, spelling for the profile name); today's for every track while the switch is off."""
    if not names_switch.is_on(session):
        return {t.id: _today(t) for t in tracks}
    rows = {tid: (status, folder) for tid, status, folder in session.exec(
        select(TrackName.track_id, TrackName.status, TrackName.folder)).all()}
    keys = {}
    for t in tracks:
        if t.id not in rows:
            keys[t.id] = _today(t)  # never read, or no names run yet: today's value
            continue
        status, folder = rows[t.id]
        act = names_store.act_key(folder or "")
        if status not in _ACT_STATUSES or folder == UNKNOWN_FOLDER:
            keys[t.id] = (None, None)  # open or no artist: on /names, no artist page
        elif not act:
            keys[t.id] = _today(t)
        else:
            keys[t.id] = (ACT_PREFIX + act, folder)
    return keys


def _copy(session: Session, source: ArtistProfile, normalized_name: str, canonical: str, count: int) -> ArtistProfile:
    """A new profile with `source`'s findings, and a copy of its review; `source` and its review stay as they are."""
    profile = ArtistProfile(normalized_name=normalized_name, canonical_name=canonical, track_count=count,
                            **{f: getattr(source, f) for f in _PROFILE_COPY})
    session.add(profile)
    session.flush()
    review = session.get(ArtistReview, source.id)
    if review is not None:
        session.add(ArtistReview(artist_id=profile.id, **{f: getattr(review, f) for f in _REVIEW_COPY}))
    return profile


def rebuild_artist_profiles(session: Session) -> dict[str, int]:
    """Refresh track artist keys and aggregate ArtistProfile rows from tracks."""
    with _LOCK:
        return _rebuild(session)


def rebuild_quietly(session: Session) -> dict[str, int] | None:
    """The rebuild after a names run or a switch change: a failure is logged and rolled back, never raised (as the
    scan's rebuild); the next rebuild puts the keys right."""
    try:
        return rebuild_artist_profiles(session)
    except Exception:  # noqa: BLE001 - the names run or the switch already committed
        logger.exception("artist_rebuild_failed")
        session.rollback()
        return None


def _rebuild(session: Session) -> dict[str, int]:
    tracks = session.exec(
        select(Track).where(Track.missing == False)  # noqa: E712
    ).all()

    keys = _keys(session, tracks)
    previous = {t.id: t.artist_normalized for t in tracks}
    buckets: dict[str, Counter[str]] = {}
    updated_tracks = 0
    now = datetime.now(UTC)

    for track in tracks:
        normalized, canonical = keys[track.id]
        if track.artist_normalized != normalized:
            track.artist_normalized = normalized
            session.add(track)
            updated_tracks += 1
        if normalized is None:
            continue
        buckets.setdefault(normalized, Counter())[canonical] += 1

    existing = {
        profile.normalized_name: profile
        for profile in session.exec(select(ArtistProfile)).all()
    }
    # The copy runs only when the key set changes: act keys now (switch on), or tracks coming from act keys.
    carry = None
    if any(k is not None and k.startswith(ACT_PREFIX) for k in [*buckets, *previous.values()]):
        carry = carry_sources(previous, {tid: key for tid, (key, _) in keys.items()})
    carried = 0

    created = 0
    updated_profiles = 0
    for normalized_name, names in buckets.items():
        profile = existing.get(normalized_name)
        if profile is None and not normalized_name.startswith(ACT_PREFIX):
            # Re-key an unambiguous legacy ASCII-only profile without losing enrichment (never an act profile).
            legacy = [p for key, p in existing.items() if key not in buckets and not key.startswith(ACT_PREFIX)
                      and normalize_primary_artist_name(p.canonical_name) == normalized_name]
            if len(legacy) == 1:
                profile = legacy[0]
                existing.pop(profile.normalized_name)
                profile.normalized_name = normalized_name
                existing[normalized_name] = profile
        if profile is None and carry is not None:
            old = carry.sources.get(normalized_name)
            # An old act key still in use keeps its finding to itself; today's key may be shared with the act.
            if old is not None and (old not in buckets or not old.startswith(ACT_PREFIX)) and old in existing:
                existing[normalized_name] = _copy(session, existing[old], normalized_name,
                                                  names.most_common(1)[0][0], sum(names.values()))
                carried += 1
                continue
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
        "artists_carried": carried,
        "artists_merged": len(carry.merges) if carry else 0,
        "artists_split": len(carry.splits) if carry else 0,
    }
