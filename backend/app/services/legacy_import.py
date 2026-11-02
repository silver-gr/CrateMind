"""Explicit Deno v1/v2 metadata reconciliation onto an already scanned catalog.

This adapter never creates audio tracks or rewrites paths. Complete state handoff
uses library_exchange; this retains the older metadata-only import contract.
"""
from __future__ import annotations

import math
from collections import defaultdict
from datetime import UTC, datetime

from sqlmodel import Session, select

from .. import models as m
from ..db import reindex_track
from . import facets as facet_service
from .text_fold import fold_text


def _model_values(model, row, **overrides):
    fields = model.model_fields
    values = {key: value for key, value in row.items() if key in fields}
    values.update(overrides)
    result = model.model_validate(values)
    # Older SQLite/Deno exports serialized UTC timestamps without an offset.
    for key in fields:
        value = getattr(result, key)
        if isinstance(value, datetime) and value.tzinfo is None:
            setattr(result, key, value.replace(tzinfo=UTC))
    return result


def import_metadata(session: Session, payload: dict) -> dict:
    if not isinstance(payload, dict) or payload.get("version") not in {1, 2} or not isinstance(payload.get("tracks"), list):
        raise ValueError("Απαιτείται metadata backup έκδοσης 1 ή 2 με λίστα κομματιών.")
    families = {"tracks", "profiles", "tags", "track_tags", "artist_profiles", "sets", "set_tracks", "pair_notes", "play_events", "facets"}
    for name in families:
        if not isinstance(payload.get(name, []), list) or any(not isinstance(r, dict) for r in payload.get(name, [])):
            raise ValueError(f"Μη έγκυρη λίστα {name}.")
    current = session.exec(select(m.Track)).all()
    by_path = {track.absolute_path: track for track in current}
    hashes = {key: defaultdict(list) for key in ("full_hash", "quick_hash")}
    for track in current:
        for key in hashes:
            if getattr(track, key):
                hashes[key][getattr(track, key)].append(track)
    matched, unmatched, ambiguous = {}, [], []
    for row in payload["tracks"]:
        if not isinstance(row.get("id"), int) or row["id"] in matched:
            raise ValueError("Μη έγκυρα ή διπλά αναγνωριστικά κομματιών στο backup.")
        track = by_path.get(row.get("absolute_path"))
        is_ambiguous = False
        if track is None:
            for key in hashes:
                candidates = hashes[key].get(row.get(key), [])
                if len(candidates) == 1:
                    track = candidates[0]
                    break
                is_ambiguous |= len(candidates) > 1
        if track is None:
            (ambiguous if is_ambiguous else unmatched).append(row["id"])
        else:
            matched[row["id"]] = track
    counts = {key: 0 for key in ("analysis_tracks", "profiles", "tags", "track_tags", "artist_profiles", "sets", "set_tracks", "pair_notes", "play_events",
                                 "skipped_facets", "skipped_facet_links", "replaced_facet_values")}
    conflicts = []
    analysis_fields = ("bpm", "key_text", "bpm_analyzed", "bpm_analyzed_raw", "bpm_analyzed_confidence",
                       "bpm_analyzed_method", "key_analyzed", "key_analyzed_confidence", "analyzed_at", "analysis_error")
    for row in payload["tracks"]:
        track = matched.get(row["id"])
        if track is None:
            continue
        touched = False
        for field in analysis_fields:
            if row.get(field) is not None and getattr(track, field) is None:
                value = _model_values(m.Track, {"absolute_path": track.absolute_path, field: row[field]})
                setattr(track, field, getattr(value, field))
                touched = True
        bpm = row.get("bpm_consensus")
        source = row.get("bpm_consensus_sources")
        incoming_manual = isinstance(source, str) and source.startswith("manual:")
        local_manual = (track.bpm_consensus_sources or "").startswith("manual:")
        if isinstance(bpm, (int, float)) and math.isfinite(bpm) and bpm > 0:
            if track.bpm_consensus is None or (incoming_manual and not local_manual):
                track.bpm_consensus, track.bpm_consensus_sources = bpm, source
                touched = True
            elif incoming_manual and local_manual and bpm != track.bpm_consensus:
                conflicts.append({"track_id": track.id, "field": "bpm_consensus", "resolution": "kept_local"})
        if track.bpm_analyzed is not None or track.key_analyzed is not None:
            track.analysis_error = None
        session.add(track)
        counts["analysis_tracks"] += int(touched)
    for row in payload.get("profiles", []):
        track = matched.get(row.get("track_id"))
        if track is not None:
            session.merge(_model_values(m.TrackDJProfile, row, track_id=track.id))
            counts["profiles"] += 1
    # Vocabularies and their values go through the facets service, so the
    # single-value rule holds; what it refuses is skipped and counted.
    skipped_keys = set()
    for row in payload.get("facets", []):
        key = row.get("key")
        if not isinstance(key, str) or facet_service.get_by_key(session, key) is not None:
            continue
        try:
            facet = facet_service.create_facet(session, row.get("label") or key, bool(row.get("multi", True)),
                                               key=key, commit=False)
        except facet_service.FacetError:
            skipped_keys.add(key)
            counts["skipped_facets"] += 1
            continue
        if isinstance(row.get("sort_order"), int):
            facet.sort_order = row["sort_order"]
            session.add(facet)
    tag_map, value_map, skipped_tags = {}, {}, set()
    for row in payload.get("tags", []):
        name = row.get("name") or ""
        key, sep, value = name.partition(":")
        if sep and key in skipped_keys:
            skipped_tags.add(row["id"])
            continue
        facet = facet_service.get_by_key(session, key) if sep else None
        if facet is not None:
            existing = facet_service.value_ids(session, facet, fold_text(value.strip()))
            try:
                value_map[row["id"]] = existing[0] if existing else \
                    facet_service.add_value(session, facet.id, value, commit=False).id
            except facet_service.FacetError:
                skipped_tags.add(row["id"])
                continue
            counts["tags"] += int(not existing)
            continue
        tag = session.exec(select(m.Tag).where(m.Tag.name == row.get("name"))).first()
        if tag is None:
            tag = _model_values(m.Tag, row, id=None)
            session.add(tag)
            session.flush()
            counts["tags"] += 1
        tag_map[row["id"]] = tag.id
    for row in payload.get("track_tags", []):
        track = matched.get(row.get("track_id"))
        if track is None:
            continue
        if row.get("tag_id") in skipped_tags:
            counts["skipped_facet_links"] += 1
            continue
        value_id = value_map.get(row.get("tag_id"))
        if value_id is not None:  # one link at a time: a later single value replaces an earlier one
            diff = facet_service.apply_tag_changes(session, track.id, [value_id], [], commit=False, reindex=False)
            counts["track_tags"] += len(diff.added)
            counts["replaced_facet_values"] += len(diff.replaced)
            continue
        tag = tag_map.get(row.get("tag_id"))
        if tag is not None and session.get(m.TrackTag, (track.id, tag)) is None:
            session.add(_model_values(m.TrackTag, row, track_id=track.id, tag_id=tag))
            counts["track_tags"] += 1
    for row in payload.get("artist_profiles", []):
        existing = session.exec(select(m.ArtistProfile).where(m.ArtistProfile.normalized_name == row.get("normalized_name"))).first()
        session.merge(_model_values(m.ArtistProfile, row, id=existing.id if existing else None))
        counts["artist_profiles"] += 1
    set_map = {}
    for row in payload.get("sets", []):
        if session.exec(select(m.DJSet).where(m.DJSet.title == row.get("title"))).first():
            conflicts.append({"set_id": row.get("id"), "field": "title", "resolution": "kept_local"})
            continue
        dj_set = _model_values(m.DJSet, row, id=None)
        session.add(dj_set)
        session.flush()
        set_map[row["id"]] = dj_set.id
        counts["sets"] += 1
        for link in payload.get("set_tracks", []):
            track = matched.get(link.get("track_id"))
            if link.get("set_id") == row["id"] and track is not None:
                session.add(_model_values(m.SetTrack, link, id=None, set_id=dj_set.id, track_id=track.id))
                counts["set_tracks"] += 1
    for row in payload.get("pair_notes", []):
        left, right = matched.get(row.get("from_track_id")), matched.get(row.get("to_track_id"))
        if left is None or right is None:
            continue
        query = select(m.TrackPairNote).where(m.TrackPairNote.from_track_id == left.id, m.TrackPairNote.to_track_id == right.id)
        for field in ("rating", "transition_type", "notes"):
            query = query.where(getattr(m.TrackPairNote, field) == row.get(field))
        if session.exec(query).first() is None:
            session.add(_model_values(m.TrackPairNote, row, id=None, from_track_id=left.id, to_track_id=right.id))
            counts["pair_notes"] += 1
    played = set()
    for row in payload.get("play_events", []):
        track = matched.get(row.get("track_id"))
        if track is None:
            continue
        event = _model_values(m.PlayEvent, row, id=None, track_id=track.id, set_id=set_map.get(row.get("set_id")))
        if session.exec(select(m.PlayEvent).where(m.PlayEvent.track_id == track.id, m.PlayEvent.played_at == event.played_at)).first() is None:
            session.add(event)
            counts["play_events"] += 1
        played.add(track.id)
    session.flush()
    for track in matched.values():
        if track.id in played:
            events = session.exec(select(m.PlayEvent).where(m.PlayEvent.track_id == track.id)).all()
            track.play_count = len(events)
            track.last_played_at = max((event.played_at for event in events), default=None)
            session.add(track)
        reindex_track(session, track.id, commit=False)
    session.commit()
    from .identity_sync import sync_session
    sync_session(session, [track.id for track in matched.values()])
    return {**counts, "matched_tracks": len(matched), "skipped_tracks": len(unmatched) + len(ambiguous),
            "unmatched_track_ids": unmatched, "ambiguous_track_ids": ambiguous, "conflicts": conflicts}
