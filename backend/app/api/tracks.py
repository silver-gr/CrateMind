"""Track listing, detail, and DJ-profile editing."""
from __future__ import annotations

import json
import math
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse
from sqlmodel import Session, select

from ..db import get_session, reindex_track
from ..models import (
    ArtistProfile,
    PlayEvent,
    SoundCloudTrack,
    Tag,
    Track,
    TrackCue,
    TrackDJProfile,
    TrackDownbeat,
    TrackSoundCloudMatch,
    TrackTag,
)
from ..schemas import BatchProfileUpdate, CueCreate, CueResponse, CueUpdate, DownbeatSet, PlayLog, ProfileUpdate
from ..services import audit, search, soundcloud, streaming
from ..services.sql_ids import ids_in
from ..services.tempo import effective_bpm

router = APIRouter(prefix="/tracks", tags=["tracks"])


def _json_array(value: str | None) -> list[str] | None:
    if not value:
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, list) else None


def _artist_prefill_payload(track: Track, artist_profile: ArtistProfile | None) -> dict | None:
    if artist_profile is None:
        return None
    track_bpm = effective_bpm(track)
    bpm_conflict = False
    bpm_min = artist_profile.typical_bpm_min
    bpm_max = artist_profile.typical_bpm_max
    # Guard on numeric type, not just non-None: rows enriched before LLM values
    # were validated may hold a str (e.g. "120-124"), which would 500 the
    # comparison below.
    if (
        isinstance(track_bpm, (int, float))
        and isinstance(bpm_min, (int, float))
        and isinstance(bpm_max, (int, float))
    ):
        bpm_conflict = not (bpm_min <= track_bpm <= bpm_max)

    return {
        "artist_profile_id": artist_profile.id,
        "canonical_name": artist_profile.canonical_name,
        "scene_cluster": artist_profile.scene_cluster,
        "primary_subgenre": artist_profile.primary_subgenre,
        "secondary_subgenres": _json_array(artist_profile.secondary_subgenres_json),
        "energy_range": [artist_profile.energy_min, artist_profile.energy_max],
        "set_role_hints": _json_array(artist_profile.set_role_hints_json),
        "confidence_label": artist_profile.confidence_label,
        "needs_review": artist_profile.needs_review,
        "bpm_conflict": bpm_conflict,
        "reason": "artist profile prefill",
    }


def _track_payload(session: Session, track: Track) -> dict:
    prof = session.get(TrackDJProfile, track.id)
    artist_profile = None
    if track.artist_normalized:
        artist_profile = session.exec(
            select(ArtistProfile).where(ArtistProfile.normalized_name == track.artist_normalized)
        ).first()
    tag_rows = session.exec(
        select(Tag).join(TrackTag, TrackTag.tag_id == Tag.id).where(
            TrackTag.track_id == track.id
        )
    ).all()
    payload = {
        "track": {
            **track.model_dump(mode="json"),
            "artist_prefill": _artist_prefill_payload(track, artist_profile),
        },
        "profile": prof.model_dump(mode="json") if prof else None,
        "tags": [t.model_dump(mode="json") for t in tag_rows],
    }
    from ..services.canonical_library import overlay
    payload["track"] = overlay([payload["track"]], session)[0]
    payload.update(soundcloud.track_detail(session, track.id))
    return payload


def _list_payload(session: Session, tracks: list[Track]) -> list[dict]:
    """Serialize a track list, merging in a small DJ-profile summary per row.

    One bulk lookup (no N+1). Profiles are created lazily, so most untagged
    tracks have NO profile row → the summary keys are emitted as null. Purely
    additive and read-only; it never writes or mutates anything.
    """
    ids = [t.id for t in tracks]
    normalized_names = sorted({t.artist_normalized for t in tracks if t.artist_normalized})
    prof_map: dict[int, TrackDJProfile] = {}
    artist_map: dict[str, ArtistProfile] = {}
    soundcloud_map: dict[int, tuple[int | None, int | None]] = {}
    if ids:  # guard against an empty IN ()
        rows = session.exec(
            select(TrackDJProfile).where(ids_in(TrackDJProfile.track_id, ids))
        ).all()
        prof_map = {p.track_id: p for p in rows}
        soundcloud_rows = session.exec(
            select(
                TrackSoundCloudMatch.track_id,
                SoundCloudTrack.playback_count,
                SoundCloudTrack.likes_count,
            )
            .join(
                SoundCloudTrack,
                SoundCloudTrack.soundcloud_track_id
                == TrackSoundCloudMatch.soundcloud_track_id,
            )
            .where(ids_in(TrackSoundCloudMatch.track_id, ids))
        ).all()
        soundcloud_map = {
            track_id: (playback_count, likes_count)
            for track_id, playback_count, likes_count in soundcloud_rows
        }
    if normalized_names:
        artist_rows = session.exec(
            select(ArtistProfile).where(ids_in(ArtistProfile.normalized_name, normalized_names))
        ).all()
        artist_map = {p.normalized_name: p for p in artist_rows}
    out: list[dict] = []
    for t in tracks:
        row = t.model_dump(mode="json")
        p = prof_map.get(t.id)
        row["personal_status"] = p.personal_status if p else None
        row["energy"] = p.energy if p else None
        row["valence"] = p.valence if p else None
        row["darkness"] = p.darkness if p else None
        row["melody"] = p.melody if p else None
        row["weirdness"] = p.weirdness if p else None
        row["set_role"] = p.set_role if p else None
        row["psy_substyle"] = p.psy_substyle if p else None
        soundcloud_counts = soundcloud_map.get(t.id)
        row["soundcloud_playback_count"] = soundcloud_counts[0] if soundcloud_counts else None
        row["soundcloud_likes_count"] = soundcloud_counts[1] if soundcloud_counts else None
        row["artist_prefill"] = _artist_prefill_payload(t, artist_map.get(t.artist_normalized or ""))
        out.append(row)
    from ..services.canonical_library import overlay
    return overlay(out, session)


@router.get("")
def list_tracks(
    q: str | None = None,
    limit: int = Query(200, le=10000),
    offset: int = 0,
    session: Session = Depends(get_session),
):
    if q:
        tracks = search.search(session, q, limit=limit, offset=offset)
    else:
        tracks = list(session.exec(
            select(Track).order_by(Track.artist, Track.title).limit(limit).offset(offset)
        ).all())
    return _list_payload(session, tracks)


@router.get("/search")
def search_tracks(
    q: str = "",
    limit: int = Query(200, le=10000),
    offset: int = 0,
    session: Session = Depends(get_session),
):
    tracks = search.search(session, q, limit=limit, offset=offset)
    return _list_payload(session, tracks)


@router.get("/count")
def count_tracks(q: str = "", session: Session = Depends(get_session)):
    return {"count": search.count(session, q)}


@router.get("/key-stats")
def key_stats(session: Session = Depends(get_session)):
    from ..services.musical_key import key_stats as summarize_keys

    return summarize_keys(session)


@router.get("/{track_id}")
def get_track(track_id: int, session: Session = Depends(get_session)):
    track = session.get(Track, track_id)
    if track is None:
        raise HTTPException(404, "track not found")
    return _track_payload(session, track)


# Browser/ffprobe metadata and rounded millisecond capture can differ slightly.
# Accept at most 100ms beyond a known duration; never clamp a saved bookmark.
CUE_DURATION_TOLERANCE_MS = 100


def _cue_track(session: Session, track_id: int) -> Track:
    track = session.get(Track, track_id)
    if track is None:
        raise HTTPException(404, "track not found")
    return track


def _track_cue(session: Session, track_id: int, cue_id: int) -> TrackCue:
    cue = session.exec(
        select(TrackCue).where(TrackCue.track_id == track_id, TrackCue.id == cue_id)
    ).first()
    if cue is None:
        raise HTTPException(404, "cue not found")
    return cue


def _validate_cue_position(track: Track, position_ms: int) -> None:
    duration = track.duration
    if duration is not None and math.isfinite(duration) and duration > 0:
        if position_ms > duration * 1000 + CUE_DURATION_TOLERANCE_MS:
            raise HTTPException(422, "cue position exceeds track duration (100ms tolerance)")


@router.get("/{track_id}/cues", response_model=list[CueResponse])
def list_cues(track_id: int, session: Session = Depends(get_session)):
    _cue_track(session, track_id)
    return session.exec(
        select(TrackCue).where(TrackCue.track_id == track_id)
        .order_by(TrackCue.position_ms, TrackCue.id)
    ).all()


@router.post("/{track_id}/cues", response_model=CueResponse, status_code=201)
def create_cue(track_id: int, req: CueCreate, session: Session = Depends(get_session)):
    track = _cue_track(session, track_id)
    _validate_cue_position(track, req.position_ms)
    now = datetime.now(UTC)
    cue = TrackCue(track_id=track_id, **req.model_dump(), created_at=now, updated_at=now)
    session.add(cue)
    session.commit()
    session.refresh(cue)
    return cue


@router.patch("/{track_id}/cues/{cue_id}", response_model=CueResponse)
def update_cue(
    track_id: int, cue_id: int, req: CueUpdate, session: Session = Depends(get_session),
):
    track = _cue_track(session, track_id)
    cue = _track_cue(session, track_id, cue_id)
    changes = req.model_dump(exclude_unset=True)
    if "position_ms" in changes:
        _validate_cue_position(track, changes["position_ms"])
    if changes:
        for field, value in changes.items():
            setattr(cue, field, value)
        cue.updated_at = datetime.now(UTC)
        session.add(cue)
        session.commit()
        session.refresh(cue)
    return cue


@router.delete("/{track_id}/cues/{cue_id}", status_code=204)
def delete_cue(track_id: int, cue_id: int, session: Session = Depends(get_session)):
    _cue_track(session, track_id)
    cue = _track_cue(session, track_id, cue_id)
    session.delete(cue)
    session.commit()
    return Response(status_code=204)


@router.get("/{track_id}/downbeat")
def get_downbeat(track_id: int, session: Session = Depends(get_session)):
    _cue_track(session, track_id)
    row = session.exec(select(TrackDownbeat).where(TrackDownbeat.track_id == track_id)).first()
    return {"downbeat_s": row.downbeat_s if row else None}


@router.post("/{track_id}/downbeat")
def set_downbeat(track_id: int, req: DownbeatSet, session: Session = Depends(get_session)):
    track = _cue_track(session, track_id)
    value = req.downbeat_s
    if not math.isfinite(value) or value < 0:
        raise HTTPException(422, "downbeat must be a finite time >= 0")
    if track.duration is not None and math.isfinite(track.duration) and track.duration > 0 and value > track.duration:
        raise HTTPException(422, "downbeat exceeds track duration")
    row = session.exec(select(TrackDownbeat).where(TrackDownbeat.track_id == track_id)).first()
    if row is None:
        row = TrackDownbeat(track_id=track_id, downbeat_s=value)
    row.downbeat_s = value
    row.updated_at = datetime.now(UTC)
    session.add(row)
    session.commit()
    return {"downbeat_s": value}


@router.delete("/{track_id}/downbeat", status_code=204)
def delete_downbeat(track_id: int, session: Session = Depends(get_session)):
    _cue_track(session, track_id)
    row = session.exec(select(TrackDownbeat).where(TrackDownbeat.track_id == track_id)).first()
    if row is not None:
        session.delete(row)
        session.commit()
    return Response(status_code=204)


@router.get("/{track_id}/audio")
def stream_audio(track_id: int, request: Request, session: Session = Depends(get_session)):
    """Stream an indexed track's audio for in-app audition.

    Security: the file is resolved from the DB by integer id only — the client
    never supplies a path, so arbitrary-file access is impossible. Read-only;
    never mutates the file. Supports HTTP Range so the browser can seek.
    """
    track = session.get(Track, track_id)
    if track is None:
        raise HTTPException(404, "track not found")

    content_type = streaming.content_type_for(track.extension)
    if content_type is None:
        raise HTTPException(415, f"unsupported audio format for in-browser audition: .{track.extension}")

    from ..services.library_paths import resolve_source_path

    try:
        path = resolve_source_path(track.absolute_path)
    except OSError as error:
        raise HTTPException(410, "Το αρχείο ήχου δεν είναι διαθέσιμο σε αυτή τη συσκευή.") from error
    if not path.is_file():
        raise HTTPException(410, "audio file no longer present on disk")
    size = path.stat().st_size

    rng = streaming.parse_range(request.headers.get("range"), size)
    base_headers = {"Accept-Ranges": "bytes"}

    if rng == "invalid":
        return Response(
            status_code=416,
            headers={"Content-Range": f"bytes */{size}", "Accept-Ranges": "bytes"},
        )

    if rng is None:
        return StreamingResponse(
            streaming.iter_file_range(path, 0, max(size - 1, 0)),
            media_type=content_type,
            headers={**base_headers, "Content-Length": str(size)},
        )

    start, end = rng
    return StreamingResponse(
        streaming.iter_file_range(path, start, end),
        status_code=206,
        media_type=content_type,
        headers={
            **base_headers,
            "Content-Range": f"bytes {start}-{end}/{size}",
            "Content-Length": str(end - start + 1),
        },
    )


@router.get("/{track_id}/playback-loudness")
def get_track_playback_loudness(track_id: int, session: Session = Depends(get_session)):
    """Read-only loudness metadata for optional, peak-safe playback leveling."""
    from ..services.playback_loudness import (
        MeasurementBusy, SourceUnavailable, get_playback_loudness,
    )

    track = session.get(Track, track_id)
    if track is None:
        raise HTTPException(404, "track not found")
    try:
        return get_playback_loudness(track_id, track.absolute_path)
    except SourceUnavailable as error:
        raise HTTPException(410, "Το αρχείο ήχου δεν είναι διαθέσιμο σε αυτή τη συσκευή.") from error
    except MeasurementBusy as error:
        raise HTTPException(503, "Η μέτρηση έντασης είναι απασχολημένη.",
                            headers={"Retry-After": "2"}) from error


@router.get("/{track_id}/waveform")
def get_track_waveform(track_id: int, session: Session = Depends(get_session)):
    """Get real audio waveform peaks for a track.
    Cached on disk so subsequent calls return in <1ms.
    """
    track = session.get(Track, track_id)
    if track is None:
        raise HTTPException(404, "track not found")
    if not track.absolute_path:
        return {"peaks": []}

    from ..services.waveform import get_or_compute_waveform
    return get_or_compute_waveform(track.id, track.absolute_path)


@router.get("/{track_id}/waveform/detail")
def get_track_waveform_detail(track_id: int, request: Request, session: Session = Depends(get_session)):
    """CMWD v2 RMS/peak/RGB detail waveform; see services/waveform_detail.py."""
    from ..services.waveform_detail import detail_etag, get_or_compute_detail

    track = session.get(Track, track_id)
    if track is None:
        raise HTTPException(404, "track not found")
    headers = {"Cache-Control": "private, no-cache"}
    etag = detail_etag(track.absolute_path) if track.absolute_path else None
    if etag is None:
        raise HTTPException(404, "detail waveform unavailable")
    headers["ETag"] = etag
    candidates = {t.strip().removeprefix("W/") for t in request.headers.get("if-none-match", "").split(",")}
    if etag in candidates or "*" in candidates:
        return Response(status_code=304, headers=headers)
    result = get_or_compute_detail(track.id, track.absolute_path)
    if result is None:
        raise HTTPException(404, "detail waveform unavailable")
    headers["ETag"] = result[0]
    return Response(result[1], media_type="application/octet-stream", headers=headers)


@router.get("/{track_id}/waveform/density")
async def get_track_waveform_density(
    track_id: int, request: Request,
    tile_index: int = Query(0, ge=0),
    pixels_per_second: float = Query(128, ge=16, le=8192, allow_inf_nan=False),
    height: int = Query(240, ge=2, le=1024),
    dpr: float = Query(2, ge=.5, le=8, allow_inf_nan=False),
    detail_digest: str | None = Query(None, pattern=r"^[0-9a-fA-F]{32}$"),
    session: Session = Depends(get_session),
):
    """Render signed source-PCM density in a bounded, cancellable alpha tile."""
    import asyncio
    import threading
    import time

    from ..services import waveform_density as density
    from ..services.waveform_detail import detail_etag

    try:
        geometry = density.Geometry(tile_index, pixels_per_second, height, dpr)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    track = session.get(Track, track_id)
    if track is None or not track.absolute_path:
        raise HTTPException(404, "Δεν είναι διαθέσιμο το αρχείο ήχου.")
    if (detail_digest is not None
            and detail_etag(track.absolute_path) != '"' + detail_digest.lower() + '"'):
        raise HTTPException(409, "Το αρχείο ήχου άλλαξε· απαιτείται ανανέωση κυματομορφής.")
    try:
        etag = density.density_etag(track.absolute_path, geometry)
    except density.DensityUnavailable as error:
        raise HTTPException(404, str(error)) from error
    headers = {"Cache-Control": "private, no-cache", "ETag": etag}
    candidates = {value.strip().removeprefix("W/")
                  for value in request.headers.get("if-none-match", "").split(",")}
    if etag in candidates or "*" in candidates:
        return Response(status_code=304, headers=headers)
    if not density.ADMISSION.acquire(False):
        raise HTTPException(503, "Η απόδοση κυματομορφής είναι απασχολημένη.", headers={"Retry-After": "1"})
    cancel_event = threading.Event()
    deadline = time.monotonic() + density.TIMEOUT_S
    # The worker owns this reservation even if the HTTP task is cancelled.
    worker = asyncio.create_task(asyncio.to_thread(
        density.render_density, track.absolute_path, geometry, cancel_event=cancel_event,
        deadline=deadline, admitted=True, detail_digest=detail_digest,
    ))
    try:
        while not worker.done():
            if await request.is_disconnected():
                cancel_event.set()
            await asyncio.wait({worker}, timeout=.05)
        etag, blob = worker.result()
        headers["ETag"] = etag
        return Response(blob, media_type="application/octet-stream", headers=headers)
    except asyncio.CancelledError:
        cancel_event.set()
        # asyncio.wait leaves the worker alive; let it reap FFmpeg and release its slot.
        try:
            await asyncio.shield(worker)
        except (density.DensityCancelled, density.DensityUnavailable, density.DensityChanged, TimeoutError):
            pass
        raise
    except density.DensityChanged as error:
        raise HTTPException(409, str(error)) from error
    except density.DensityCancelled as error:
        raise HTTPException(499, str(error)) from error
    except density.DensityUnavailable as error:
        raise HTTPException(404, str(error)) from error
    except TimeoutError as error:
        raise HTTPException(504, str(error)) from error
    finally:
        cancel_event.set()


@router.get("/{track_id}/artwork")
def get_track_artwork(track_id: int, session: Session = Depends(get_session)):
    """Get track artwork: embedded in audio file if present, else SoundCloud match, else 404."""
    from ..services.artwork import get_track_artwork_response
    return get_track_artwork_response(session, track_id)


def _apply_profile(session: Session, track_id: int, update: ProfileUpdate) -> TrackDJProfile:
    prof = session.get(TrackDJProfile, track_id)
    before = prof.model_dump(mode="json") if prof else None
    if prof is None:
        prof = TrackDJProfile(track_id=track_id)
    data = update.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(prof, k, v)
    prof.updated_at = datetime.now(UTC)
    session.add(prof)
    session.commit()
    reindex_track(session, track_id)  # notes feed FTS
    audit.log(session, "profile_update", "track", track_id, before, prof.model_dump(mode="json"))
    return prof


@router.patch("/{track_id}/profile")
def update_profile(track_id: int, update: ProfileUpdate, session: Session = Depends(get_session)):
    if session.get(Track, track_id) is None:
        raise HTTPException(404, "track not found")
    prof = _apply_profile(session, track_id, update)
    return prof.model_dump(mode="json")


@router.post("/{track_id}/play")
def log_play(track_id: int, req: PlayLog, session: Session = Depends(get_session)):
    """Record a play: drives play_count / last_played_at, which feed the
    not_recent / played_recently / never_played search tokens."""
    track = session.get(Track, track_id)
    if track is None:
        raise HTTPException(404, "track not found")
    now = datetime.now(UTC)
    session.add(PlayEvent(
        track_id=track_id, set_id=req.set_id, played_at=now,
        context=req.context, crowd_reaction=req.crowd_reaction, notes=req.notes,
    ))
    track.play_count += 1
    track.last_played_at = now
    session.add(track)
    session.commit()
    return {"track_id": track_id, "play_count": track.play_count,
            "last_played_at": now.isoformat()}


@router.post("/batch-profile")
def batch_profile(req: BatchProfileUpdate, session: Session = Depends(get_session)):
    updated = 0
    for tid in req.track_ids:
        if session.get(Track, tid) is None:
            continue
        _apply_profile(session, tid, req.profile)
        updated += 1
    return {"updated": updated}
