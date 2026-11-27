"""Search mini-syntax — field filters, FTS, recency, and transition flags.

Covers the flagship query:
    status:approved darkness:7+ energy:8+ bpm:150-160 role:bridge break:long
    tolerance:huge not_recent:30 dramatic
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.db import reindex_track
from app.models import ArtistProfile, Track, TrackDJProfile
from app.services import search


def _mk(db, path, bpm=150, played=None, play_count=0, **profile) -> Track:
    t = Track(absolute_path=path, bpm=bpm, missing=False,
              play_count=play_count, last_played_at=played)
    db.add(t)
    db.commit()
    db.refresh(t)
    db.add(TrackDJProfile(track_id=t.id, **profile))
    db.commit()
    reindex_track(db, t.id)
    return t


def _paths(rows):
    return {t.absolute_path for t in rows}


def test_flagship_query(db):
    _mk(db, "/holy.wav", bpm=154, energy=9, darkness=8, set_role="bridge",
        breakdown_profile="long melodic break", personal_status="approved",
        bpm_jump_tolerance="huge", dramatic_transition_candidate=True)
    # played recently -> excluded by not_recent:30
    _mk(db, "/recent.wav", bpm=154, played=datetime.now(UTC) - timedelta(days=1),
        play_count=1, energy=9, darkness=8, set_role="bridge",
        breakdown_profile="long melodic break", personal_status="approved",
        bpm_jump_tolerance="huge", dramatic_transition_candidate=True)
    # not dramatic -> excluded by `dramatic`
    _mk(db, "/calm.wav", bpm=154, energy=9, darkness=8, set_role="bridge",
        breakdown_profile="long melodic break", personal_status="approved",
        bpm_jump_tolerance="huge", dramatic_transition_candidate=False)

    q = ("status:approved darkness:7+ energy:8+ bpm:150-160 role:bridge "
         "break:long tolerance:huge not_recent:30 dramatic")
    assert _paths(search.search(db, q)) == {"/holy.wav"}


def test_recency_tokens(db):
    _mk(db, "/never.wav")
    _mk(db, "/old.wav", played=datetime.now(UTC) - timedelta(days=90), play_count=2)
    _mk(db, "/fresh.wav", played=datetime.now(UTC) - timedelta(days=2), play_count=1)

    assert _paths(search.search(db, "not_recent:30")) == {"/never.wav", "/old.wav"}
    assert _paths(search.search(db, "played_recently:30")) == {"/fresh.wav"}
    assert _paths(search.search(db, "never_played")) == {"/never.wav"}


def test_no_energy_includes_tracks_without_a_profile_row(db):
    _mk(db, "/rated.wav", energy=7, play_count=2)
    _mk(db, "/empty.wav", darkness=4, play_count=1)          # a profile row, no energy
    bare = Track(absolute_path="/bare.wav", bpm=150, missing=False, play_count=3)  # no profile row at all
    db.add(bare)
    db.commit()
    reindex_track(db, bare.id)
    _mk(db, "/unplayed.wav")

    assert _paths(search.search(db, "no_energy")) == {"/empty.wav", "/bare.wav", "/unplayed.wav"}
    assert _paths(search.search(db, "-no_energy")) == {"/rated.wav"}
    # The /tag queue «Παιγμένα χωρίς ενέργεια».
    assert _paths(search.search(db, "no_energy -never_played")) == {"/empty.wav", "/bare.wav"}


def test_lufs_ranges_bounds_whole_db_and_negation(db):
    for path, lufs in (("/loud.wav", -6.2), ("/hot.wav", -8.4), ("/mid.wav", -9.6), ("/quiet.wav", -14.0)):
        t = _mk(db, path)
        t.loudness_lufs = lufs
        db.add(t)
        db.commit()
    _mk(db, "/unmeasured.wav")

    assert _paths(search.search(db, "lufs:-10--8")) == {"/hot.wav", "/mid.wav"}
    assert _paths(search.search(db, "lufs:-8--10")) == {"/hot.wav", "/mid.wav"}     # either order
    for half_typed in ("lufs:+", "lufs:-+", "lufs:--", "lufs:-", "bpm:+"):
        search.search(db, half_typed)                                         # never raises
    assert _paths(search.search(db, "lufs:-8.4+")) == {"/loud.wav", "/hot.wav"}
    assert _paths(search.search(db, "lufs:-12-")) == {"/quiet.wav"}
    assert _paths(search.search(db, "lufs:-8")) == {"/hot.wav"}            # the whole dB: -8.5 to -7.5
    assert _paths(search.search(db, "-lufs:-9+")) == {"/mid.wav", "/quiet.wav", "/unmeasured.wav"}
    assert _paths(search.search(db, "bpm:140-")) == set()                 # the unsigned `N-` form is unchanged


def test_transition_flag_tokens(db):
    _mk(db, "/d.wav", dramatic_transition_candidate=True, can_cut_into=True)
    _mk(db, "/plain.wav", dramatic_transition_candidate=False)

    assert _paths(search.search(db, "dramatic")) == {"/d.wav"}
    assert _paths(search.search(db, "can_cut_into")) == {"/d.wav"}
    assert _paths(search.search(db, "-dramatic")) == {"/plain.wav"}


def _mk_artist_track(db, path, normalized, needs_review):
    """A track whose artist has an ArtistProfile, joined via artist_normalized."""
    t = Track(absolute_path=path, missing=False, artist_normalized=normalized)
    db.add(t)
    db.add(ArtistProfile(
        normalized_name=normalized, canonical_name=normalized.title(),
        track_count=1, needs_review=needs_review,
    ))
    db.commit()
    return t


def test_artist_review_filter_keeps_tracks_without_a_profile(db):
    # NULL needs_review (no ArtistProfile) must not be silently dropped by
    # `artist_review:no` — it means "not flagged", so include it.
    _mk_artist_track(db, "/flagged.wav", "flaggedartist", needs_review=True)
    _mk_artist_track(db, "/clean.wav", "cleanartist", needs_review=False)
    # unenriched: has an artist_normalized but no ArtistProfile row -> NULL join
    no_profile = Track(absolute_path="/unenriched.wav", missing=False,
                       artist_normalized="ghostartist")
    db.add(no_profile)
    db.commit()

    assert _paths(search.search(db, "artist_review:yes")) == {"/flagged.wav"}
    assert _paths(search.search(db, "artist_review:no")) == {"/clean.wav", "/unenriched.wav"}


def test_status_accepts_a_comma_list(db):
    for status in ("approved", "weapon", "testing"):
        _mk(db, f"/{status}.wav", personal_status=status)
    _mk(db, "/blank.wav")
    assert _paths(search.search(db, "status:approved,weapon")) == {"/approved.wav", "/weapon.wav"}
    assert _paths(search.search(db, "-status:approved,weapon")) == {"/testing.wav", "/blank.wav"}
    assert _paths(search.search(db, "status:approved")) == {"/approved.wav"}


def test_added_created_days_ranges_and_combined_filters(db):
    now = datetime.now(UTC)
    for name, added_days, created_days in [('new', 2, 70), ('middle', 45, 5), ('old', 100, 100)]:
        t = _mk(db, f'/{name}.wav', personal_status='approved')
        t.imported_at = now - timedelta(days=added_days)
        t.created_time = (now - timedelta(days=created_days)).timestamp()
        db.add(t)
    db.commit()
    assert _paths(search.search(db, 'added:30')) == {'/new.wav'}
    assert _paths(search.search(db, 'added:60d status:approved')) == {'/new.wav', '/middle.wav'}
    assert _paths(search.search(db, 'added:30-60')) == {'/middle.wav'}
    assert _paths(search.search(db, 'created:30')) == {'/middle.wav'}
    assert _paths(search.search(db, '-added:30')) == {'/middle.wav', '/old.wav'}
    assert search.count(db, 'added:60') == 2


def test_date_range_includes_last_day_and_excludes_next_midnight(db):
    for name, date in [('first', '2026-09-01T00:00:00'), ('last', '2026-09-30T23:59:59'), ('next', '2026-10-01T00:00:00')]:
        t = _mk(db, f'/{name}.wav')
        t.imported_at = datetime.fromisoformat(date).replace(tzinfo=UTC)
        t.created_time = t.imported_at.timestamp()
        db.add(t)
        db.commit()
    unknown = _mk(db, '/unknown.wav')
    unknown.imported_at = datetime(2000, 1, 1, tzinfo=UTC)
    db.add(unknown)
    db.commit()
    for field in ['added', 'created']:
        assert _paths(search.search(db, f'{field}:2026-09-01..2026-09-30')) == {'/first.wav', '/last.wav'}
        assert _paths(search.search(db, f'{field}:2026-09-30')) == {'/last.wav'}
        for invalid in ['bad', '60-30', '2026-09-30..2026-09-01', '2026-02-30', '99999999999999999999999']:
            assert search.search(db, f'{field}:{invalid}') == []


def test_negated_profile_filters_keep_tracks_with_no_value(db):
    """A missing profile or a NULL field counts as "not X", as `-bpm` and `-key` already do."""
    untagged = Track(absolute_path="/untagged.wav", missing=False)
    db.add(untagged)
    db.commit()
    reindex_track(db, untagged.id)
    _mk(db, "/approved.wav", energy=5, personal_status="approved")
    both = {"/untagged.wav", "/approved.wav"}
    for query in ("-retired", "-status:retired", "-energy:9", "-weapons", "-dramatic", "-role:peak", "-can_cut_into"):
        assert _paths(search.search(db, query)) == both, query
    assert _paths(search.search(db, "-approved")) == {"/untagged.wav"}
    assert _paths(search.search(db, "approved")) == {"/approved.wav"}
    assert _paths(search.search(db, "energy:9")) == set()


def test_reversed_whole_bpm_range_matches_like_the_decimal_one(db):
    _mk(db, "/a.wav", bpm=145.0)
    _mk(db, "/b.wav", bpm=138.0)
    for query in ("bpm:137-150", "bpm:150-137", "bpm:150.0-137.0"):
        assert _paths(search.search(db, query)) == {"/a.wav", "/b.wav"}, query
    assert _paths(search.search(db, "-bpm:150-137")) == set()
