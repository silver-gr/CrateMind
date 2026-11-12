"""Presentation cleans source titles without changing identity evidence."""
import json

from app.models import SoundCloudTrack
from app.services import provider_resolution, soundcloud
from .test_canonical import entity


def test_canonical_provider_snapshot_keeps_raw_title():
    raw_title = 'Kaikkialla & AlpsCore - Phatty (200) Soon on STZ - Records'
    item = entity('soundcloud:tracks:123', 'soundcloud', artist='Kaikkialla & AlpsCore', title=raw_title)
    item.update(permalink='https://soundcloud.com/fixture/phatty', duration_ms=412000, recording_id='local:1')
    snapshot = provider_resolution.source(item)['soundcloud_snapshot']
    assert snapshot['title'] == raw_title
    assert snapshot['display_title'] == 'Phatty'
    assert snapshot['display_artist'] == 'Kaikkialla & AlpsCore'
    assert item['title'] == raw_title


def test_legacy_provider_snapshot_keeps_raw_title_and_does_not_credit_uploader():
    raw_title = 'Kaikkialla - Bella Ciao 180 Released on Hipnotic Tribe Rec.'
    item = SoundCloudTrack(soundcloud_track_id=123, title=raw_title, uploader_username='Some Records')
    snapshot = soundcloud.serialize_snapshot(item)
    assert snapshot['title'] == item.title == raw_title
    assert snapshot['display_title'] == 'Bella Ciao'
    assert snapshot['display_artist'] == 'Kaikkialla'
    item.title = 'Bella Ciao [180]'
    assert soundcloud.serialize_snapshot(item)['display_artist'] == ''


def test_provider_performer_metadata_is_not_uploader():
    item = SoundCloudTrack(soundcloud_track_id=123, title='Song [180]', uploader_username='Label',
                          publisher_metadata_json=json.dumps({'artist': 'Real performer'}))
    snapshot = soundcloud.serialize_snapshot(item)
    assert snapshot['display_artist'] == 'Real performer'
    assert snapshot['uploader_username'] == 'Label'
