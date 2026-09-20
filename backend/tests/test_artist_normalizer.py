from __future__ import annotations

from app.services.artist_normalizer import (
    normalize_artist_name,
    normalize_primary_artist_name,
    primary_artist_name,
)


def test_normalize_artist_name_collapses_case_and_whitespace():
    assert normalize_artist_name("  AtYyA  ") == "atyya"
    assert normalize_artist_name("ATYYA") == "atyya"
    assert normalize_artist_name("Dark_Whisper") == "dark whisper"
    assert normalize_artist_name("Drip_Drop") == "drip drop"


def test_primary_artist_name_takes_first_collab_chunk():
    assert primary_artist_name("Desert Dwellers & Kaya Project") == "Desert Dwellers"
    assert normalize_primary_artist_name("Technical Hitch feat. XENROX") == "technical hitch"
    assert primary_artist_name("Dark_Whisper") == "Dark Whisper"


def test_normalize_artist_name_returns_none_for_empty_values():
    assert normalize_artist_name("") is None
    assert normalize_artist_name("   ") is None
    assert normalize_primary_artist_name(None) is None


def test_non_latin_artist_names_are_preserved():
    assert normalize_artist_name("Μίκης Θεοδωράκης") == "μίκης θεοδωράκης"
    assert normalize_artist_name("宇宙") == "宇宙"
    assert normalize_artist_name("Beyoncé ♫") == "beyoncé"
