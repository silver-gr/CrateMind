"""Read-only field projection shared by catalog and recording responses.

Inferred display credits do not accept provider identities or rewrite source tags.
All lookup work is scoped and batched, including when a response has many tracks.
"""
from __future__ import annotations

import json
import re
from collections import defaultdict

from . import canonical_metadata
from .metadata_reader import display_title_hints
from .identity_policy import weak_artist
from .tempo import metadata_bpm_hint, positive_bpm

MANUAL_STATES = {"human", "kept_local", "rejected"}
INFERRED_CREDIT_MIN_SCORE = 65
INFERRED_CREDIT_MIN_TITLE = .95
INFERRED_CREDIT_MAX_DURATION_SECONDS = 6
INFERRED_CREDIT_MIN_MARGIN = 5


def _load(entity):
    entity = dict(entity)
    entity["normalized"] = json.loads(entity["normalized_json"])
    entity["metadata"] = json.loads(entity["metadata_json"])
    return entity


def _credit(entity, allow_uploader):
    n, raw = entity["normalized"], entity["metadata"]
    artist = n.get("artist") or raw.get("performer")
    basis = "provider_performer"
    if weak_artist(artist):
        proposal = canonical_metadata.proposal(entity)
        artist = proposal["artist"]
        basis = "provider_title"
    if weak_artist(artist) and allow_uploader and entity["service"] == "soundcloud":
        artist = n.get("uploader") or raw.get("uploader") or entity.get("artist")
        basis = "inferred_uploader"
    if raw.get("asset_lifecycle", {}).get("state") == "retired":
        return None, None
    return (artist, basis) if not weak_artist(artist) else (None, None)


def recordings(db, recording_ids):
    ids = sorted(set(recording_ids))
    if not ids:
        return {}
    scope = " IN (SELECT value FROM json_each(?))"
    args = (json.dumps(ids),)
    canon = {r["recording_id"]: dict(r) for r in db.execute(
        "SELECT recording_id,title,artist,state FROM canonical_recordings WHERE recording_id" + scope, args)}
    groups = defaultdict(list)
    from .identity_library import current_local_predicate
    for row in db.execute(
        "SELECT * FROM entities e WHERE recording_id" + scope +
        " AND (e.service!='local' OR (" + current_local_predicate() + ")) ORDER BY e.id", args
    ):
        e = _load(row)
        groups[e["recording_id"]].append(e)
    candidates = defaultdict(list)
    # Candidate direction is not an identity contract. Join the current local
    # endpoint on either side and resolve the opposite provider in the same query.
    tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if "candidates" in tables:
        blocked = ""
        if "identity_acceptances" in tables:
            blocked += (" AND NOT EXISTS(SELECT 1 FROM identity_acceptances a WHERE "
                        "((a.left_id=c.left_id AND a.right_id=c.right_id) OR "
                        "(a.left_id=c.right_id AND a.right_id=c.left_id)) AND a.revoked_at IS NOT NULL)")
        if "canonical_blocks" in tables:
            blocked += (" AND NOT EXISTS(SELECT 1 FROM canonical_blocks b WHERE "
                        "(b.left_id=c.left_id AND b.right_id=c.right_id) OR "
                        "(b.left_id=c.right_id AND b.right_id=c.left_id))")
        query = ("SELECT c.score,c.evidence_json,l.recording_id AS target_recording,p.* "
                 "FROM candidates c JOIN entities l ON (l.id=c.left_id OR l.id=c.right_id) "
                 "JOIN entities p ON p.id=CASE WHEN l.id=c.left_id THEN c.right_id ELSE c.left_id END "
                 "WHERE " + current_local_predicate("l") + " AND l.recording_id" + scope +
                 " AND p.service IN ('spotify','soundcloud') AND c.score>=?" + blocked +
                 " ORDER BY c.score DESC,p.id")
        for row in db.execute(query, (*args, INFERRED_CREDIT_MIN_SCORE - INFERRED_CREDIT_MIN_MARGIN)):
            e = _load(row)
            e["match_evidence"] = json.loads(e["evidence_json"])
            candidates[e["target_recording"]].append(e)
    result = {}
    for rid, c in canon.items():
        members = groups[rid]
        local = next((e for e in members if e["service"] == "local"), None)
        raw_local = local["metadata"] if local else {}
        raw_artist = local["artist"] if local else c["artist"]
        raw_title = local["title"] if local else c["title"]
        hint, hint_basis = metadata_bpm_hint(raw_artist, raw_title, raw_local.get("bpm_analyzed"))
        value = {"artist": c["artist"], "title": c["title"], "state": c["state"],
                 "display_bpm_hint": hint, "metadata_provenance": {}}
        if hint is not None:
            value["metadata_provenance"]["bpm"] = {"basis": hint_basis, "source_id": local["id"] if local else rid}
        if c["state"] in MANUAL_STATES:
            result[rid] = value
            continue
        value["artist"] = re.sub(r"^\s*&\s*(?=\S)", "", c["artist"] or "")
        if value["artist"] != (c["artist"] or ""):
            value["metadata_provenance"]["artist"] = {"basis": "leading_credit_separator", "source_id": rid}
        value["title"], title_hint = display_title_hints(c["title"])
        if value["title"] != c["title"]:
            value["metadata_provenance"]["title"] = {"basis": "metadata_wrappers", "source_id": rid}
        if local and c["state"] == "review":
            # A reviewed fallback may still contain `Artist - Title`. Reuse
            # the existing proposal only when its performer repairs a weak
            # credit or corroborates the meaningful current artist. A dash in
            # an unrelated title (e.g. Dreams - Part II) is not enough.
            from .identity_matching import text_key
            proposal = canonical_metadata.proposal(local)
            parsed_artist = re.sub(r"^\s*&\s*(?=\S)", "", proposal["artist"] or "")
            if ("artist_inside_title" in proposal["patterns"] and not weak_artist(parsed_artist)
                    and (weak_artist(value["artist"]) or text_key(parsed_artist) == text_key(value["artist"]))):
                value["title"] = proposal["title"]
                value["metadata_provenance"]["title"] = {"basis": "artist_inside_title", "source_id": local["id"]}
                if parsed_artist != value["artist"]:
                    value["artist"] = parsed_artist
                    value["metadata_provenance"]["artist"] = {
                        "basis": "artist_inside_title", "source_id": local["id"],
                        "inferred": True, "accepted_identity": False}
        if hint is None and title_hint is not None:
            value["display_bpm_hint"] = title_hint
            value["metadata_provenance"]["bpm"] = {"basis": "title_annotation", "source_id": rid}
        if weak_artist(value["artist"]):
            value["artist"] = ""
            # A numeric artist corroborated as tempo carries no performer credit.
            # Do not replace it with the account that happened to upload the file.
            allow_uploader = hint_basis != "numeric_artist"
            for e in members:
                if e["service"] == "local":
                    continue
                artist, basis = _credit(e, False)
                if artist:
                    value["artist"] = artist
                    value["metadata_provenance"]["artist"] = {"basis": basis, "source_id": e["id"], "inferred": True}
                    break
            if not value["artist"] and local:
                eligible = []
                for e in candidates[rid]:
                    evidence = e["match_evidence"]
                    conflicts = set(evidence.get("conflicts") or []) - {"artist_conflict"}
                    delta = evidence.get("duration_delta_seconds")
                    if (conflicts or evidence.get("near_tie_review") or
                        evidence.get("title_similarity", 0) < INFERRED_CREDIT_MIN_TITLE or
                        delta is None or delta > INFERRED_CREDIT_MAX_DURATION_SECONDS):
                        continue
                    artist, basis = _credit(e, allow_uploader)
                    if artist:
                        eligible.append((e, artist, basis))
                if eligible:
                    best, artist, basis = eligible[0]
                    rivals = [e["score"] for e, _, _ in eligible[1:]
                              if e["recording_id"] != best["recording_id"]]
                    if (best["score"] >= INFERRED_CREDIT_MIN_SCORE and
                        (not rivals or best["score"] - max(rivals) >= INFERRED_CREDIT_MIN_MARGIN)):
                        value["artist"] = artist
                        value["metadata_provenance"]["artist"] = {
                            "basis": basis, "source_id": best["id"], "inferred": True,
                            "match_score": best["score"], "accepted_identity": False}
        result[rid] = value
    return result


def apply_recordings(db, rows, key="recording_id"):
    values = recordings(db, [row[key] for row in rows if row.get(key)])
    for row in rows:
        value = values.get(row.get(key))
        if value:
            row.setdefault("original_artist", row.get("artist"))
            row.setdefault("original_title", row.get("title"))
            row.update({k: v for k, v in value.items() if k != "state"})
    return rows


def apply_track_hint(row):
    """Use current catalog observations for BPM; identity snapshots may be older."""
    from .tempo import effective_bpm_values
    hint, basis = metadata_bpm_hint(row.get("original_artist", row.get("artist")),
                                    row.get("original_title", row.get("title")), row.get("bpm_analyzed"))
    hint = hint or positive_bpm(row.get("display_bpm_hint"))
    source = row.get("bpm_consensus_sources")
    if positive_bpm(row.get("bpm")) is None and hint is not None:
        row["display_bpm_hint"] = hint
        row.setdefault("metadata_provenance", {}).setdefault("bpm", {"basis": basis or "title_annotation"})
    row["display_bpm"] = effective_bpm_values(
        row.get("bpm") if positive_bpm(row.get("bpm")) is not None else hint,
        row.get("bpm_analyzed"), row.get("bpm_consensus"), source)
    return row


def search_local_ids(db, terms, field="all", any_term=False):
    """Find newly inferred text with a narrow provider seed, then the same rules.

    SQL text matches are leads only: the shared recording resolver still checks
    score, margin, lifecycle, rejections and manual metadata before a local ID
    can match. No full-library projection or per-recording database reads.
    """
    if not terms or field == "album":
        return []
    from .identity_library import current_local_predicate
    from .identity_matching import text_key
    haystack = " || ' ' || ".join([
        "coalesce(p.artist,'')", "coalesce(p.title,'')",
        "coalesce(json_extract(p.normalized_json,'$.artist'),'')",
        "coalesce(json_extract(p.normalized_json,'$.uploader'),'')",
        "coalesce(json_extract(p.metadata_json,'$.uploader'),'')",
    ])
    checks = " OR ".join(f"instr(cratemind_text({haystack}), ?) > 0" for _ in terms)
    query = (
        "SELECT DISTINCT l.local_track_id,l.recording_id FROM candidates c "
        "JOIN entities l ON (l.id=c.left_id OR l.id=c.right_id) "
        "JOIN entities p ON p.id=CASE WHEN l.id=c.left_id THEN c.right_id ELSE c.left_id END "
        "WHERE " + current_local_predicate("l") +
        " AND p.service IN ('spotify','soundcloud') AND c.score>=? AND (" + checks + ")")
    args = [INFERRED_CREDIT_MIN_SCORE, *[text_key(term) for term in terms]]
    if field == "artist":
        # The performer may live solely in a local `Artist - Title` wrapper.
        # Seed by that title; projection validation rejects arbitrary dash titles.
        local_checks = " OR ".join("instr(cratemind_text(coalesce(l.title,'')), ?) > 0" for _ in terms)
        query += (" UNION SELECT l.local_track_id,l.recording_id FROM entities l "
                  "JOIN canonical_recordings c ON c.recording_id=l.recording_id WHERE " +
                  current_local_predicate("l") + " AND c.state='review' AND (" + local_checks + ")")
        args.extend(text_key(term) for term in terms)
    rows = db.execute(query,args).fetchall()
    if not rows:
        return []
    projected = recordings(db, {row["recording_id"] for row in rows})
    result = []
    for row in rows:
        value = projected.get(row["recording_id"])
        if not value:
            continue
        text = (value["artist"] or "") if field == "artist" else " ".join([value["artist"] or "", value["title"] or ""])
        matches = [text_key(term) in text_key(text) for term in terms]
        if (any(matches) if any_term else all(matches)):
            result.append(row["local_track_id"])
    return result
