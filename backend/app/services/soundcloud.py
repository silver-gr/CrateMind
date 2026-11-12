"""SoundCloud snapshot persistence, guarded matching, and review state."""
from __future__ import annotations

import json
import math
import re
import unicodedata
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Mapping
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from sqlalchemy import func, or_
from sqlmodel import Session, select

from ..models import (
    SoundCloudMatchCandidate,
    SoundCloudTrack,
    Track,
    TrackSoundCloudMatch,
)

_SENSITIVE_FRAGMENTS = ("token", "authorization", "client_id", "oauth", "cookie")
_AUDIO_EXTENSION_RE = re.compile(
    r"\.(?:aac|aiff?|alac|flac|m4a|mp3|ogg|opus|wav|wma)\s*$", re.IGNORECASE
)
_LEADING_TRACK_RE = re.compile(r"^\s*\d{1,3}\s*(?:[-._)]\s*|\s+)")
_DOWNLOAD_NOISE_RE = re.compile(
    r"\b(?:\d{2,4}\s*(?:kbps|kb/s)|free\s*download|download)\b", re.IGNORECASE
)
_BPM_BRACKET_RE = re.compile(
    r"[\[({]\s*\d{2,3}(?:\.\d+)?\s*bpm\s*[\])}]", re.IGNORECASE
)
_FEATURING_RE = re.compile(
    r"\b(?:feat(?:\.|uring)?|f[.\s]*t|versus|vs)\.?\b", re.IGNORECASE
)
_SPACE_RE = re.compile(r"\s+")


@dataclass(frozen=True)
class ParsedSoundCloudTrack:
    soundcloud_track_id: int
    values: dict[str, Any]


@dataclass(frozen=True)
class MatchEvidence:
    title_score: float
    artist_score: float
    duration_score: float
    combined_score: float
    duration_delta_seconds: float | None
    reasons: list[str]
    auto_method: str | None


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _is_sensitive(name: str) -> bool:
    lowered = name.casefold()
    return any(fragment in lowered for fragment in _SENSITIVE_FRAGMENTS)


def _redact_url(value: str) -> str:
    try:
        parts = urlsplit(value)
    except ValueError:
        return value
    if not parts.query:
        return value
    redacted = [
        (key, "[REDACTED]" if _is_sensitive(key) else item_value)
        for key, item_value in parse_qsl(parts.query, keep_blank_values=True)
    ]
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(redacted), parts.fragment))


def sanitize_raw_json(value: Any) -> Any:
    """Recursively redact credential-shaped keys and sensitive URL parameters."""
    if isinstance(value, Mapping):
        return {
            str(key): "[REDACTED]" if _is_sensitive(str(key)) else sanitize_raw_json(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [sanitize_raw_json(item) for item in value]
    if isinstance(value, tuple):
        return [sanitize_raw_json(item) for item in value]
    if isinstance(value, str):
        return _redact_url(value)
    return value


def normalize_match_text(value: str | None) -> str:
    """Normalize identity text without stripping remix or version tokens."""
    if not value:
        return ""
    normalized = unicodedata.normalize("NFKD", value).casefold()
    normalized = "".join(
        character
        for character in normalized
        if not unicodedata.category(character).startswith("M")
    )
    normalized = _AUDIO_EXTENSION_RE.sub(" ", normalized)
    normalized = _LEADING_TRACK_RE.sub("", normalized)
    normalized = _BPM_BRACKET_RE.sub(" ", normalized)
    normalized = _DOWNLOAD_NOISE_RE.sub(" ", normalized)
    normalized = _FEATURING_RE.sub(" ", normalized)
    normalized = "".join(
        " " if unicodedata.category(character).startswith(("P", "S", "Z")) else character
        for character in normalized
    )
    return _SPACE_RE.sub(" ", normalized).strip()


def _token_jaccard(left: str, right: str) -> float:
    left_tokens = set(left.split())
    right_tokens = set(right.split())
    if not left_tokens or not right_tokens:
        return 0.0
    return len(left_tokens & right_tokens) / len(left_tokens | right_tokens)


def duration_similarity(delta_seconds: float | None, *, window_seconds: float = 15.0) -> float:
    """Shared duration evidence. Unknown duration supplies no positive evidence."""
    return max(0.0, 1.0 - delta_seconds / window_seconds) if delta_seconds is not None else 0.0


def weighted_metadata_score(title_score: float, artist_score: float, duration_score: float, *, artist_weight: float = .30) -> float:
    """The existing matcher's title/artist/duration weights, reusable by adapters."""
    return .55 * title_score + artist_weight * artist_score + .15 * duration_score


def _finite_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _integer(value: Any) -> int | None:
    number = _finite_number(value)
    if number is None or not number.is_integer():
        return None
    return int(number)


def _string(value: Any) -> str | None:
    return _redact_url(value.strip()) if isinstance(value, str) and value.strip() else None


def parse_import_item(item: Any, *, run_id: str, fetched_at: str) -> ParsedSoundCloudTrack | None:
    if not isinstance(item, Mapping):
        return None
    nested_track = item.get("track")
    track = nested_track if isinstance(nested_track, Mapping) else item
    track_id = _integer(track.get("id") or track.get("soundcloud_track_id"))
    title = _string(track.get("title"))
    if track_id is None or track_id < 1 or title is None:
        return None

    uploader = track.get("user")
    uploader = uploader if isinstance(uploader, Mapping) else {}
    publisher = track.get("publisher_metadata")
    sanitized_publisher = sanitize_raw_json(publisher) if isinstance(publisher, Mapping) else None
    liked_at = _string(item.get("liked_at") or item.get("created_at"))
    if nested_track is None:
        liked_at = liked_at or _string(track.get("liked_at"))

    values = {
        "soundcloud_track_id": track_id,
        "urn": _string(track.get("urn")),
        "permalink_url": _string(track.get("permalink_url")),
        "title": title,
        "uploader_id": _integer(uploader.get("id") or track.get("uploader_id")),
        "uploader_username": _string(uploader.get("username") or track.get("uploader_username")),
        "uploader_permalink_url": _string(
            uploader.get("permalink_url") or track.get("uploader_permalink_url")
        ),
        "duration_ms": _integer(track.get("duration")) or _integer(track.get("duration_ms")),
        "full_duration_ms": _integer(track.get("full_duration"))
        or _integer(track.get("full_duration_ms")),
        "genre": _string(track.get("genre")),
        "tag_list": _string(track.get("tag_list")),
        "description": _string(track.get("description")),
        "label_name": _string(track.get("label_name")),
        "release_date": _string(track.get("release_date")),
        "created_at": _string(track.get("created_at")),
        "display_date": _string(track.get("display_date")),
        "liked_at": liked_at,
        "likes_count": _integer(track.get("likes_count")),
        "reposts_count": _integer(track.get("reposts_count")),
        "playback_count": _integer(track.get("playback_count")),
        "comment_count": _integer(track.get("comment_count")),
        "download_count": _integer(track.get("download_count")),
        "downloadable": track.get("downloadable")
        if isinstance(track.get("downloadable"), bool)
        else None,
        "artwork_url": _string(track.get("artwork_url")),
        "waveform_url": _string(track.get("waveform_url")),
        "publisher_metadata_json": json.dumps(
            sanitized_publisher, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        )
        if sanitized_publisher is not None
        else None,
        # The typed columns above hold everything read later; the full API item is not kept.
        "raw_json": "{}",
        "available": True,
        "last_seen_run_id": run_id,
        "fetched_at": fetched_at,
    }
    return ParsedSoundCloudTrack(track_id, values)


def _duration_seconds(soundcloud_track: SoundCloudTrack) -> float | None:
    milliseconds = soundcloud_track.full_duration_ms
    if milliseconds is None:
        milliseconds = soundcloud_track.duration_ms
    return milliseconds / 1000 if milliseconds is not None else None


def _local_title(track: Track) -> str:
    return track.title or track.file_name


def _comment_identity_match(track: Track, soundcloud_track: SoundCloudTrack) -> bool:
    comment = track.comment or ""
    if not comment:
        return False
    track_id_pattern = re.compile(
        rf"(?<!\d){re.escape(str(soundcloud_track.soundcloud_track_id))}(?!\d)"
    )
    if track_id_pattern.search(comment):
        return True
    permalink = (soundcloud_track.permalink_url or "").rstrip("/")
    return bool(permalink and permalink in comment)


def score_match(track: Track, soundcloud_track: SoundCloudTrack) -> MatchEvidence:
    local_title = normalize_match_text(_local_title(track))
    provider_title = normalize_match_text(soundcloud_track.title)
    local_artist = normalize_match_text(track.artist)
    provider_artist = normalize_match_text(_soundcloud_artist(soundcloud_track))

    title_exact = bool(local_title and local_title == provider_title)
    artist_exact = bool(local_artist and local_artist == provider_artist)
    title_score = 1.0 if title_exact else _token_jaccard(local_title, provider_title)
    artist_score = _token_jaccard(local_artist, provider_artist)

    provider_duration = _duration_seconds(soundcloud_track)
    duration_delta = None
    duration_score = 0.0
    if track.duration is not None and provider_duration is not None:
        duration_delta = abs(track.duration - provider_duration)
        duration_score = duration_similarity(duration_delta)

    combined = weighted_metadata_score(title_score, artist_score, duration_score)
    reasons: list[str] = []
    if title_exact:
        reasons.append("exact normalized title")
    elif title_score > 0:
        reasons.append(f"title token overlap {title_score:.2f}")
    if artist_exact:
        reasons.append("exact normalized artist")
    elif artist_score > 0:
        reasons.append(f"artist token overlap {artist_score:.2f}")
    if duration_delta is None:
        reasons.append("missing local or provider duration")
    else:
        reasons.append(f"duration difference {duration_delta:.1f} seconds")

    # Keep the historical ranking score/reasons stable while sharing automatic
    # identity guards with the cross-provider matcher. Import lazily because its
    # text/scoring foundation lives in this module.
    from .identity_matching import normalized_item, score_candidate
    provider_performer = None
    if soundcloud_track.publisher_metadata_json:
        try:
            publisher = json.loads(soundcloud_track.publisher_metadata_json)
        except json.JSONDecodeError:
            publisher = None
        if isinstance(publisher, Mapping):
            provider_performer = _string(publisher.get('artist'))
    local_identity = normalized_item({
        'id': 'local:match', 'service': 'local', 'title': _local_title(track),
        'artist': track.artist, 'file_name': track.file_name,
        'duration_ms': track.duration * 1000 if track.duration is not None else None,
    })
    provider_identity = normalized_item({
        'id': 'soundcloud:match', 'service': 'soundcloud', 'title': soundcloud_track.title,
        'artist': provider_performer, 'uploader': soundcloud_track.uploader_username,
        'duration_ms': provider_duration * 1000 if provider_duration is not None else None,
    })
    identity = score_candidate(local_identity, provider_identity)
    auto_method = None
    if _comment_identity_match(track, soundcloud_track) and not identity['evidence']['conflicts']:
        auto_method = "comment_identity"
        reasons.insert(0, "exact SoundCloud ID or permalink in local comment")
    elif identity['class'] in {'HIGH_CONFIDENCE', 'ACCEPTED'}:
        auto_method = "exact_metadata"  # Persisted method remains backward compatible.
        reasons.append("guarded coverage identity policy")

    return MatchEvidence(
        title_score=title_score,
        artist_score=artist_score,
        duration_score=duration_score,
        combined_score=combined,
        duration_delta_seconds=duration_delta,
        reasons=reasons,
        auto_method=auto_method,
    )


def _soundcloud_artist(soundcloud_track: SoundCloudTrack) -> str | None:
    if soundcloud_track.publisher_metadata_json:
        try:
            publisher = json.loads(soundcloud_track.publisher_metadata_json)
        except json.JSONDecodeError:
            publisher = None
        if isinstance(publisher, Mapping):
            artist = _string(publisher.get("artist"))
            if artist:
                return artist
    return soundcloud_track.uploader_username


def _review_eligible(evidence: MatchEvidence) -> bool:
    duration_ok = (
        evidence.duration_delta_seconds is None or evidence.duration_delta_seconds <= 15.0
    )
    return (
        evidence.combined_score >= 0.50
        and evidence.title_score >= 0.50
        and duration_ok
    )


def _reasons(reasons_json: str) -> list[str]:
    try:
        details = json.loads(reasons_json)
    except json.JSONDecodeError:
        return []
    if isinstance(details, list):
        return [reason for reason in details if isinstance(reason, str)]
    if isinstance(details, dict) and isinstance(details.get("reasons"), list):
        return [reason for reason in details["reasons"] if isinstance(reason, str)]
    return []


def _pending_candidate_count(session: Session) -> int:
    return int(
        session.exec(
            select(func.count()).select_from(SoundCloudMatchCandidate).where(
                SoundCloudMatchCandidate.status == "pending"
            )
        ).one()
    )


def _regenerate_candidates(
    session: Session,
    soundcloud_track_ids: set[int],
    *,
    now: str,
    allow_auto_confirm: bool = True,
) -> tuple[int, int]:
    if not soundcloud_track_ids:
        return 0, _pending_candidate_count(session)
    local_tracks = list(session.exec(select(Track)).all())
    provider_tracks = list(
        session.exec(
            select(SoundCloudTrack).where(
                SoundCloudTrack.soundcloud_track_id.in_(soundcloud_track_ids)
            )
        ).all()
    )
    matches = {
        match.track_id: match
        for match in session.exec(select(TrackSoundCloudMatch)).all()
    }
    all_candidates = list(session.exec(select(SoundCloudMatchCandidate)).all())
    candidates_by_pair = {
        (candidate.track_id, candidate.soundcloud_track_id): candidate
        for candidate in all_candidates
    }
    candidates_by_local: dict[int, list[SoundCloudMatchCandidate]] = {}
    for candidate in all_candidates:
        candidates_by_local.setdefault(candidate.track_id, []).append(candidate)

    auto_confirmed = 0
    for local_track in local_tracks:
        if local_track.id is None:
            continue
        existing_match = matches.get(local_track.id)
        if existing_match is not None:
            continue

        for provider_track in provider_tracks:
            pair = (local_track.id, provider_track.soundcloud_track_id)
            prior = candidates_by_pair.get(pair)
            if prior is not None and prior.status == "rejected":
                continue
            evidence = score_match(local_track, provider_track)
            eligible = evidence.auto_method is not None or _review_eligible(evidence)
            if not eligible:
                if prior is not None and prior.status == "pending":
                    session.delete(prior)
                continue

            candidate = prior or SoundCloudMatchCandidate(
                track_id=local_track.id,
                soundcloud_track_id=provider_track.soundcloud_track_id,
                score=evidence.combined_score,
                reasons_json="{}",
                status="pending",
                evaluated_at=now,
            )
            if prior is None:
                candidates_by_local.setdefault(local_track.id, []).append(candidate)
            if candidate.status != "accepted":
                candidate.status = "pending"
                candidate.decided_at = None
            candidate.score = evidence.combined_score
            candidate.reasons_json = json.dumps(
                evidence.reasons, ensure_ascii=False, separators=(",", ":")
            )
            candidate.evaluated_at = now
            session.add(candidate)
            candidates_by_pair[pair] = candidate
        if not allow_auto_confirm:
            continue
        auto_pairs: dict[int, tuple[SoundCloudTrack, MatchEvidence]] = {}
        for candidate in candidates_by_local.get(local_track.id, []):
            if candidate.status == "rejected":
                continue
            candidate_track = session.get(SoundCloudTrack, candidate.soundcloud_track_id)
            if candidate_track is None:
                continue
            evidence = score_match(local_track, candidate_track)
            if evidence.auto_method is not None:
                auto_pairs[candidate.soundcloud_track_id] = (candidate_track, evidence)

        if len(auto_pairs) > 1:
            for soundcloud_track_id in auto_pairs:
                candidate = candidates_by_pair.get((local_track.id, soundcloud_track_id))
                if candidate is not None:
                    candidate.status = "pending"
                    candidate.decided_at = None
                    session.add(candidate)
            continue

        if len(auto_pairs) == 1:
            provider_track, evidence = next(iter(auto_pairs.values()))
            match = TrackSoundCloudMatch(
                track_id=local_track.id,
                soundcloud_track_id=provider_track.soundcloud_track_id,
                confidence=evidence.combined_score,
                method=evidence.auto_method or "exact_metadata",
                reasons_json=json.dumps(
                    evidence.reasons, ensure_ascii=False, separators=(",", ":")
                ),
                matched_at=now,
                confirmed_at=now,
            )
            session.add(match)
            matches[local_track.id] = match
            auto_confirmed += 1
            chosen = candidates_by_pair.get((local_track.id, provider_track.soundcloud_track_id))
            if chosen is not None:
                chosen.status = "accepted"
                chosen.decided_at = now
                session.add(chosen)
            for candidate in candidates_by_local.get(local_track.id, []):
                if candidate.soundcloud_track_id != provider_track.soundcloud_track_id:
                    if candidate.status == "pending":
                        candidate.status = "rejected"
                        candidate.decided_at = now
                        session.add(candidate)

    session.flush()
    return auto_confirmed, _pending_candidate_count(session)


def import_batch(
    session: Session,
    *,
    run_id: str,
    items: list[Any],
    complete: bool,
) -> dict[str, int | bool]:
    fetched_at = _now_iso()
    parsed: dict[int, ParsedSoundCloudTrack] = {}
    malformed = 0
    for item in items:
        parsed_item = parse_import_item(item, run_id=run_id, fetched_at=fetched_at)
        if parsed_item is None:
            malformed += 1
            continue
        parsed[parsed_item.soundcloud_track_id] = parsed_item

    inserted = 0
    updated = 0
    try:
        for parsed_item in parsed.values():
            snapshot = session.get(SoundCloudTrack, parsed_item.soundcloud_track_id)
            if snapshot is None:
                snapshot = SoundCloudTrack(**parsed_item.values)
                inserted += 1
            else:
                for name, value in parsed_item.values.items():
                    setattr(snapshot, name, value)
                updated += 1
            session.add(snapshot)
        session.flush()

        matching_track_ids = set(parsed)
        if complete:
            matching_track_ids = set(
                session.exec(
                    select(SoundCloudTrack.soundcloud_track_id).where(
                        SoundCloudTrack.last_seen_run_id == run_id
                    )
                ).all()
            )
        auto_confirmed, pending_candidates = _regenerate_candidates(
            session,
            matching_track_ids,
            now=fetched_at,
            allow_auto_confirm=complete,
        )
        seen_in_run = int(
            session.exec(
                select(func.count()).select_from(SoundCloudTrack).where(
                    SoundCloudTrack.last_seen_run_id == run_id
                )
            ).one()
        )
        completed = complete and seen_in_run > 0
        if completed:
            unseen = session.exec(
                select(SoundCloudTrack).where(
                    or_(
                        SoundCloudTrack.last_seen_run_id.is_(None),
                        SoundCloudTrack.last_seen_run_id != run_id,
                    ),
                    SoundCloudTrack.available.is_(True),
                )
            ).all()
            for snapshot in unseen:
                snapshot.available = False
                session.add(snapshot)
        session.commit()
    except Exception:
        session.rollback()
        raise

    return {
        "received": len(items),
        "inserted": inserted,
        "updated": updated,
        "auto_confirmed": auto_confirmed,
        "pending_candidates": pending_candidates,
        "malformed": malformed,
        "completed": completed,
    }


def _json_object(value: str | None) -> dict[str, Any] | None:
    if not value:
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def serialize_snapshot(snapshot: SoundCloudTrack) -> dict[str, Any]:
    payload = snapshot.model_dump(mode="json")
    payload.pop("raw_json", None)
    payload["publisher_metadata"] = _json_object(payload.pop("publisher_metadata_json", None))
    from .metadata_display import source_fields
    display = source_fields({'id': payload.get('urn'), 'service': 'soundcloud',
                             'title': payload.get('title'), 'artist': None, 'metadata_json': '{}',
                             'normalized_json': json.dumps({'artist': _string((payload['publisher_metadata'] or {}).get('artist'))})})
    payload.update(display_title=display['title'], display_artist=display['artist'])
    return payload


def serialize_match(match: TrackSoundCloudMatch) -> dict[str, Any]:
    payload = match.model_dump(mode="json")
    payload["reasons"] = _reasons(payload.pop("reasons_json", ""))
    return payload


def serialize_detail_candidate(
    candidate: SoundCloudMatchCandidate,
    snapshot: SoundCloudTrack,
) -> dict[str, Any]:
    return {
        "track_id": candidate.track_id,
        "soundcloud_track_id": candidate.soundcloud_track_id,
        "score": candidate.score,
        "reasons": _reasons(candidate.reasons_json),
        "status": candidate.status,
        "evaluated_at": candidate.evaluated_at,
        "decided_at": candidate.decided_at,
        "soundcloud_track": serialize_snapshot(snapshot),
    }


def serialize_review_candidate(
    candidate: SoundCloudMatchCandidate,
    snapshot: SoundCloudTrack,
) -> dict[str, Any]:
    return {
        "track_id": candidate.track_id,
        "soundcloud_track_id": candidate.soundcloud_track_id,
        "score": candidate.score,
        "reasons": _reasons(candidate.reasons_json),
        "status": candidate.status,
        "evaluated_at": candidate.evaluated_at,
        "decided_at": candidate.decided_at,
        "soundcloud_track": serialize_snapshot(snapshot),
    }


def track_detail(session: Session, track_id: int) -> dict[str, Any]:
    match = session.get(TrackSoundCloudMatch, track_id)
    confirmed = None
    if match is not None:
        snapshot = session.get(SoundCloudTrack, match.soundcloud_track_id)
        if snapshot is not None:
            confirmed = {"track": serialize_snapshot(snapshot), "match": serialize_match(match)}

    candidate_rows = session.exec(
        select(SoundCloudMatchCandidate, SoundCloudTrack)
        .join(
            SoundCloudTrack,
            SoundCloudTrack.soundcloud_track_id
            == SoundCloudMatchCandidate.soundcloud_track_id,
        )
        .where(
            SoundCloudMatchCandidate.track_id == track_id,
            SoundCloudMatchCandidate.status == "pending",
        )
        .order_by(SoundCloudMatchCandidate.score.desc())
    ).all()
    legacy = {
        "soundcloud": confirmed,
        "soundcloud_candidates": [
            serialize_detail_candidate(candidate, snapshot)
            for candidate, snapshot in candidate_rows
        ],
    }
    from .provider_resolution import track_detail as canonical_track_detail
    return canonical_track_detail(session, track_id, legacy)


def summary(session: Session) -> dict[str, int | str | None]:
    def count_rows(statement: Any) -> int:
        return int(session.exec(statement).one())

    last_run = session.exec(
        select(SoundCloudTrack.last_seen_run_id)
        .where(SoundCloudTrack.last_seen_run_id.is_not(None))
        .order_by(SoundCloudTrack.fetched_at.desc())
        .limit(1)
    ).first()
    legacy = {
        "snapshots": count_rows(select(func.count()).select_from(SoundCloudTrack)),
        "available": count_rows(
            select(func.count()).select_from(SoundCloudTrack).where(
                SoundCloudTrack.available.is_(True)
            )
        ),
        "unavailable": count_rows(
            select(func.count()).select_from(SoundCloudTrack).where(
                SoundCloudTrack.available.is_(False)
            )
        ),
        "confirmed_local_tracks": count_rows(
            select(func.count()).select_from(TrackSoundCloudMatch)
        ),
        "pending_candidates": count_rows(
            select(func.count()).select_from(SoundCloudMatchCandidate).where(
                SoundCloudMatchCandidate.status == "pending"
            )
        ),
        "pending_local_tracks": count_rows(
            select(func.count(func.distinct(SoundCloudMatchCandidate.track_id))).where(
                SoundCloudMatchCandidate.status == "pending"
            )
        ),
        "rejected_candidates": count_rows(
            select(func.count()).select_from(SoundCloudMatchCandidate).where(
                SoundCloudMatchCandidate.status == "rejected"
            )
        ),
        "unmatched_soundcloud_tracks": count_rows(
            select(func.count())
            .select_from(SoundCloudTrack)
            .where(
                SoundCloudTrack.available.is_(True),
                ~SoundCloudTrack.soundcloud_track_id.in_(
                    select(TrackSoundCloudMatch.soundcloud_track_id)
                ),
            )
        ),
        "last_import_run_id": last_run,
    }
    from .provider_resolution import summary as canonical_summary
    return canonical_summary(session, legacy)


def review_queue(
    session: Session,
    *,
    limit: int,
    offset: int,
) -> dict[str, Any]:
    total = int(
        session.exec(
            select(func.count()).select_from(SoundCloudMatchCandidate).where(
                SoundCloudMatchCandidate.status == "pending"
            )
        ).one()
    )
    rows = session.exec(
        select(SoundCloudMatchCandidate, Track, SoundCloudTrack)
        .join(Track, Track.id == SoundCloudMatchCandidate.track_id)
        .join(
            SoundCloudTrack,
            SoundCloudTrack.soundcloud_track_id
            == SoundCloudMatchCandidate.soundcloud_track_id,
        )
        .where(SoundCloudMatchCandidate.status == "pending")
        .order_by(SoundCloudMatchCandidate.score.desc(), SoundCloudMatchCandidate.track_id)
        .limit(limit)
        .offset(offset)
    ).all()
    return {
        "items": [
            {
                "local_track": track.model_dump(mode="json"),
                "candidate": serialize_review_candidate(candidate, snapshot),
            }
            for candidate, track, snapshot in rows
        ],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


def accept_candidate(
    session: Session,
    *,
    track_id: int,
    soundcloud_track_id: int,
) -> dict[str, int | str]:
    track = session.get(Track, track_id)
    snapshot = session.get(SoundCloudTrack, soundcloud_track_id)
    candidate = session.get(SoundCloudMatchCandidate, (track_id, soundcloud_track_id))
    if track is None:
        raise LookupError("track not found")
    if snapshot is None:
        raise LookupError("SoundCloud track not found")
    if candidate is None:
        raise LookupError("candidate not found")
    if candidate.status == "rejected":
        raise ValueError("rejected candidate cannot be accepted")

    from .identity_sync import prepare_soundcloud_acceptance, replay_mirror_intents, verify_soundcloud_acceptance
    identity_path = prepare_soundcloud_acceptance(session, track, snapshot)
    if identity_path is not None:
        replay_mirror_intents(session, identity_path)
        verify_soundcloud_acceptance(session, track_id, soundcloud_track_id, identity_path)
        return {'track_id': track_id, 'soundcloud_track_id': soundcloud_track_id, 'status': 'accepted'}

    now = _now_iso()
    existing = session.get(TrackSoundCloudMatch, track_id)
    if existing is None:
        existing = TrackSoundCloudMatch(
            track_id=track_id,
            soundcloud_track_id=soundcloud_track_id,
            confidence=candidate.score,
            method="manual_review",
            reasons_json=candidate.reasons_json,
            matched_at=now,
            confirmed_at=now,
        )
    else:
        existing.soundcloud_track_id = soundcloud_track_id
        existing.confidence = candidate.score
        existing.method = "manual_review"
        existing.reasons_json = candidate.reasons_json
        existing.matched_at = now
        existing.confirmed_at = now
    session.add(existing)

    competing = session.exec(
        select(SoundCloudMatchCandidate).where(
            SoundCloudMatchCandidate.track_id == track_id,
        )
    ).all()
    for row in competing:
        row.status = "accepted" if row.soundcloud_track_id == soundcloud_track_id else "rejected"
        row.decided_at = now
        session.add(row)
    session.commit()
    return {
        "track_id": track_id,
        "soundcloud_track_id": soundcloud_track_id,
        "status": "accepted",
    }


def reject_candidate(
    session: Session,
    *,
    track_id: int,
    soundcloud_track_id: int,
) -> dict[str, int | str]:
    track = session.get(Track, track_id)
    snapshot = session.get(SoundCloudTrack, soundcloud_track_id)
    candidate = session.get(SoundCloudMatchCandidate, (track_id, soundcloud_track_id))
    if track is None:
        raise LookupError("track not found")
    if snapshot is None:
        raise LookupError("SoundCloud track not found")
    if candidate is None:
        raise LookupError("candidate not found")
    if candidate.status != "pending":
        raise ValueError("candidate is not pending")

    from .identity_sync import reject_soundcloud_identity
    reject_soundcloud_identity(session, track, snapshot)

    candidate.status = "rejected"
    candidate.decided_at = _now_iso()
    session.add(candidate)
    session.commit()
    return {
        "track_id": track_id,
        "soundcloud_track_id": soundcloud_track_id,
        "status": "rejected",
    }
