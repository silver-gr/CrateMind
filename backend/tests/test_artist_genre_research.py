from __future__ import annotations

import copy
import json

import pytest

from app.artist_vocab import (
    ALLOWED_ARTIST_GENRES,
    ALLOWED_SCENE_CLUSTERS,
    genre_scene_cluster,
    normalize_artist_genre,
)
from app.services import artist_genre_research as research
from app.services.llm_client import LLMClientError

URL = "https://label.example/artist"
ARTIST = {"id": 7, "canonical_name": "Artist", "normalized_name": "artist"}


def finding(**overrides):
    return {
        "artist_id": 7, "status": "classified", "identity_match": True,
        "primary_subgenre": "Forest", "secondary_subgenres": [], "outside_genre": None,
        "confidence_label": "medium", "reason": "Το label αναφέρει forest για τη συγκεκριμένη κυκλοφορία.",
        "sources": [{"url": URL, "evidence": "The artist's credited EP is described as forest psytrance."}],
        **overrides,
    }


def mock_finding(monkeypatch, result, sources=None):
    monkeypatch.setattr(research.llm_client, "research_json", lambda *a: {
        "result": result, "sources": [URL] if sources is None else sources,
        "model": "gpt-6-luna", "reasoning_effort": "max", "search_calls": 1,
    })


@pytest.mark.parametrize("genre", ALLOWED_ARTIST_GENRES)
def test_all_twelve_genres_are_canonical_and_project_to_existing_scenes(monkeypatch, genre):
    assert len(ALLOWED_ARTIST_GENRES) == 12
    mock_finding(monkeypatch, finding(primary_subgenre=genre))
    candidate = research.research_artist(ARTIST)
    assert candidate["primary_subgenre"] == genre
    assert candidate["scene_cluster"] in ALLOWED_SCENE_CLUSTERS
    assert candidate["scene_cluster"] == genre_scene_cluster(genre)
    assert candidate["needs_review"] is True
    assert set(candidate) == {*research.GENRE_PROFILE_FIELDS, "research"}
    assert research.research_info(candidate["raw_llm_json"]) == candidate["research"]
    assert candidate["research"]["workflow"] == research.WORKFLOW_VERSION
    assert candidate["research"]["model"] == "gpt-6-luna"
    assert candidate["research"]["reasoning_effort"] == "max"


@pytest.mark.parametrize("alias,canonical", [
    ("prog_psy", "Prog-psy"), ("Progressive Psytrance", "Prog-psy"),
    ("fullon", "Full-On"), ("morning fullon", "Morning Full-On"),
    ("night_full_on", "Night Full-On"), ("dark psy", "Darkpsy"),
    ("forest psytrance", "Forest"), ("hitech", "Hi-Tech"),
    ("Psychedelic Dub", "Psydub"), ("goa", "Goa Trance"),
])
def test_spelling_aliases_are_canonicalized(monkeypatch, alias, canonical):
    mock_finding(monkeypatch, finding(primary_subgenre=alias))
    assert research.research_artist(ARTIST)["primary_subgenre"] == canonical


@pytest.mark.parametrize("name", ["Psybient", "Psychill", "Glitch-hop", "Futureprog", "Psytrance", "ambient", None, []])
def test_adjacent_styles_are_not_forced_into_controlled_labels(name):
    assert normalize_artist_genre(name) is None


def test_secondary_genres_are_distinct_and_do_not_repeat_primary(monkeypatch):
    mock_finding(monkeypatch, finding(secondary_subgenres=["forest psy", "dark psy", "Darkpsy"]))
    candidate = research.research_artist(ARTIST)
    assert json.loads(candidate["secondary_subgenres_json"]) == ["Darkpsy"]


def test_outside_list_preserves_real_genre_without_forcing_allowed_label(monkeypatch):
    mock_finding(monkeypatch, finding(
        status="outside_list", primary_subgenre=None, outside_genre="Glitch-hop",
        reason="Οι ταυτοποιημένες κυκλοφορίες είναι glitch-hop, εκτός της λίστας.",
    ))
    candidate = research.research_artist(ARTIST)
    assert candidate["primary_subgenre"] is None
    assert candidate["scene_cluster"] == "unknown / mixed"
    assert candidate["research"]["status"] == "outside_list"
    assert candidate["research"]["outside_genre"] == "Glitch-hop"
    assert candidate["needs_review"] is True


def test_unresolved_identity_is_valid_review_finding_not_failed_request(monkeypatch):
    mock_finding(monkeypatch, finding(
        status="unresolved", identity_match=False, primary_subgenre=None,
        confidence_label="unknown", sources=[], reason="Δεν ταυτοποιήθηκε αξιόπιστα ο καλλιτέχνης.",
    ), sources=[])
    candidate = research.research_artist(ARTIST)
    assert candidate["primary_subgenre"] is None
    assert candidate["research"]["status"] == "unresolved"
    assert candidate["research"]["sources"] == []


def test_source_fragments_are_normalized_and_duplicates_collapsed(monkeypatch):
    mock_finding(monkeypatch, finding(sources=[
        {"url": URL + "#genre", "evidence": "Genre evidence"},
        {"url": URL, "evidence": "Repeated source"},
    ]))
    assert research.research_artist(ARTIST)["research"]["sources"] == [
        {"url": URL, "evidence": "Genre evidence"},
    ]


@pytest.mark.parametrize("overrides", [
    {"artist_id": 8}, {"artist_id": True}, {"identity_match": "true"},
    {"identity_match": False}, {"primary_subgenre": "Psychill"},
    {"primary_subgenre": None}, {"confidence_label": "unknown"},
    {"confidence_label": "certain"}, {"reason": " "}, {"reason": None},
    {"sources": []}, {"sources": [{"url": URL, "evidence": ""}]},
    {"sources": [{"url": "https://invented.example/page", "evidence": "Looks plausible"}]},
    {"sources": [{"url": "javascript:alert(1)", "evidence": "Unsafe"}]},
    {"secondary_subgenres": ["Futureprog"]}, {"secondary_subgenres": "Forest"},
    {"secondary_subgenres": ["Darkpsy", "Forest", "Twilight", "Hi-Tech"]},
    {"outside_genre": "Psybient"}, {"status": "unknown"}, {"extra_biography": "No"},
    {"status": "outside_list", "primary_subgenre": None, "outside_genre": "Psydub"},
    {"status": "outside_list", "primary_subgenre": None, "outside_genre": "ambient", "identity_match": False},
    {"status": "unresolved", "primary_subgenre": None, "confidence_label": "high"},
    {"status": "unresolved", "primary_subgenre": None, "confidence_label": "unknown", "secondary_subgenres": ["Forest"]},
])
def test_invalid_or_unsupported_findings_fail_without_acceptance(monkeypatch, overrides):
    mock_finding(monkeypatch, finding(**overrides))
    with pytest.raises(LLMClientError):
        research.research_artist(ARTIST)


def test_schema_requires_every_field_and_no_additional_fields(monkeypatch):
    schema = research.RESULT_SCHEMA
    assert schema["additionalProperties"] is False
    assert set(schema["required"]) == set(schema["properties"])
    assert set(schema["properties"]["primary_subgenre"]["enum"]) == {*ALLOWED_ARTIST_GENRES, None}
    assert schema["properties"]["sources"]["items"]["additionalProperties"] is False
    result = finding()
    result.pop("identity_match")
    mock_finding(monkeypatch, result)
    with pytest.raises(LLMClientError):
        research.research_artist(ARTIST)


def test_prompt_uses_only_local_identity_examples_and_does_not_seed_legacy_biography(monkeypatch):
    seen = {}

    def capture(system, user, schema):
        seen.update(system=system, user=json.loads(user), schema=schema)
        return {"result": finding(), "sources": [URL], "model": "gpt-6-luna",
                "reasoning_effort": "max", "search_calls": 1}

    monkeypatch.setattr(research.llm_client, "research_json", capture)
    artist = {**ARTIST, "aliases_json": '["Artist Alias"]', "notes": "UNVERIFIED OLD BIOGRAPHY",
              "typical_bpm_min": 500, "library_examples": [{
                  "title": "Specific Release Track", "artist_credit": "Artist Alias",
                  "genre": "legacy-tag", "album": "Known EP", "label": "Label",
                  "absolute_path": "/private/music/file.mp3",
              }]}
    untouched = copy.deepcopy(artist)
    candidate = research.research_artist(artist)
    assert artist == untouched
    assert seen["user"]["library_examples"][0] == {
        "title": "Specific Release Track", "artist_credit": "Artist Alias", "genre": "legacy-tag",
        "album": "Known EP", "label": "Label",
    }
    assert seen["user"]["aliases"] == ["Artist Alias"]
    assert "UNVERIFIED OLD BIOGRAPHY" not in json.dumps(seen)
    assert "/private/music" not in json.dumps(seen)
    assert all(genre in seen["system"] for genre in ALLOWED_ARTIST_GENRES)
    assert "in Greek" in seen["system"]
    assert "no biography" in seen["system"]
    assert "canonical_name" not in candidate and "typical_bpm_min" not in candidate
    raw = json.loads(candidate["raw_llm_json"])
    assert raw["finding"]["identity_match"] is True
    assert raw["workflow"] == research.WORKFLOW_VERSION
    assert raw["observed_sources"] == [URL] and raw["search_calls"] == 1


@pytest.mark.parametrize("raw", [
    None, "", "not json", "[]", '{}', '{"primary_subgenre":"Forest"}',
    '{"research":{"workflow":"old","status":"classified","sources":[]}}',
    '{"research":{"workflow":"artist-genre-research-v1","status":[],"sources":[]}}',
])
def test_research_info_ignores_legacy_invalid_and_other_version_data(raw):
    assert research.research_info(raw) is None


@pytest.mark.parametrize("response", [None, {}, {"result": []}, {
    "result": finding(), "sources": None,
}])
def test_malformed_transport_contract_is_a_controlled_error(monkeypatch, response):
    monkeypatch.setattr(research.llm_client, "research_json", lambda *a: response)
    with pytest.raises(LLMClientError):
        research.research_artist(ARTIST)
