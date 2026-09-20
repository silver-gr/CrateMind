import json
from datetime import UTC, datetime
from app.models import ArtistProfile, ArtistReview
from app.services.artist_intelligence import enrich_artist_profiles


def test_comparison_keeps_active_profile_and_confirmation_blocks_enrichment(db, monkeypatch):
    p = ArtistProfile(normalized_name='crone', canonical_name='Crone', track_count=10, primary_subgenre='Forest', last_enriched_at=datetime.now(UTC))
    db.add(p); db.commit()
    review = ArtistReview(artist_id=p.id, baseline_json=json.dumps(p.model_dump(mode='json')))
    db.add(review); db.commit()
    monkeypatch.setattr('app.services.artist_intelligence.llm_client.chat_json', lambda *a: {'artists':[{'id':p.id,'primary_subgenre':'Psycore','notes':'uncertain identity'}]})
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
    from app.models import Job
    from sqlmodel import select
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
