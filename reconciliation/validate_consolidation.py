"""Read-only evidence and accounting for the applied collection presentation batch."""
import json,sqlite3,hashlib,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'backend'));sys.path.insert(0,str(ROOT/'reconciliation'))
from app.services import identity_library,collection_consolidation as c,collection_lineage as l,library_collections as library,library_completeness as completeness
from consolidate_collections import verify
OUT=ROOT/'reconciliation/identity/consolidation'
with identity_library.connect() as db:
 manifest=json.loads((OUT/'manifest.json').read_text());groups=c.review_groups(db);projection=c.projection(db)
 assert len(c.active_rows(db))==manifest['after']
 assert len(c.active_rows(db,all_sources=True))==manifest['original_observations_retained']
 assert len(c.automatic_plan(db)['groups'])==0
 frozen=verify(db)
 relationships=l.relationships(db);values=l.observations(db)
 difference_occurrences=set();difference_recordings=set();active_review_ids=set();examples={}
 for g in groups:
  if g['state']!='needs_review':continue
  active_review_ids.update(g['ids']);p=c.preview(db,g['ids'],g['selected'])
  for comparison in p['comparisons']:
   for gap in comparison['positions']:
    for side,cid in [('source',comparison['source_id']),('destination',g['selected'])]:
     for pos in gap[side]:
      difference_recordings.add(pos['recording_id'])
      if cid in projection['wrappers']:
       origins=db.execute('''SELECT source_id,source_position FROM collection_position_dispositions
          WHERE representative_id=? AND representative_position=? AND disposition='represented' ''',(cid,pos['position'])).fetchall()
       difference_occurrences.update(tuple(r) for r in origins if r[0] not in projection['wrappers'])
      else:difference_occurrences.add((cid,pos['position']))
  names=[s['name'].casefold() for s in g['sources']]
  if any('freeyourmind' in name for name in names):examples['freeyourmind']=p
  if 'psytech' in names:examples['psytech']=p
 # Original correspondence remains proposed; presentation never promotes it.
 psy=next(r for r in relationships if values[r['source_id']]['name']=='Psytech' and r['evidence'].get('known_route'))
 assert psy['status']=='proposed';examples['psytech_original_evidence']=l.detail(db,psy['id'])
 prog=[r for r in relationships if r['relation']=='merged_from' and r['status']=='accepted']
 parents=prog[0]['evidence']['merge_sources'];dest=prog[0]['destination_id'];targets=projection['mapping'][dest]
 assert len(targets)==2 and len(values[parents[0]]['sequence'])==29 and len(values[parents[1]]['sequence'])==2
 assert values[parents[0]]['sequence']+values[parents[1]]['sequence']==values[dest]['sequence']
 for parent in parents:
  rep=next(iter(projection['mapping'][parent]));assert values[rep]['sequence']==values[parent]['sequence']
 examples['prog']={'parents':parents,'merged_source':dest,'representatives':sorted(targets),'parent_counts':[29,2],'merged_positions':31}
 # An accepted account migration has exactly one everyday representative and intact repeated positions.
 for r in relationships:
  if r['relation']=='migrated_from' and r['status']=='accepted' and r['evidence'].get('exact_ordered'):
   a,b=r['source_id'],r['destination_id'];assert projection['mapping'][a]==projection['mapping'][b]
   rep=next(iter(projection['mapping'][a]));assert values[a]['sequence']==values[b]['sequence']==values[rep]['sequence']
   examples['exact_migration']={'source':a,'destination':b,'representative':rep,'positions':len(values[a]['sequence'])};break
 # Every original occurrence under an active automatic decision maps to the same frozen recording.
 mismatches=[]
 for row in db.execute('''SELECT d.*,s.recording_id AS source_recording,t.recording_id AS target_recording FROM collection_position_dispositions d
 JOIN collection_consolidations decision ON decision.id=d.decision_id
 JOIN memberships sm ON sm.collection_id=d.source_id AND sm.position=d.source_position JOIN entities s ON s.id=sm.entity_id
 LEFT JOIN memberships tm ON tm.collection_id=d.representative_id AND tm.position=d.representative_position LEFT JOIN entities t ON t.id=tm.entity_id
 WHERE decision.status='active' AND decision.mode='automatic' '''):
  if row['disposition']!='represented' or row['source_recording']!=row['target_recording']:mismatches.append(dict(row))
 assert not mismatches
 with sqlite3.connect(f'file:{ROOT / "backend/data/cratemind.sqlite"}?mode=ro',uri=True) as primary:
  primary_hash=hashlib.sha256(repr(primary.execute('SELECT * FROM tracks ORDER BY rowid').fetchall()).encode()).hexdigest()
 assert primary_hash==json.loads((OUT/'primary-before.json').read_text())['tracks']
 result={'active':len(c.active_rows(db)),'original_collections':len(c.active_rows(db,all_sources=True)),
 'unresolved_groups':len(groups),'active_entries_in_review_groups':len(active_review_ids),
 'unique_recordings_awaiting_difference_review':len(difference_recordings),'original_source_occurrences_awaiting_difference_review':len(difference_occurrences),
 'difference_count_basis':'Union of non-shared ordered comparison positions across unresolved groups relative to displayed proposed representative; native positions expanded to original source origins; repeated source positions counted separately. Not an identity mismatch or wrong-substitution count.',
 'examples':examples,'frozen_preservation':frozen,'primary_tracks_unchanged':True,'automatic_occurrence_mapping_mismatches':0,'remaining_automatic_groups':0,
 'fixtures_separate':'test_collection_consolidation.py and browser-isolated.json cover explicit review/restore/undo, reordered/subset/null/concurrent-edit branches. No human choices exercised in production.'}
 (OUT/'validation.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
 manifest.update({k:result[k] for k in ['unique_recordings_awaiting_difference_review','original_source_occurrences_awaiting_difference_review','active_entries_in_review_groups','difference_count_basis']})
 (OUT/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
 print(json.dumps({k:v for k,v in result.items() if k!='examples'},indent=2))
