from app.services.identity_matching import CandidateIndex, normalized_item, score_candidate, text_key


def item(id, service='local', title='Moon Garden', artist='Alpha & Beta', duration=360000, **kwargs):
    return normalized_item({'id': id, 'service': service, 'title': title, 'artist': artist, 'duration_ms': duration, 'kind': 'track', **kwargs})


def test_parser_noise_and_semantic_versions():
    a = item('a', title='[ABC123] Label Records - Alpha and Beta - Moon Garden (Original Mix) [FREE DOWNLOAD] [180 BPM]')
    r = score_candidate(a, item('b', 'spotify'))
    assert r['evidence']['title_similarity'] > .9 and r['class'] == 'HIGH_CONFIDENCE'
    b = item('c', 'soundcloud', title='Moon Garden (Gamma Remix) [180 BPM]')
    assert 'remix' in b['versions'] and score_candidate(a, b)['class'] == 'CONFLICT'


def test_typo_retrieval_and_scoring_without_equality():
    a = item('a', title='Moon Gardn'); b = item('b', 'spotify')
    assert 'b' in CandidateIndex([b]).retrieve(a)
    r = score_candidate(a, b)
    assert r['class'] in ('HIGH_CONFIDENCE', 'PROBABLE') and r['evidence']['title_similarity'] < 1


def test_filename_repairs_bad_persisted_title():
    a = item('a', title='Official Audio FREE DL', file_name='Alpha & Beta - Moon Garden.mp3')
    r = score_candidate(a, item('b', 'spotify'))
    assert r['evidence']['title_similarity'] == 1 and r['evidence']['title_basis']['left']['basis'].startswith('filename')


def test_missing_duration_requires_review():
    assert score_candidate(item('a', duration=None), item('b', 'soundcloud'))['class'] in ('PROBABLE', 'AMBIGUOUS')


def test_isrc_with_conflicting_version_is_not_accepted():
    a = item('a', isrc='XX-AAA-26-12345'); b = item('b', 'spotify', title='Moon Garden (Live)', isrc='XXAAA2612345')
    r = score_candidate(a, b)
    assert r['evidence']['isrc_equal'] and r['class'] == 'CONFLICT'


def test_corroborated_isrc_acceptance():
    assert score_candidate(item('a', isrc='XXAAA2612345'), item('b', 'spotify', isrc='XXAAA2612345'))['class'] == 'ACCEPTED'


def test_different_named_remixers_conflict():
    r = score_candidate(item('a', title='Moon Garden (Gamma Remix)'), item('b', 'soundcloud', title='Moon Garden (Delta Remix)'))
    assert 'remixer_mismatch' in r['evidence']['conflicts']


def test_filename_only_named_remixers_conflict():
    left = item('a', artist='Alpha', duration=300000, file_name='Alpha - Moon Garden (Gamma Remix).mp3')
    right = item('b', artist='Alpha', duration=300000, file_name='Alpha - Moon Garden (Delta Remix).mp3')
    result = score_candidate(left, right)
    assert result['class'] == 'CONFLICT'
    assert 'remixer_mismatch' in result['evidence']['conflicts']


def test_candidate_index_adds_items_incrementally():
    index = CandidateIndex([])
    candidate = item('b', isrc='XXAAA2612345')
    index.add(candidate)
    assert index.items['b'] is candidate
    assert index.retrieve(item('query')) == ['b']
    assert index.retrieve(item('query', title='Unrelated', artist=None, isrc='XXAAA2612345')) == ['b']


def test_candidate_index_replacement_removes_old_memberships():
    original = item('b', artist='Alpha', isrc='XXAAA2612345')
    unchanged = item('unchanged', artist='Alpha', isrc='XXAAA2612345')
    index = CandidateIndex([original, unchanged])
    indexes = ('tokens', 'grams', 'artists', 'isrcs', 'exact_titles')
    old_keys = {name: set(getattr(index, name)) for name in indexes}
    replacement = item('b', title='Velvet Sky', artist='Quartz', isrc='YYBBB2698765')

    index.add(replacement)

    assert index.items['b'] is replacement
    assert len(index.items) == 2
    for name in indexes:
        for key in old_keys[name]:
            assert getattr(index, name)[key] == {'unchanged'}
    assert index.retrieve(original) == ['unchanged']
    assert index.retrieve(replacement) == ['b']


def test_candidate_index_constructor_keeps_only_latest_id_memberships():
    original = item('b', artist='Alpha', isrc='XXAAA2612345')
    replacement = item('b', title='Velvet Sky', artist='Quartz', isrc='YYBBB2698765')
    index = CandidateIndex([original, replacement])
    assert index.retrieve(original) == []
    assert index.retrieve(replacement) == ['b']
    for name in ('tokens', 'grams', 'artists', 'isrcs', 'exact_titles'):
        assert all(getattr(index, name).values())


def test_weak_popularity_provenance_cannot_override_wrong_artist():
    a = item('a', artist='Distant Planet', album='Likes of DJ PanoramixXX')
    r = score_candidate(a, item('b', 'soundcloud', playback_count=10000000))
    assert r['class'] == 'CONFLICT' and not r['evidence']['popularity_used_for_identity']


def test_existing_decision_preserves_conflicting_evidence():
    a = item('a'); b = item('b', 'soundcloud', title='Moon Garden (Live)')
    r = score_candidate(a, b, {'trusted': True, 'method': 'existing_manual_review'})
    assert r['class'] == 'ACCEPTED' and 'version_mismatch' in r['evidence']['conflicts']


def test_previous_rejection_is_not_resurrected():
    r = score_candidate(item('a'), item('b', 'soundcloud'), {'status': 'rejected'})
    assert r['class'] == 'CONFLICT' and 'previously_rejected' in r['evidence']['conflicts']


def test_uploader_not_treated_as_performer():
    r = score_candidate(item('a', artist='Unknown Artist'), item('b', 'soundcloud', artist=None, uploader='Alpha and Beta'))
    assert r['class'] not in ('HIGH_CONFIDENCE', 'ACCEPTED')


def test_unicode_and_feature_credits():
    assert text_key('Άλφα & Βήτα') == text_key('Αλφα and Βητα')
    assert text_key('Alpha featuring Beta') == text_key('Alpha ft. Beta')
    assert text_key('宇宙') == '宇宙'


def test_primary_database_artist_cannot_be_overruled_by_filename():
    a = item('a', artist='Distant Planet', file_name='Alpha & Beta - Moon Garden.mp3')
    r = score_candidate(a, item('b', 'spotify'))
    assert r['class'] == 'CONFLICT'
    assert 'supplemental_artist_contradicts_primary' in r['evidence']['conflicts']


def test_existing_soundcloud_ranking_and_review_availability_are_preserved():
    from app.models import Track, SoundCloudTrack
    from app.services import soundcloud
    track = Track(absolute_path='fixture-only', title='Moon Garden Sky', artist='Alpha', duration=300)
    remote = SoundCloudTrack(soundcloud_track_id=1, title='Moon Garden', uploader_username='Alpha', duration_ms=300000, raw_json='{}', fetched_at='fixture')
    score = soundcloud.score_match(track, remote)
    assert abs(score.combined_score - (0.55 * (2 / 3) + 0.30 + 0.15)) < 1e-12
    assert score.reasons == ['title token overlap 0.67', 'exact normalized artist', 'duration difference 0.0 seconds']
    assert score.auto_method is None and soundcloud._review_eligible(score)


def test_cross_provider_text_keys_delegate_to_soundcloud_normalizer(monkeypatch):
    from app.services import soundcloud
    calls = []
    original = soundcloud.normalize_match_text
    def observed(value):
        calls.append(value)
        return original(value)
    monkeypatch.setattr(soundcloud, 'normalize_match_text', observed)
    assert text_key('Álpha & Beta') == 'alpha and beta'
    assert calls == ['Álpha  and  Beta']


def test_artist_live_word_is_not_a_recording_version():
    for artist in ('Live Magnet', 'Kayros Live'):
        local = item('a', artist=artist, file_name=f'{artist} - Moon Garden.mp3')
        remote = item('b', 'soundcloud', artist=artist, title=f'{artist} - Moon Garden')
        assert local['versions'] == remote['versions'] == []
        assert score_candidate(local, remote)['class'] == 'HIGH_CONFIDENCE'
    live = item('c', file_name='Alpha & Beta - Moon Garden (Live).mp3')
    assert live['versions'] == ['live']
    assert score_candidate(live, item('d', 'spotify'))['class'] == 'CONFLICT'


def test_playlist_neighbors_do_not_change_permissive_identity_class():
    local = item('a', artist='Technical Hitch', title='Ohm Shri Kali', duration=433591)
    remote = item('b', 'soundcloud', artist=None, uploader='Technical Hitch',
                  title='Technical Hitch - Om Shri Kali (Original Mix)', duration=435188)
    intrinsic = score_candidate(local, remote)
    supported = score_candidate(local, remote, context={'independently_anchored_neighbors': 100})
    assert intrinsic['class'] == supported['class'] == 'HIGH_CONFIDENCE'
    assert intrinsic['score'] < 89 <= supported['score']
    assert supported['score'] - intrinsic['score'] <= 2


def test_wrong_migrated_playlist_substitution_cannot_become_high_confidence():
    original = item('a', title='Moon Garden')
    for wrong in (item('b', 'spotify', artist='Distant Planet'),
                  item('c', 'spotify', title='Moon Garden (Live)'),
                  item('d', 'spotify', title='Distant Oceans'),
                  item('e', 'spotify', duration=480000)):
        intrinsic = score_candidate(original, wrong)
        supported = score_candidate(original, wrong, context={
            'independently_anchored_neighbors': 1000,
            'user_confirmed_sc_to_spotify_transfer': True})
        assert supported['class'] == intrinsic['class']
        assert supported['class'] not in ('ACCEPTED', 'HIGH_CONFIDENCE')


def test_numbered_artist_wrapper_preserves_year_edit_annotation():
    local = item('a', title='Live To Love (2014 Edit)', artist='Kokobloko',
                 file_name='9. Kokobloko - Live To Love (2014 Edit).mp3')
    remote = item('b','soundcloud', title='9. Kokobloko - Live To Love (2014 Edit)', artist=None)
    assert local['versions'] == remote['versions'] == ['edit','live']
    assert 'version_mismatch' not in score_candidate(local,remote)['evidence']['conflicts']


def test_permissive_partial_artist_and_longer_duration_link():
    result = score_candidate(item('a'), item('b', 'spotify', artist='Alpha', duration=372000))
    assert result['class'] == 'HIGH_CONFIDENCE'
    assert .45 <= result['evidence']['artist_similarity'] < .8
    assert result['evidence']['duration_delta_seconds'] == 12
    assert result['evidence']['identity_policy'] == 'coverage_v2'


def test_weak_artists_allow_provider_performer_without_false_conflict():
    for artist in ('1', '280', '1/280', 'Unknown Artist', 'Some Records', None):
        local = item('a', artist=artist)
        result = score_candidate(local, item('b', 'spotify', duration=366000))
        assert local['artist_variants'] == []
        assert result['class'] == 'HIGH_CONFIDENCE', (artist, result)
        assert not result['evidence']['conflicts']
        assert result['evidence']['weak_artist_performer_evidence']


def test_numeric_primary_does_not_contradict_filename_performer():
    local = item('a', artist='280', file_name='Alpha & Beta - Moon Garden.mp3')
    result = score_candidate(local, item('b', 'spotify'))
    assert result['class'] == 'HIGH_CONFIDENCE'
    assert 'supplemental_artist_contradicts_primary' not in result['evidence']['conflicts']


def test_weak_artist_alternative_requires_short_duration_and_performer():
    local = item('a', artist=None)
    assert score_candidate(local, item('b', 'spotify', duration=366001))['class'] != 'HIGH_CONFIDENCE'
    uploader = item('c', 'soundcloud', artist=None, uploader='Alpha & Beta')
    assert score_candidate(local, uploader)['class'] not in {'HIGH_CONFIDENCE', 'ACCEPTED'}
    wrapped = item('d', 'soundcloud', artist=None, title='Alpha & Beta - Moon Garden')
    assert score_candidate(local, wrapped)['class'] == 'HIGH_CONFIDENCE'


def test_pair_isrc_contradiction_is_visible_before_promotion():
    result = score_candidate(item('a', isrc='AAA'), item('b', 'spotify', isrc='BBB'))
    assert result['class'] == 'CONFLICT'
    assert 'contradictory_isrc' in result['evidence']['conflicts']


def test_permissive_candidates_still_require_distinct_near_tie_review():
    from app.services.identity_matching import annotate_near_ties
    local = item('a')
    providers = [item('b', 'spotify', artist='Alpha'), item('c', 'spotify', artist='Alpha', duration=361000)]
    results = [{'left_id': 'a', 'right_id': remote['id'], **score_candidate(local, remote)}
               for remote in providers]
    assert all(row['class'] == 'HIGH_CONFIDENCE' for row in results)
    annotate_near_ties(results, {'a': 'a', 'b': 'b', 'c': 'c'},
                       {'a': 'local', 'b': 'spotify', 'c': 'spotify'})
    assert all(row['class'] == 'AMBIGUOUS' and row['evidence']['near_tie_review'] for row in results)
