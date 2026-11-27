"""Review-only relink of moved tracks — proposes pairs, never merges on its own, never touches files.

A file that was moved AND retagged gets a new content hash, so the scanner's automatic merge of moved
tracks (`scanner._merge_moved`) cannot see it: the old row goes missing with the user's work on it and
the file comes back as a bare new row. `candidates` pairs such a missing row with the present row that
holds the same recording: same audio by Chromaprint (`fingerprint_match`, its measured thresholds), the
same duration within DURATION_TOLERANCE, and one candidate on each side. `merge` moves the old row's
data to the new row through `scanner.merge_tracks`, only for pairs the user confirmed and that are
still candidates.

Not covered: a missing track that never got a fingerprint, a track with no known duration, a present
copy that already has work of its own, and a missing track with more than one possible new file.
"""
from __future__ import annotations

from sqlalchemy import text
from sqlmodel import Session, select

from ..models import Fingerprint, Track
from . import fingerprint_match, scanner

DURATION_TOLERANCE = 3.0  # seconds; a retag never changes the audio's length
# The user's own work on a track. Analysis results (fingerprint, beatgrid, structure) are not: every file gets those.
_TASTE = (("track_dj_profile", "track_id"), ("track_tags", "track_id"), ("track_cues", "track_id"),
          ("track_downbeats", "track_id"), ("set_tracks", "track_id"), ("set_transitions", "from_track_id"),
          ("set_transitions", "to_track_id"), ("track_pair_notes", "from_track_id"),
          ("track_pair_notes", "to_track_id"), ("play_events", "track_id"))


def taste_track_ids(session: Session) -> set[int]:
    """Tracks that carry the user's work: a profile, tags, cues, a downbeat, set use, pair notes, plays
    or a manual BPM fix."""
    sql = " UNION ".join(f'SELECT "{column}" FROM "{table}"' for table, column in _TASTE)
    return {row[0] for row in session.execute(text(
        sql + " UNION SELECT id FROM tracks WHERE play_count > 0 OR bpm_consensus_sources LIKE 'manual:%'"))}


def _describe(track: Track) -> dict:
    return {"track_id": track.id, "artist": track.artist, "title": track.title, "duration": track.duration,
            "extension": track.extension, "absolute_path": track.absolute_path}


def candidates(session: Session) -> dict:
    tracks = session.exec(select(Track)).all()
    taste = taste_track_ids(session)
    stored = dict(session.exec(select(Fingerprint.track_id, Fingerprint.chromaprint)).all())
    old = {t.id: t for t in tracks if t.missing and t.id in taste}
    usable = {i: t for i, t in old.items() if stored.get(i) and t.duration}
    new = {t.id: t for t in tracks if not t.missing and t.id not in taste and stored.get(t.id) and t.duration
           and any(abs(t.duration - o.duration) <= DURATION_TOLERANCE for o in usable.values())}
    fingerprints = {}
    for track_id in (*usable, *new):
        try:
            fingerprints[track_id] = fingerprint_match.decode(stored[track_id])
        except ValueError:
            continue
    matches: dict[int, list[int]] = {}
    for a, b, _error, _overlap in fingerprint_match.same_audio_pairs(fingerprints):
        for old_id, new_id in ((a, b), (b, a)):
            if (old_id in usable and new_id in new
                    and abs(usable[old_id].duration - new[new_id].duration) <= DURATION_TOLERANCE):
                matches.setdefault(old_id, []).append(new_id)
    claimed: dict[int, int] = {}
    for new_ids in matches.values():
        for new_id in new_ids:
            claimed[new_id] = claimed.get(new_id, 0) + 1
    pairs = [(old_id, new_ids[0]) for old_id, new_ids in sorted(matches.items())
             if len(new_ids) == 1 and claimed[new_ids[0]] == 1]
    return {
        "pairs": [{"old": _describe(old[o]), "new": _describe(new[n])} for o, n in pairs],
        "missing_with_data": len(old),
        "not_checked": len(old) - len(usable),   # no fingerprint or no known duration
        "ambiguous": len(matches) - len(pairs),  # more than one possible new file, or one new file for two old rows
    }


def merge(session: Session, requested: list[tuple[int, int]]) -> dict:
    """Merge the confirmed pairs that are still candidates; anything else is left alone and counted."""
    current = {(p["old"]["track_id"], p["new"]["track_id"]) for p in candidates(session)["pairs"]}
    accepted = [pair for pair in dict.fromkeys(requested) if pair in current]
    # The new row's tag columns are what the retagged file holds now: an empty one is a removed tag.
    merged = scanner.merge_tracks(session, accepted, reason="confirmed same recording",
                                  keep_new=scanner._EMBEDDED_COLUMNS)
    session.commit()
    return {"merged": merged, "skipped": len(requested) - merged}
