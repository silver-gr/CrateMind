"""Shared, pure identity eligibility for a coverage-oriented matching policy.

The legacy HIGH_CONFIDENCE/auto_high_confidence names remain storage contracts;
their eligibility now follows these more permissive, guarded thresholds.
"""
from __future__ import annotations

import re

from .metadata_reader import looks_like_label_name

AUTO_MIN_SCORE = 70
AUTO_MIN_TITLE = .85
AUTO_MIN_ARTIST = .45
AUTO_MAX_DURATION_SECONDS = 12
WEAK_ARTIST_MIN_SCORE = 65
WEAK_ARTIST_MIN_TITLE = .95
WEAK_ARTIST_MAX_DURATION_SECONDS = 6
COMPONENT_MIN_TITLE = .67
POLICY_VERSION = 'coverage_v2'


def weak_artist(value: str | None) -> bool:
    value = (value or '').strip()
    key = re.sub(r'[\W_]+', ' ', value.casefold()).strip()
    return (not value or bool(re.fullmatch(r'[\d\s.\-/]+', value))
            or key in {'unknown artist', 'unknown', 'various artists', 'va', 'v a', 'n a'}
            or looks_like_label_name(value))


def automatic_eligible(evidence: dict) -> bool:
    """Context points and uploader-only credits cannot confer eligibility."""
    delta = evidence.get('duration_delta_seconds')
    if evidence.get('conflicts') or evidence.get('near_tie_review') or delta is None:
        return False
    score = evidence.get('score_without_neighborhood', 0)
    title = evidence.get('title_similarity', 0)
    return (score >= AUTO_MIN_SCORE and title >= AUTO_MIN_TITLE
            and evidence.get('artist_similarity', 0) >= AUTO_MIN_ARTIST
            and delta <= AUTO_MAX_DURATION_SECONDS) or (
                evidence.get('weak_artist_performer_evidence', False)
                and score >= WEAK_ARTIST_MIN_SCORE and title >= WEAK_ARTIST_MIN_TITLE
                and delta <= WEAK_ARTIST_MAX_DURATION_SECONDS)
