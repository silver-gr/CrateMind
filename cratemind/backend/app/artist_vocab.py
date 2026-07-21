"""Small controlled vocabulary for artist intelligence."""
from __future__ import annotations

ALLOWED_SCENE_CLUSTERS = [
    "psybient / psychill",
    "psydub / tribal bass",
    "organic bass / glitch-hop",
    "progressive psytrance / futureprog",
    "night full-on / twilight",
    "darkpsy",
    "hi-tech",
    "psycore",
    "unknown / mixed",
]


def normalize_scene_cluster(value: str | None) -> str:
    if not value:
        return "unknown / mixed"
    lowered = value.strip().lower()
    for cluster in ALLOWED_SCENE_CLUSTERS:
        if lowered == cluster.lower():
            return cluster
    return "unknown / mixed"
