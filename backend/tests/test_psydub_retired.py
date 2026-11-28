"""Psydub left the genres artist research may pick (owner, 2026-11-28). A stored Psydub (a confirmed genre, a ready
finding, a secondary list, a track substyle) must still load, show, search, score and stay confirmable."""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from app.artist_vocab import (
    ALLOWED_ARTIST_GENRES, KNOWN_ARTIST_GENRES, RETIRED_ARTIST_GENRES, artist_substyle, genre_scene_cluster,
    normalize_artist_genre, pickable_artist_genre,
)
from app.models import ArtistProfile, ArtistReview, Track
from app.services import recommender
from app.services.artist_genre_research import WORKFLOW_VERSION

FRONTEND = Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "artistGenreResults.ts"


def test_the_frontend_lists_match_the_backend():
    if not FRONTEND.exists():
        pytest.skip("UNKNOWN: frontend/src/lib/artistGenreResults.ts is not in this checkout")
    source = FRONTEND.read_text(encoding="utf-8")

    def listed(name: str) -> tuple[str, ...]:
        block = re.search(rf"export const {name} = \[(.*?)\] as const;", source, re.S).group(1)
        return tuple(re.findall(r'"([^"]+)"', block))

    assert listed("ARTIST_GENRES") == ALLOWED_ARTIST_GENRES
    assert listed("RETIRED_ARTIST_GENRES") == RETIRED_ARTIST_GENRES


def test_psydub_is_known_but_not_pickable():
    assert "Psydub" not in ALLOWED_ARTIST_GENRES and "Psydub" in KNOWN_ARTIST_GENRES
    for name in ("Psydub", "psy dub", "Psychedelic Dub"):
        assert normalize_artist_genre(name) == "Psydub"
        assert pickable_artist_genre(name) is None
    assert pickable_artist_genre("prog psy") == "Prog-psy"
    assert artist_substyle("Psydub") == "psydub"
    assert genre_scene_cluster("Psydub") == "psydub / tribal bass"


def test_the_style_ladder_still_scores_a_stored_psydub():
    assert recommender.normalize_style("Psydub") == "Psydub"
    assert recommender.normalize_style("psydub") == "Psydub"
    assert recommender.STYLE_RUNG["Psydub"] == 0
    assert recommender.style_fit("Psydub", "Prog-psy")[0] == recommender.style_fit("Chill", "Prog-psy")[0]


def _research():
    return {"workflow": WORKFLOW_VERSION, "status": "classified",
            "sources": [{"url": "https://example.org/artist", "evidence": "Label evidence"}],
            "reason": "Τεκμήριο είδους", "outside_genre": None, "model": "gpt-6-luna", "reasoning_effort": "max"}


def test_a_stored_psydub_finding_is_served_and_stays_confirmable(client, db):
    research = _research()
    finding = {"primary_subgenre": "Psydub", "scene_cluster": "psydub / tribal bass",
               "secondary_subgenres_json": '["Prog-psy"]', "confidence_label": "high", "needs_review": True,
               "notes": "Τεκμήριο είδους", "raw_llm_json": json.dumps({"research": research}), "research": research}
    p = ArtistProfile(normalized_name="dubber", canonical_name="Dubber", track_count=3, primary_subgenre="Forest")
    db.add(p); db.commit()
    db.add(ArtistReview(artist_id=p.id, baseline_json="{}", candidate_json=json.dumps(finding), state="ready")); db.commit()
    shown = {a["normalized_name"]: a for a in client.get("/api/artists").json()}["dubber"]
    assert shown["review"]["candidate"]["primary_subgenre"] == "Psydub"
    response = client.post(f"/api/artists/{p.id}/review", json={"choice": "candidate"})
    assert response.status_code == 200
    value = response.json()
    assert value["primary_subgenre"] == "Psydub"
    assert json.loads(value["secondary_subgenres_json"]) == ["Prog-psy"]
    assert value["scene_cluster"] == "psydub / tribal bass"


def test_a_confirmed_psydub_artist_and_secondary_still_filter(client, db):
    keep = ArtistProfile(normalized_name="electrowavez", canonical_name="ElectrowaveZ", track_count=7,
                         primary_subgenre="Prog-psy", secondary_subgenres_json='["Goa Trance", "Psydub"]')
    dub = ArtistProfile(normalized_name="dubber", canonical_name="Dubber", track_count=1, primary_subgenre="Psydub",
                        scene_cluster="psydub / tribal bass")
    db.add_all([keep, dub]); db.commit()
    db.add_all([ArtistReview(artist_id=keep.id, baseline_json="{}", state="confirmed"),
                ArtistReview(artist_id=dub.id, baseline_json="{}", state="confirmed")])
    tracks = [Track(absolute_path="/lib/a.wav", artist="ElectrowaveZ", artist_normalized="electrowavez", missing=False),
              Track(absolute_path="/lib/b.wav", artist="Dubber", artist_normalized="dubber", missing=False)]
    db.add_all(tracks); db.commit()
    ids = {t.artist_normalized: t.id for t in tracks}

    def found(q):
        return {r["id"] for r in client.get("/api/tracks/search", params={"q": q}).json()}

    assert found("substyle:psydub") == {ids["dubber"]}
    assert found("artist_subgenre:psydub") == {ids["dubber"]}
    assert found('artist_scene:"psydub / tribal bass"') == {ids["dubber"]}
    rows = {r["id"]: r for r in client.get("/api/tracks").json()}
    assert rows[ids["dubber"]]["artist_substyle"] == "psydub"
    assert rows[ids["electrowavez"]]["artist_substyle"] == "prog-psy"
    listed = {a["normalized_name"]: a for a in client.get("/api/artists").json()}
    assert json.loads(listed["electrowavez"]["secondary_subgenres_json"]) == ["Goa Trance", "Psydub"]
