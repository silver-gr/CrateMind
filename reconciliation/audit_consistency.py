"""Read-only integration audit. Does not run the scorer or promotion policy."""
import ast,hashlib,json,sqlite3,sys
from collections import defaultdict,Counter
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'backend'))
from app.services.writer_context import catalog_path
from app.services import canonical_library as canonical,identity_library,provider_resolution as providers,canonical_queue
from app.services.identity_matching import text_key
OUT=ROOT/'reconciliation/identity/stabilization'

def digest(db,query):
    h=hashlib.sha256()
    for row in db.execute(query):h.update(json.dumps(tuple(row),ensure_ascii=False,sort_keys=True).encode())
    return h.hexdigest()

def main():
    frozen=json.loads((OUT/'frozen.json').read_text())
    for name,wanted in frozen.items():
        code=(ROOT/name).read_text()
        if 'canonical_library' in name:
            node=next(n for n in ast.parse(code).body if isinstance(n,ast.FunctionDef) and n.name=='promote');code=ast.get_source_segment(code,node)
        assert hashlib.sha256(code.encode()).hexdigest()==wanted,name
    before=sqlite3.connect((OUT/'before.sqlite').resolve().as_uri()+'?mode=ro',uri=True)
    main_db=sqlite3.connect((catalog_path()).resolve().as_uri()+'?mode=ro',uri=True)
    legacy=dict(main_db.execute('SELECT track_id,soundcloud_track_id FROM track_soundcloud_matches'))
    old_stats={r[0]:(r[1],r[2]) for r in main_db.execute('SELECT soundcloud_track_id,playback_count,likes_count FROM soundcloud_tracks')}
    report={'frozen_scorer_and_promotion':True,'unchanged':{},'before':Counter(),'after':Counter()}
    with identity_library.connect() as db:
        for name,query in {
            'identity_acceptances':'SELECT * FROM identity_acceptances ORDER BY left_id,right_id',
            'entity_observations_and_recording_links':'SELECT * FROM entities ORDER BY id',
            'candidate_scores_and_evidence':'SELECT * FROM candidates ORDER BY left_id,right_id',
            'imported_collections':"SELECT * FROM collections WHERE kind!='native' ORDER BY id",
            'imported_memberships':"SELECT m.* FROM memberships m JOIN collections c ON c.id=m.collection_id WHERE c.kind!='native' ORDER BY m.collection_id,m.position",
        }.items():report['unchanged'][name]=digest(db,query)==digest(before,query)
        assert all(report['unchanged'].values()),report
        all_local=[dict(r) for r in db.execute('SELECT local_track_id AS id,title,artist FROM entities WHERE service="local"')]
        displayed={r['id']:r for r in canonical.overlay(all_local)}
        multi=[r[0] for r in db.execute('SELECT recording_id FROM entities GROUP BY recording_id HAVING count(DISTINCT service)>1')]
        report['multi_source_recordings_checked']=len(multi)
        # The same full ordered credit rows feed search and artist-role filters.
        checked_credits=0
        for rid in multi:
            item=canonical.detail(db,rid)
            sc=[p for p in item['providers'] if p['service']=='soundcloud']
            for a in item['local_assets']:
                lid=a['local_track_id'];row=displayed[lid]
                if sc:
                    expected=sc[0];old_id=legacy.get(lid)
                    report['before']['provider_card_missing_or_different_identity']+=old_id!=expected['soundcloud_snapshot']['soundcloud_track_id']
                    old=old_stats.get(old_id,(None,None))
                    expected_counts=(expected['popularity'].get('playback_count'),expected['popularity'].get('likes_count'))
                    report['before']['legacy_card_counters_missing_or_stale']+=old!=expected_counts
                    card=providers.soundcloud_card(item,lid)
                    report['after']['provider_summary_card_mismatch']+=card['counter_source_id']!=expected['id'] or card['track'].get('playback_count')!=expected['popularity'].get('playback_count')
                    report['after']['library_counter_mismatch']+=(row['soundcloud_playback_count'],row['soundcloud_likes_count'])!=expected_counts or row['soundcloud_counter_source_id']!=expected['id']
                    report['after']['missing_accepted_path']+=not bool(card['accepted_path'])
                report['after']['library_review_metadata_mismatch']+=(row['title'],row['artist'])!=(item['title'],item['artist'])
            search_text=text_key(' '.join([item['title'] or '',item['artist'] or '',*(c['name'] for c in item['credits'])]))
            for credit in item['credits']:
                checked_credits+=1
                report['after']['credited_artist_absent_from_search_document']+=text_key(credit['name']) not in search_text
            for provider in sc:
                original=db.execute('SELECT metadata_json FROM entities WHERE id=? AND recording_id=?',(provider['counter_source_id'],rid)).fetchone()
                report['after']['counters_attached_to_wrong_identity']+=original is None or json.loads(original[0]).get('popularity',{})!=provider['popularity']
        report['credited_artist_search_documents_checked']=checked_credits
        report['collection_positions_checked']=db.execute('SELECT count(*) FROM memberships').fetchone()[0]
        report['after']['collection_recording_reference_missing']=db.execute('SELECT count(*) FROM memberships m LEFT JOIN entities e ON e.id=m.entity_id LEFT JOIN canonical_recordings c ON c.recording_id=e.recording_id WHERE c.recording_id IS NULL').fetchone()[0]
        report['review_counts']=canonical_queue.list_items(db)['counts']
        report['integrity']=db.execute('PRAGMA integrity_check').fetchone()[0]
        report['foreign_key_errors']=len(db.execute('PRAGMA foreign_key_check').fetchall())
    assert not any(report['after'].values()),report['after']
    (OUT/'audit.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
    print(json.dumps(report,ensure_ascii=False,indent=2))
if __name__=='__main__':main()
