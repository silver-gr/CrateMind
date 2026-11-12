"""Technical title annotations remain visible without rewriting personal notes."""
import json

import pytest

from app.services import metadata_display as display
from .test_metadata_display import identity, source


@pytest.mark.parametrize('title,expected', [
    ('Vision [200] unmastered', [('unmastered', 'Χωρίς mastering (unmastered)')]),
    ('Song (unmastered)', [('unmastered', 'Χωρίς mastering (unmastered)')]),
    ('Song [190] Inprocess', [('in_progress', 'Σε επεξεργασία')]),
    ('Digital Jungle Master16', [('mastering_bit_depth', 'Mastering 16 bit')]),
    ('Emotional Transfer [180] 24bit', [('bit_depth', 'Ένδειξη 24 bit')]),
    ('Song (Unmastered Records Remix)', []),
    ('The Unmastered Symphony', []),
    ('Song Released on Unmastered Records', []),
    ('Unmastered', []),
])
def test_comments_follow_annotations_actually_removed(title, expected):
    row = display.source_fields({'id': 'local:1', 'service': 'local', 'artist': 'Artist', 'title': title})
    assert [(c['kind'], c['text']) for c in row['metadata_comments']] == expected


def test_comments_deduplicate_title_and_filename_and_keep_raw_comment():
    row = {'id': 1, 'artist': 'Artist', 'title': 'Song unmastered',
           'file_name': 'Artist - Song unmastered.mp3', 'comment': 'Original file comment'}
    display.apply_local_fields(row)
    display.apply_local_fields(row)
    assert row['title'] == 'Song'
    assert row['original_title'] == 'Song unmastered'
    assert row['comment'] == 'Original file comment'
    assert row['metadata_comments'] == [{'kind': 'unmastered', 'text': 'Χωρίς mastering (unmastered)', 'source_id': 'local:1'}]


@pytest.mark.parametrize('state', ['review', 'human', 'kept_local', 'rejected'])
def test_recording_source_comments_preserve_manual_metadata_and_write_nothing(identity, state):
    local = source(identity, 'local:1', 'Artist', 'Song unmastered')
    identity.execute('UPDATE canonical_recordings SET state=?', (state,))
    before = identity.total_changes
    identity.execute('PRAGMA query_only=ON')
    row = display.recordings(identity, [local])[local]
    assert row['metadata_comments'][0]['kind'] == 'unmastered'
    assert row['title'] == ('Song' if state == 'review' else 'Song unmastered')
    assert identity.total_changes == before


def test_canonical_overlay_does_not_transfer_mastering_state_between_local_files(identity):
    local = source(identity, 'local:1', 'Artist', 'Song unmastered')
    source(identity, 'local:2', 'Artist', 'Song', rid=local)
    row = display.apply_local_fields({'id': 2, 'artist': 'Artist', 'title': 'Song', 'file_name': 'Song.wav'})
    row['canonical_recording_id'] = local
    display.apply_recordings(identity, [row], 'canonical_recording_id')
    assert row['metadata_comments'] == []


def test_track_detail_comments_do_not_change_stored_notes(db):
    from app.api.tracks import _track_payload
    from app.models import Track, TrackDJProfile
    track = Track(absolute_path='/fixture-only/song.mp3', file_name='Artist - Song unmastered.mp3',
                  extension='mp3', title='Song unmastered', artist='Artist', comment='File comment')
    db.add(track)
    db.flush()
    profile = TrackDJProfile(track_id=track.id, notes='My own note')
    db.add(profile)
    db.commit()
    payload = _track_payload(db, track)
    assert payload['track']['title'] == 'Song'
    assert payload['track']['comment'] == 'File comment'
    assert payload['track']['metadata_comments'][0]['kind'] == 'unmastered'
    assert payload['profile']['notes'] == 'My own note'
    db.refresh(track)
    db.refresh(profile)
    assert track.title == 'Song unmastered'
    assert profile.notes == 'My own note'


def test_stacked_technical_annotations_are_deduplicated():
    row = display.source_fields({'service': 'local', 'title': 'Song unmastered 24bit', 'artist': 'Artist'})
    assert {c['kind'] for c in row['metadata_comments']} == {'unmastered', 'bit_depth'}
