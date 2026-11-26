"""Duplicate detection — builds review groups, never deletes or moves files.

Three passes:
  1. Exact: identical quick_hash → same bytes (highest confidence).
  2. Metadata suspect: normalised artist+title match with similar duration.
     Different remix / radio edit are flagged for HUMAN review, not resolved.
  3. Audio: the same recording by fingerprint (services/fingerprint_match.py) with a matching title, which catches
     a preview of a full track, «&»/«vs»/«feat» credit spellings and «Unknown Artist» copies. A remix, edit or dub
     of a track, or a long mix opening with it, is not flagged.
"""
from __future__ import annotations

import re
import unicodedata
from collections import defaultdict
from difflib import SequenceMatcher

from sqlmodel import Session, delete, select

from ..models import DuplicateGroup, DuplicateGroupTrack, Fingerprint, Track
from . import fingerprint_match

_DUR_TOLERANCE = 5.0  # seconds — within this, "same recording" suspect
AUDIO_REASON = "audio: same recording by fingerprint — review"
_TITLE_NOISE = {"original", "mix", "extended", "preview", "master", "mastered", "no", "free", "download", "hq", "24bit",
                "16bit", "remastered", "remaster", "bpm", "feat", "ft", "the", "a", "va", "v", "unreleased", "out", "now",
                "full", "version", "release", "released", "records", "rec", "promo", "demo", "wav", "mp3", "final", "clip",
                "radio"}
_VERSION_WORDS = {"remix", "rmx", "vip", "dub", "rework", "bootleg", "mashup", "reprise", "instrumental", "acoustic", "live",
                  "edit", "flip", "refix"}


def _words(text: str | None) -> list[str]:
    ascii_text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode().casefold()
    return re.sub(r"[^a-z0-9]+", " ", ascii_text).split()


def _title_cores(title: str | None) -> list[str]:
    """A title without bracketed parts, bpm numbers and filler words, split at " - " (titles often carry the artist)."""
    plain = re.sub(r"[\(\[\{].*?[\)\]\}]", " ", title or "")
    parts = [p for p in re.split(r"\s+[-–|]\s+", plain) if p.strip()] or [plain]
    return [" ".join(w for w in _words(p) if w not in _TITLE_NOISE and not w.isdigit()) for p in parts]


def title_similarity(a: str | None, b: str | None) -> float:
    best = 0.0
    for x in _title_cores(a):
        for y in _title_cores(b):
            if x and y:
                if min(len(x), len(y)) >= 4 and (x in y or y in x):
                    best = max(best, 0.9)
                best = max(best, SequenceMatcher(None, x, y).ratio())
    return best


def _version_words(track: Track) -> set[str]:
    words = set(_words(track.title)) | set(_words(track.file_name))
    return {"remix" if w == "rmx" else w for w in words & _VERSION_WORDS}


def _same_recording(a: Track, b: Track, bit_error: float) -> bool:
    """An audio match is a duplicate when the titles agree (or the audio is near-identical at the same length),
    and neither is a long mix that merely opens with the other or a remix/edit/dub of it."""
    longer, shorter = max(a.duration or 0, b.duration or 0), min(a.duration or 0, b.duration or 0)
    if (longer > 900 and shorter < 0.6 * longer) or _version_words(a) ^ _version_words(b):
        return False
    return (title_similarity(a.title, b.title) >= 0.75
            or (bit_error <= 0.03 and a.duration is not None and b.duration is not None and longer - shorter <= 3))


_LOSSLESS_EXTENSIONS = {"flac", "wav", "aif", "aiff"}


def _is_lossless(member: dict) -> bool:
    codec = (member.get("codec") or "").lower()
    return (member.get("extension") or "").lower() in _LOSSLESS_EXTENSIONS or codec in {"flac", "alac"} \
        or codec.startswith("pcm_")


def suggest_keeper(members: list[dict]) -> dict | None:
    """Which available file of a duplicate group looks best to keep, and the first reason it wins: lossless over
    lossy, then the higher bitrate (lossy files only, in 32 kbps steps: lossless bitrates say nothing about
    quality), then the one with the user's work or plays, then the longer one. None when nothing tells them apart."""
    if len(members) < 2:
        return None

    def rank(member: dict) -> tuple:
        lossless = _is_lossless(member)
        return (lossless, 0 if lossless else round((member.get("bitrate") or 0) / 32000),
                bool(member.get("has_taste")), round(member.get("duration") or 0))

    ordered = sorted(members, key=rank, reverse=True)
    best, second = rank(ordered[0]), rank(ordered[1])
    for reason, mine, other in zip(("lossless", "bitrate", "taste", "longer"), best, second):
        if mine != other:
            return {"track_id": ordered[0]["track_id"], "reason": reason}
    return None


def normalize_title(artist: str | None, title: str | None) -> str:
    raw = f"{artist or ''} {title or ''}".lower()
    # strip bracketed qualifiers and bit-depth noise
    raw = re.sub(r"[\(\[].*?[\)\]]", " ", raw)
    raw = re.sub(r"\b(original mix|extended mix|radio edit|remaster(ed)?|\d+bit)\b", " ", raw)
    raw = re.sub(r"[^a-z0-9]+", " ", raw)
    return " ".join(raw.split())


def _clear_unreviewed(session: Session) -> None:
    """Remove previous auto-generated groups still needing review so a re-run is
    idempotent. Resolved/ignored groups (human decisions) are preserved."""
    stale = session.exec(
        select(DuplicateGroup).where(DuplicateGroup.status == "needs_review")
    ).all()
    stale_ids = [g.id for g in stale]
    if stale_ids:
        session.exec(
            delete(DuplicateGroupTrack).where(
                DuplicateGroupTrack.group_id.in_(stale_ids)  # type: ignore[attr-defined]
            )
        )
        session.exec(
            delete(DuplicateGroup).where(DuplicateGroup.id.in_(stale_ids))  # type: ignore[attr-defined]
        )
        session.commit()


def _decided_sets(session: Session) -> list[frozenset[int]]:
    """Track sets of groups a human resolved or ignored."""
    members: dict[int, set[int]] = defaultdict(set)
    rows = session.exec(
        select(DuplicateGroupTrack.group_id, DuplicateGroupTrack.track_id)
        .join(DuplicateGroup, DuplicateGroup.id == DuplicateGroupTrack.group_id)
        .where(DuplicateGroup.status != "needs_review")
    ).all()
    for group_id, track_id in rows:
        members[group_id].add(track_id)
    return [frozenset(ids) for ids in members.values()]


def detect(session: Session) -> dict:
    _clear_unreviewed(session)
    tracks = session.exec(select(Track).where(Track.missing == False)).all()  # noqa: E712
    decided = _decided_sets(session)

    def already_decided(members: list[Track]) -> bool:
        # A set the user already resolved or ignored stays decided; a new copy makes it new again.
        ids = {tr.id for tr in members}
        return any(ids <= done for done in decided)

    grouped_track_ids: set[int] = set()
    created = {"exact": 0, "metadata": 0}

    # --- exact byte duplicates ---
    by_hash: dict[str, list[Track]] = defaultdict(list)
    for tr in tracks:
        if tr.quick_hash:
            by_hash[tr.quick_hash].append(tr)
    for h, members in by_hash.items():
        if len(members) < 2:
            continue
        if already_decided(members):
            grouped_track_ids.update(tr.id for tr in members)
            continue
        group = DuplicateGroup(reason="exact: identical quick_hash")
        session.add(group)
        session.commit()
        session.refresh(group)
        for tr in members:
            session.add(DuplicateGroupTrack(group_id=group.id, track_id=tr.id))
            grouped_track_ids.add(tr.id)
        session.commit()
        created["exact"] += 1

    # --- metadata suspects (same normalised artist/title, similar duration) ---
    by_norm: dict[str, list[Track]] = defaultdict(list)
    for tr in tracks:
        if tr.id in grouped_track_ids:
            continue
        norm = normalize_title(tr.artist, tr.title)
        if norm:
            by_norm[norm].append(tr)

    for norm, members in by_norm.items():
        if len(members) < 2:
            continue
        # split into duration-similar clusters so radio edit vs extended don't
        # auto-merge: cluster only those within tolerance of each other
        members.sort(key=lambda t: (t.duration or 0))
        clusters: list[list[Track]] = []
        for tr in members:
            placed = False
            for cl in clusters:
                base = cl[0].duration
                if base is None or tr.duration is None:
                    continue
                if abs((tr.duration or 0) - base) <= _DUR_TOLERANCE:
                    cl.append(tr)
                    placed = True
                    break
            if not placed:
                clusters.append([tr])
        for cl in clusters:
            if len(cl) < 2 or already_decided(cl):
                continue
            group = DuplicateGroup(
                reason="metadata: same artist/title, similar duration — review"
            )
            session.add(group)
            session.commit()
            session.refresh(group)
            for tr in cl:
                session.add(DuplicateGroupTrack(group_id=group.id, track_id=tr.id))
                grouped_track_ids.add(tr.id)
            session.commit()
            created["metadata"] += 1

    # --- audio: same recording by fingerprint, the cases the passes above miss ---
    by_id = {tr.id: tr for tr in tracks}
    fingerprints = {}
    for track_id, chromaprint in session.exec(select(Fingerprint.track_id, Fingerprint.chromaprint)).all():
        if track_id in by_id and chromaprint:
            try:
                fingerprints[track_id] = fingerprint_match.decode(chromaprint)
            except ValueError:
                continue
    parent: dict[int, int] = {}

    def root(x: int) -> int:
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b, bit_error, _overlap in fingerprint_match.same_audio_pairs(fingerprints):
        if {a, b} <= grouped_track_ids or not _same_recording(by_id[a], by_id[b], bit_error):
            continue
        parent[root(a)] = root(b)
    clusters: dict[int, list[Track]] = defaultdict(list)
    for track_id in parent:
        clusters[root(track_id)].append(by_id[track_id])
    created["audio"] = 0
    for cl in clusters.values():
        if len(cl) < 2 or already_decided(cl):
            continue
        group = DuplicateGroup(reason=AUDIO_REASON)
        session.add(group)
        session.commit()
        session.refresh(group)
        for tr in sorted(cl, key=lambda t: t.id):
            session.add(DuplicateGroupTrack(group_id=group.id, track_id=tr.id))
        session.commit()
        created["audio"] += 1

    return {
        "groups_created": created["exact"] + created["metadata"] + created["audio"],
        "exact_groups": created["exact"],
        "metadata_groups": created["metadata"],
        "audio_groups": created["audio"],
    }
