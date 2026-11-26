"""source_keys: each link rule's positive and nearest negative, the fold keys and the version guard (synthetic only)."""
import pytest

from app.services import source_keys as sk


def rec(sid, artist, title, dur=300.0, **extra):
    service = sid.split(':')[0]
    return {'id': sid, 'service': service, 'artist': artist, 'title': title, 'dur': dur, 'album': '', 'uploader': '',
            'file_name': '', 'sc_pub_artist': '', 'isrc': '', **extra}


def rule(local, remote):
    return sk.RemoteIndex([remote]).pairs(local).get(remote['id'], (None,))[0]


@pytest.mark.parametrize('local,remote,expected', [
    # text_exact: only case, accents and punctuation differ
    (rec('local:1', 'Alpha Beta', 'Moon Garden'), rec('spotify:track:a', 'ALPHA BETA', 'Móon Gärden!'), 'text_exact'),
    (rec('local:1', 'Alpha Beta', 'Moon Garden'), rec('spotify:track:a', 'Alpha Beta', 'Moon Gate'), None),
    # text_clean: noise stripped, "(Original Mix)" equals " - Original Mix"; a bracket with other text does not
    (rec('local:1', 'Alpha Beta', 'Moon Garden (Original Mix) [180BPM]'), rec('spotify:track:a', 'Alpha Beta', 'Moon Garden - Original Mix'), 'text_clean'),
    (rec('local:1', 'Alpha Beta', 'Moon Garden (Zed Rmx)'), rec('spotify:track:a', 'Alpha Beta', 'Moon Garden - Zed Remix'), 'text_clean'),
    (rec('local:1', 'Alpha Beta', 'Moon Garden (Night Session)'), rec('spotify:track:a', 'Alpha Beta', 'Moon Garden'), 'artist_variant'),
    # a remix against its original is another version, never a link
    (rec('local:1', 'Alpha Beta', 'Moon Garden (Zed Remix)'), rec('spotify:track:a', 'Alpha Beta', 'Moon Garden'), 'version'),
    # artist_variant: the artists share one name
    (rec('local:1', 'Alpha Beta & Gamma Ray', 'Moon Garden'), rec('spotify:track:a', 'Alpha Beta', 'Moon Garden'), 'artist_variant'),
    (rec('local:1', 'Alpha Beta', 'Moon Garden'), rec('spotify:track:a', 'Gamma Ray', 'Moon Garden'), 'title_only'),
    # artist_in_title: the artist sits in the title, the file name or the SoundCloud uploader
    (rec('local:1', 'Some Label', 'Alpha Beta - Moon Garden'), rec('spotify:track:a', 'Alpha Beta', 'Moon Garden'), 'artist_in_title'),
    (rec('local:1', 'Some Label', 'Moon Garden', file_name='Alpha Beta - Moon Garden.mp3'), rec('spotify:track:a', 'Alpha Beta', 'Moon Garden'), 'artist_in_title'),
    (rec('local:1', 'Alpha Beta', 'Moon Garden'), rec('soundcloud:tracks:1', 'Some Label', 'Moon Garden', uploader='Alpha Beta'), 'artist_in_title'),
    # same_words: the same words in another order, with the artist's words on one side
    (rec('local:1', 'Moon Garden', 'Alpha Beta'), rec('spotify:track:a', 'Alpha Beta', 'Moon Garden'), 'same_words'),
    (rec('local:1', 'Unknown Artist', 'Alpha Beta Moon Garden'), rec('spotify:track:a', 'Alpha Beta', 'Moon Garden'), 'same_words'),
    # a three-word title with different artists is title-only; with an unknown local artist it is its own rule
    (rec('local:1', 'Delta Echo', 'Silver River Night'), rec('spotify:track:a', 'Kilo Lima', 'Silver River Night'), 'title_only'),
    (rec('local:1', 'Unknown Artist', 'Silver River Night'), rec('spotify:track:a', 'Kilo Lima', 'Silver River Night'), 'title_unknown_artist'),
    (rec('local:1', '', 'Night', file_name='Night.mp3'), rec('spotify:track:a', 'Kilo Lima', 'Night'), 'title_unknown_artist'),
    # title_supported: the remote artist is named in the local album or file name, or the albums agree
    (rec('local:1', 'Delta Echo', 'Silver River Night', album='Kilo Lima Collected'), rec('spotify:track:a', 'Kilo Lima', 'Silver River Night'), 'title_supported'),
    (rec('local:1', 'Delta Echo', 'Silver River Night', album='VA - Northern Lights'), rec('spotify:track:a', 'Kilo Lima', 'Silver River Night', album='Northern Lights'), 'title_supported'),
    (rec('local:1', 'Delta Echo', 'Silver River Night', album='Other Things'), rec('spotify:track:a', 'Kilo Lima', 'Silver River Night', album='Northern Lights'), 'title_only'),
])
def test_link_rule_of_a_pair(local, remote, expected):
    assert rule(local, remote) == expected


def test_the_tightest_rule_wins_and_title_only_never_ranks_as_a_link_rule():
    assert sk.RANK['text_exact'] < sk.RANK['same_words'] < sk.RANK['title_supported'] < sk.RANK['title_only'] < sk.RANK['version']
    assert set(sk.TITLE_ONLY_RULES) < set(sk.LINK_RULES) and 'title_only' not in sk.LINK_RULES and 'version' not in sk.LINK_RULES
    local = rec('local:1', 'Alpha Beta', 'Moon Garden', file_name='Alpha Beta - Moon Garden.mp3')
    assert rule(local, rec('spotify:track:a', 'Alpha Beta', 'Moon Garden')) == 'text_exact'


def test_fold_keys_ignore_plain_brackets_keep_versions_and_need_a_real_artist():
    plain, labelled = (sk.fold_keys(rec('spotify:track:a', 'Alpha Beta', title)) for title in ('Moon Garden', 'Moon Garden (Night Label)'))
    assert plain['text_clean'] == labelled['text_clean'] == [('alpha beta', 'moon garden', '')]
    assert plain['text_exact'] != labelled['text_exact']
    remix = sk.fold_keys(rec('spotify:track:a', 'Alpha Beta', 'Moon Garden - Zed Rmx'))
    assert remix['text_clean'] == [('alpha beta', 'moon garden', 'zed remix')]
    carried = sk.fold_keys(rec('soundcloud:tracks:1', 'Some Label', 'Alpha Beta - Moon Garden'))
    assert ('alpha beta', 'moon garden', '') in carried['artist_in_title'] and ('alpha beta', 'moon garden', '') not in carried['text_clean']
    unknown = sk.fold_keys(rec('spotify:track:a', 'Various Artists', 'Moon Garden', isrc='AAA111'))
    assert (unknown['text_exact'], unknown['text_clean'], unknown['artist_in_title'], unknown['isrc_duration']) == ([], [], [], ['AAA111'])


@pytest.mark.parametrize('a,b,same', [
    ('Moon Garden (Zed Rmx)', 'Moon Garden - Zed Remix', True),           # rmx = remix
    ('Moon Garden (Original Mix)', 'Moon Garden', True),                  # Original Mix is no version
    ('Moon Garden (Remix)', 'Moon Garden - Zed Remix', True),             # one side does not name the remixer
    ('Moon Garden (Zed Remix)', 'Moon Garden', False),                    # a remix and its original
    ('Moon Garden - Zed Remix', 'Moon Garden - Yan Mix', False),          # remix against mix
    ('Moon Garden (Zed Remix)', 'Moon Garden (Yan Remix)', False),        # two remixers
    ('Moon Garden (Radio Edit)', 'Moon Garden (Extended)', False),
    ('Inner Talk (Chapter One)', 'Inner Talk (Chapter Two)', False),      # numbered parts in plain brackets
    ('Inner Talk (Night Label)', 'Inner Talk', True),                     # a label on one side only
])
def test_version_guard(a, b, same):
    marks = lambda title: sk.version_marks(rec('spotify:track:a', 'Alpha Beta', title))
    assert sk.same_version(marks(a), marks(b)) is same


def test_a_local_file_may_carry_its_version_in_the_file_name():
    local = rec('local:1', 'Alpha Beta', 'Moon Garden', file_name='Alpha Beta - Moon Garden (Zed Remix).mp3')
    remix = rec('spotify:track:a', 'Alpha Beta', 'Moon Garden - Zed Remix')
    assert sk.same_version(sk.version_marks(local), sk.version_marks(remix))
    assert rule(local, remix) == 'artist_in_title'


def test_fuzzy_lead_needs_artist_evidence_and_the_window():
    index = sk.RemoteIndex([rec('spotify:track:a', 'Alpha Beta', 'Jokers Smiles Again', dur=301.0),
                            rec('spotify:track:b', 'Kilo Lima', 'Parallel Dimensions', dur=302.0)])
    assert index.fuzzy(rec('local:1', 'Alpha Beta', 'Jokers Smile Again')) == ('spotify:track:a', 1.0, True)
    assert index.fuzzy(rec('local:2', 'Delta Echo', 'Parallel Dimension'))[2] is False   # similar title, no artist evidence
    assert index.fuzzy(rec('local:3', 'Alpha Beta', 'Jokers Smile Again', dur=310.0)) is None
