"""Evidence report; expected cases are validated without forcing their historical meaning."""
import json,sys,hashlib
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'backend'))
from app.services import identity_library,collection_lineage as l,library_completeness as c,recovery_prioritization as recovery
OUT=ROOT/'reconciliation/identity/lineage'
with identity_library.connect() as db:
    values=l.observations(db);links=l.relationships(db);catalog=c.index(db)
    by_id={r['id']:r for r in links}
    examples={}
    def brief(r):
        return {'id':r['id'],'source':values[r['source_id']]['name'],'destination':values[r['destination_id']]['name'],'status':r['status'],'relation':r['relation'],'evidence':r['evidence']}
    examples['exact_account1_account2']=brief(next(r for r in links if r['status']=='accepted' and r['relation']=='migrated_from' and r['evidence']['exact_ordered']))
    examples['prog_2024_merge']=[brief(r) for r in links if r['status']=='accepted' and r['relation']=='merged_from']
    assert sorted(r['evidence']['source_positions'] for r in examples['prog_2024_merge'])==[2,29]
    assert all(r['evidence']['destination_positions']==31 and r['evidence']['exact_concatenation'] for r in examples['prog_2024_merge'])
    exact_sc=[r for r in links if r['evidence']['exact_ordered'] and values[r['source_id']]['service']=='soundcloud' and values[r['destination_id']]['service']=='spotify']
    examples['repeated_exact_soundcloud_observations']=[brief(r) for r in exact_sc]
    examples['extended_freeyourmind']=[brief(r) for r in links if 'freeyourmind' in values[r['source_id']]['name'] and r['evidence'].get('structural_extension')]
    imperfect=next(r for r in links if values[r['source_id']]['name']=='Psytech' and r['evidence'].get('known_route'))
    examples['imperfect_soundcloud_candidate']=l.detail(db,imperfect['id'])
    examples['same_name_no_canonical_overlap']=brief(next(r for r in links if r['relation']=='unrelated' and values[r['source_id']]['service']==values[r['destination_id']]['service']=='spotify'))
    reductions=sorted([{'recording_id':v['recording_id'],'artist':v['artist'],'title':v['title'],'raw_positions':v['raw_collection_occurrences'],'source_collections':v['source_collection_count'],'families':v['collection_family_count']} for v in catalog.values() if v['source_collection_count']>v['collection_family_count']],key=lambda r:r['source_collections']-r['families'],reverse=True)
    examples['frequency_reduction']=reductions[:10]
    assert reductions
    counts=l.report(db)
    discrepancy=[]
    for r in links:
        if r['status']=='retired' or not r['evidence'].get('imperfect') or values[r['source_id']]['service']!='soundcloud':continue
        d=l.detail(db,r['id']);discrepancy.append({'relationship':brief(r),'counts':d['correspondence_counts'],'discrepancies':[p for p in d['correspondence'] if p['classification'] not in {'shared_recording','correct_transfer'}]})
    # All accepted parent relations must be acyclic, including merges.
    adjacency={}
    for r in links:
        if r['status']=='accepted' and r['relation']!='unrelated':adjacency.setdefault(r['source_id'],[]).append(r['destination_id'])
    def visit(node,path):
        assert node not in path,('cycle',node,path)
        for child in adjacency.get(node,[]):visit(child,path|{node})
    for node in adjacency:visit(node,set())
    frozen=json.loads((OUT/'before.json').read_text())
    preserved={t:hashlib.sha256(repr([tuple(r) for r in db.execute(f'SELECT * FROM {t} ORDER BY rowid')]).encode()).hexdigest()==h for t,h in frozen.items()}
    assert all(preserved.values())
    report={'counts':counts,'recordings_with_reduced_family_count':len(reductions),'examples':examples,
            'recovery_presets':{p:recovery.view(db,preset=p)['total'] for p in ['wanted','favourites','cross_provider','strong_interest','lost_files']},
            'frozen_tables_preserved':preserved,'accepted_lineage_acyclic':True,
            'limitations':['No multi-track exact SoundCloud→Spotify sequence exists among retrieved evidence with frozen recording identities. Six single-track exact observations remain proposed.',
            'freeyourmind 446/447 is a structural extension, not proven later chronology: the larger observation has April membership dates and the smaller September dates.',
            'Disjoint same-name canonical content does not prove historically unrelated origin. Such actual cases remain proposed; truly unrelated and known wrong-substitution ground truth are verified in explicit fixtures.',
            'Family counts are evidenced roots after accepted lineage, not proof of independent personal importance. Unresolved relationships may still inflate them.']}
    (OUT/'validation.json').write_text(json.dumps(report,indent=2,ensure_ascii=False))
    (OUT/'transfer-discrepancies.json').write_text(json.dumps(discrepancy,indent=2,ensure_ascii=False))
    print(json.dumps({'counts':counts,'reduced_recordings':len(reductions),'top_reduction':reductions[:1],'presets':report['recovery_presets'],'frozen':preserved},indent=2,ensure_ascii=False))
