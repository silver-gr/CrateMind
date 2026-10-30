from app.models import SoundCloudTrack, Track
from app.services.soundcloud import _review_eligible, score_match


def remote(title='Moon Garden', artist=None, uploader='Alpha', duration=300000):
    import json
    return SoundCloudTrack(soundcloud_track_id=1, title=title, uploader_username=uploader,
                           duration_ms=duration, raw_json='{}', fetched_at='fixture',
                           publisher_metadata_json=json.dumps({'artist': artist}) if artist else None)


def test_matching_uploader_alone_cannot_automatically_supply_performer():
    local = Track(absolute_path='fixture-only', title='Moon Garden', artist='Alpha', duration=300)
    assert score_match(local, remote()).auto_method is None
    assert score_match(local, remote(artist='Alpha')).auto_method == 'exact_metadata'


def test_title_performer_and_numeric_local_artist_can_link():
    local = Track(absolute_path='fixture-only', title='Moon Garden', artist='280', duration=300)
    assert score_match(local, remote(title='Alpha - Moon Garden')).auto_method == 'exact_metadata'


def test_review_is_available_for_title_and_duration_without_artist_overlap():
    local = Track(absolute_path='fixture-only', title='Moon Garden', artist=None, duration=300)
    evidence = score_match(local, remote())
    assert evidence.artist_score == 0 and evidence.auto_method is None
    assert _review_eligible(evidence)
    assert not _review_eligible(score_match(local, remote(duration=316000)))
    assert not _review_eligible(score_match(local, remote(title='Other Song')))


def test_automatic_matching_keeps_version_and_remixer_guards():
    local = Track(absolute_path='fixture-only', title='Moon Garden', artist='Alpha', duration=300)
    assert score_match(local, remote(title='Moon Garden (Live)', artist='Alpha')).auto_method is None
    local.title = 'Moon Garden (Gamma Remix)'
    assert score_match(local, remote(title='Moon Garden (Delta Remix)', artist='Alpha')).auto_method is None
