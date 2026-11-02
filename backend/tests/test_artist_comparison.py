import json
from datetime import UTC, datetime

from app.models import ArtistProfile, ArtistReview
from app.services.artist_genre_research import WORKFLOW_VERSION
from app.services.artist_intelligence import enrich_artist_profiles


def candidate(status='classified', genre='Hi-Tech'):
    research = {'workflow': WORKFLOW_VERSION, 'status': status,
                'sources': [{'url': 'https://example.org/artist', 'evidence': 'Label evidence'}],
                'reason': 'Genre evidence', 'outside_genre': None,
                'model': 'gpt-6-luna', 'reasoning_effort': 'max'}
    return {'primary_subgenre': genre if status == 'classified' else None,
            'scene_cluster': 'hi-tech', 'secondary_subgenres_json': '[]',
            'confidence_label': 'high', 'needs_review': True, 'notes': 'Genre evidence',
            'raw_llm_json': json.dumps({'research': research}), 'research': research}


def test_comparison_keeps_active_profile_and_confirmation_blocks_enrichment(db, monkeypatch):
    p = ArtistProfile(normalized_name='crone', canonical_name='Crone', track_count=10, primary_subgenre='Forest', last_enriched_at=datetime.now(UTC))
    db.add(p); db.commit()
    review = ArtistReview(artist_id=p.id, baseline_json=json.dumps(p.model_dump(mode='json')))
    db.add(review); db.commit()
    monkeypatch.setattr('app.services.artist_genre_research.research_artist', lambda *a: candidate(genre='Psycore'))
    assert enrich_artist_profiles(db, comparison=True)['updated'] == 1
    db.refresh(p); db.refresh(review)
    assert p.primary_subgenre == 'Forest'
    assert json.loads(review.candidate_json)['primary_subgenre'] == 'Psycore'
    review.confirmed_at=datetime.now(UTC); db.add(review); db.commit()
    assert enrich_artist_profiles(db, force=True)['processed'] == 0


def test_accept_candidate_and_manual(client, db):
    p=ArtistProfile(normalized_name='a',canonical_name='A',track_count=2,primary_subgenre='old')
    db.add(p);db.commit()
    db.add(ArtistReview(artist_id=p.id,baseline_json='{}',candidate_json=json.dumps({'primary_subgenre':'new'}),state='ready'));db.commit()
    result=client.post(f'/api/artists/{p.id}/review',json={'choice':'candidate'})
    assert result.status_code==200 and result.json()['primary_subgenre']=='new'
    result=client.post(f'/api/artists/{p.id}/review',json={'choice':'manual','subgenre':'Corrected'})
    assert result.json()['primary_subgenre']=='Corrected'
    assert client.post(f'/api/artists/{p.id}/review',json={'choice':'manual','subgenre':' '}).status_code==422


def test_snapshot_and_repeated_start_preserve_baseline(client, db, monkeypatch):
    from pathlib import Path

    from sqlmodel import select

    from app.models import Job
    p=ArtistProfile(normalized_name='a',canonical_name='A',track_count=2,primary_subgenre='old')
    db.add(p);db.commit()
    monkeypatch.setattr('app.api.artists.llm_client.is_configured',lambda:True)
    monkeypatch.setattr('app.api.artists.worker.start_artist_enrich',lambda *a:None)
    response=client.post('/api/artists/compare')
    assert response.status_code==200
    snapshot=json.loads(Path(response.json()['snapshot']).read_text())
    assert snapshot[0]['primary_subgenre']=='old'
    assert client.post('/api/artists/compare').status_code==409
    job=db.get(Job,response.json()['job']['id']);job.status='done';db.add(job);db.commit()
    assert client.post('/api/artists/compare').status_code==200
    assert len(db.exec(select(ArtistReview)).all())==1


def test_accept_researched_genre_preserves_numeric_fields_and_seals(client, db):
    from sqlmodel import select

    from app.models import AuditLog
    p=ArtistProfile(normalized_name='target',canonical_name='Target',track_count=4,
                    primary_subgenre='Forest',typical_bpm_min=155,typical_bpm_max=170,
                    energy_min=7,energy_max=9,set_role_hints_json='["peak"]')
    db.add(p);db.commit()
    finding=candidate()
    finding['typical_bpm_min']=80
    finding['energy_max']=1
    db.add(ArtistReview(artist_id=p.id,baseline_json=json.dumps(p.model_dump(mode='json')),
                       candidate_json=json.dumps(finding),state='ready'));db.commit()
    response=client.post(f'/api/artists/{p.id}/review',json={'choice':'candidate'})
    assert response.status_code==200
    value=response.json()
    assert value['primary_subgenre']=='Hi-Tech' and value['research']['status']=='classified'
    assert value['typical_bpm_min']==155 and value['typical_bpm_max']==170
    assert value['energy_min']==7 and value['energy_max']==9
    assert value['set_role_hints_json']=='["peak"]' and value['canonical_name']=='Target'
    assert value['research_pending'] is False and value['needs_review'] is False
    db.expire_all()
    review=db.get(ArtistReview,p.id)
    assert review.state=='confirmed' and review.confirmed_at and review.confirmed_choice=='candidate'
    assert len(db.exec(select(AuditLog)).all())==1
    assert enrich_artist_profiles(db,force=True)['processed']==0


def test_unresolved_and_outside_list_cannot_be_auto_accepted(client, db):
    for index,status in enumerate(['unresolved','outside_list']):
        p=ArtistProfile(normalized_name=f'a{index}',canonical_name=f'A{index}',track_count=2,primary_subgenre='Keep')
        db.add(p);db.commit()
        db.add(ArtistReview(artist_id=p.id,baseline_json='{}',state='ready',candidate_json=json.dumps(candidate(status))));db.commit()
        response=client.post(f'/api/artists/{p.id}/review',json={'choice':'candidate'})
        assert response.status_code==409
        db.expire_all()
        assert db.get(ArtistProfile,p.id).primary_subgenre=='Keep'
        assert db.get(ArtistReview,p.id).confirmed_at is None
    manual=client.post(f'/api/artists/{p.id}/review',json={'choice':'manual','subgenre':'Glitch-Hop'})
    assert manual.status_code==200 and manual.json()['primary_subgenre']=='Glitch-Hop'
    assert manual.json()['research']['sources'][0]['url']=='https://example.org/artist'
    assert manual.json()['research']['manual_genre']=='Glitch-Hop'
    assert manual.json()['confidence_label']=='unknown'
    assert db.get(ArtistReview,p.id).confirmed_at is not None


def test_artist_api_eligibility_and_research_evidence(client,db):
    from datetime import UTC, datetime
    p=ArtistProfile(normalized_name='legacy',canonical_name='Legacy',track_count=3,last_enriched_at=datetime.now(UTC))
    db.add(p);db.commit()
    assert client.get('/api/artists').json()[0]['research_pending'] is True
    finding=candidate()
    db.add(ArtistReview(artist_id=p.id,baseline_json='{}',state='ready',candidate_json=json.dumps(finding)));db.commit()
    value=client.get('/api/artists').json()[0]
    assert value['research_pending'] is False
    assert value['review']['candidate']['research']['sources'][0]['url']=='https://example.org/artist'
    assert client.get('/api/artists/stats').json()['unenriched_artists']==0


def test_artist_status_restores_enrich_jobs_as_well_as_comparison(client,db):
    from app.models import Job
    job=Job(kind='artist_enrich',status='running',message='Researching')
    db.add(job);db.commit()
    value=client.get('/api/artists/comparison-status').json()
    assert value['id']==job.id and value['kind']=='artist_enrich' and value['status']=='running'


def test_confirmation_payload_survives_expiring_sessions(db):
    from app.api.artists import choose_artist_finding
    from app.schemas import ArtistReviewChoice
    p=ArtistProfile(normalized_name='expires',canonical_name='Expires',track_count=2)
    db.add(p);db.commit();artist_id=p.id
    db.add(ArtistReview(artist_id=artist_id,baseline_json='{}',candidate_json=json.dumps(candidate()),state='ready'))
    db.commit()
    db.expire_on_commit=True
    result=choose_artist_finding(artist_id,ArtistReviewChoice(choice='candidate'),db)
    assert result['id']==artist_id and result['canonical_name']=='Expires'
    assert result['primary_subgenre']=='Hi-Tech' and result['research_pending'] is False
