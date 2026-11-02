"""Small controlled vocabulary for artist intelligence."""
from __future__ import annotations

import re

ALLOWED_ARTIST_GENRES = (
    "Goa Trance", "Prog-psy", "Full-On", "Morning Full-On", "Night Full-On", "Twilight",
    "Darkpsy", "Forest", "Hi-Tech", "Psycore", "Zenonesque", "Psydub",
)

_GENRE_ALIASES = {
    "Goa Trance": ("goa",),
    "Prog-psy": ("prog psy", "progpsy", "progressive psytrance", "progressive psy"),
    "Full-On": ("fullon", "full on psytrance"),
    "Morning Full-On": ("morning fullon", "morning full on psytrance"),
    "Night Full-On": ("night fullon", "night full on psytrance"),
    "Twilight": ("twilight psy", "twilight psytrance"),
    "Darkpsy": ("dark psy", "dark psytrance"),
    "Forest": ("forest psy", "forest psytrance"),
    "Hi-Tech": ("hitech", "hi tech psytrance"),
    "Psycore": ("psy core",),
    "Zenonesque": (),
    "Psydub": ("psy dub", "psychedelic dub"),
}


def _genre_key(value: str) -> str:
    return re.sub(r"[\s_-]+", " ", value.strip().casefold())


def normalize_artist_genre(value: str | None) -> str | None:
    """Canonicalize spellings, without collapsing distinct or out-of-list styles."""
    if not isinstance(value, str) or not value.strip():
        return None
    key = _genre_key(value)
    for genre, aliases in _GENRE_ALIASES.items():
        if key in {_genre_key(name) for name in (genre, *aliases)}:
            return genre
    return None


def genre_scene_cluster(genre: str | None) -> str:
    """Project precise genres into the existing, broader scene vocabulary."""
    return {
        "Goa Trance": "psytrance (regular)",
        "Prog-psy": "progressive psytrance",
        "Full-On": "full-on",
        "Morning Full-On": "full-on",
        "Night Full-On": "night full-on",
        "Twilight": "twilight",
        "Darkpsy": "darkpsy",
        "Forest": "forest",
        "Hi-Tech": "hi-tech",
        "Psycore": "psycore",
        "Zenonesque": "progressive psytrance",
        "Psydub": "psydub / tribal bass",
    }.get(genre, "unknown / mixed")


ALLOWED_SCENE_CLUSTERS = [
    "psybient / psychill",
    "psydub / tribal bass",
    "organic bass / glitch-hop",
    "progressive psytrance",
    "futureprog",
    "night full-on",
    "full-on",
    "twilight",
    "psytrance (regular)",
    "forest",
    "experimental",
    "melodic hi-tech",
    "forest hi-tech",
    "dark hi-tech",
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
