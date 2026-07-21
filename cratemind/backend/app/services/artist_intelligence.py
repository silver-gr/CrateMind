"""Artist enrichment orchestration."""
from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

from sqlmodel import Session, select

from ..artist_vocab import normalize_scene_cluster
from ..config import get_settings
from ..models import ArtistProfile, Job
from . import llm_client


def _system_prompt() -> str:
    return (
        "You enrich artists for a DJ library. "
        "Return JSON only. "
        "For each artist, provide: canonical_name, scene_cluster, primary_subgenre, "
        "secondary_subgenres, typical_bpm_min, typical_bpm_max, energy_min, energy_max, "
        "set_role_hints, confidence_label, needs_review, notes. "
        "Be specific. Avoid broad genre labels when more specific ones are possible."
    )


def _user_prompt(artists: list[dict[str, Any]]) -> str:
    return json.dumps(
        {
            "task": "Enrich these artists with structured DJ-useful intelligence.",
            "response_shape": "Return an object with key 'artists' containing one object per artist.",
            "artists": artists,
        },
        ensure_ascii=False,
    )


def _normalize_profile_blob(blob: dict[str, Any], fallback_name: str) -> dict[str, Any]:
    scene_cluster = normalize_scene_cluster(blob.get("scene_cluster"))
    primary_subgenre = blob.get("primary_subgenre")
    secondary = blob.get("secondary_subgenres")
    if not isinstance(secondary, list):
        secondary = []
    set_roles = blob.get("set_role_hints")
    if not isinstance(set_roles, list):
        set_roles = []
    confidence = str(blob.get("confidence_label") or "unknown")
    needs_review = bool(blob.get("needs_review", scene_cluster == "unknown / mixed" or not primary_subgenre))
    return {
        "canonical_name": str(blob.get("canonical_name") or fallback_name),
        "scene_cluster": scene_cluster,
        "primary_subgenre": str(primary_subgenre) if primary_subgenre else None,
        "secondary_subgenres_json": json.dumps(secondary, ensure_ascii=False),
        "typical_bpm_min": blob.get("typical_bpm_min"),
        "typical_bpm_max": blob.get("typical_bpm_max"),
        "energy_min": blob.get("energy_min"),
        "energy_max": blob.get("energy_max"),
        "set_role_hints_json": json.dumps(set_roles, ensure_ascii=False),
        "confidence_label": confidence,
        "needs_review": needs_review,
        "notes": str(blob.get("notes") or "") or None,
        "raw_llm_json": json.dumps(blob, ensure_ascii=False),
        "last_enriched_at": datetime.now(UTC),
    }


def enrich_artist_profiles(
    session: Session,
    *,
    limit: int | None = None,
    profile_ids: list[int] | None = None,
    job: Job | None = None,
) -> dict[str, int]:
    stmt = select(ArtistProfile).where(ArtistProfile.track_count > 0)
    if profile_ids:
        stmt = stmt.where(ArtistProfile.id.in_(profile_ids))
    rows = session.exec(stmt.order_by(ArtistProfile.track_count.desc(), ArtistProfile.id)).all()
    if limit is not None:
        rows = rows[:limit]
    if job is not None:
        job.total = len(rows)
        job.processed = 0
        session.add(job)
        session.commit()
    if not rows:
        return {"processed": 0, "updated": 0, "failed": 0}

    updated = 0
    failed = 0
    batch_size = max(1, get_settings().artist_intelligence_batch_size)
    processed = 0

    for start in range(0, len(rows), batch_size):
        batch = rows[start:start + batch_size]
        payload_rows = [
            {
                "id": profile.id,
                "normalized_name": profile.normalized_name,
                "canonical_name": profile.canonical_name,
                "track_count": profile.track_count,
            }
            for profile in batch
        ]
        raw = llm_client.chat_json(_system_prompt(), _user_prompt(payload_rows))
        items = raw if isinstance(raw, list) else raw.get("artists") if isinstance(raw, dict) else None
        if not isinstance(items, list):
            raise llm_client.LLMClientError("Response missing artists array.")

        by_key = {}
        for item in items:
            if not isinstance(item, dict):
                continue
            key = item.get("normalized_name") or item.get("canonical_name")
            if key:
                by_key[str(key).strip().lower()] = item

        for profile in batch:
            processed += 1
            match = by_key.get(profile.normalized_name) or by_key.get(profile.canonical_name.strip().lower())
            if match is None:
                profile.needs_review = True
                profile.confidence_label = "unknown"
                profile.notes = "LLM response missing artist entry."
                failed += 1
            else:
                for field, value in _normalize_profile_blob(match, profile.canonical_name).items():
                    setattr(profile, field, value)
                profile.updated_at = datetime.now(UTC)
                updated += 1
            session.add(profile)
            session.commit()
            if job is not None:
                job.processed = processed
                session.add(job)
                session.commit()
    return {"processed": len(rows), "updated": updated, "failed": failed}
