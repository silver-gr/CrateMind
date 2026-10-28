"""One-time authorized catalog cleanup. Never writes source audio."""

# Archived experiment: fail closed before any old path or audio side effect.
import sys as _dataset_sys
from pathlib import Path as _DatasetPath
_dataset_sys.path.insert(0, str(next(parent for parent in _DatasetPath(__file__).resolve().parents if (parent / "backend/app").is_dir()) / "backend"))
from app.services.writer_context import reject_legacy_script
reject_legacy_script(_DatasetPath(__file__))
import sqlite3,json,sys,shutil
from pathlib import Path
from datetime import datetime,timezone
OUT=Path(__file__).resolve().parent;ROOT=OUT.parents[1]
PLAN=json.loads((OUT/'plan.json').read_text())
def merge(catalog,identity):
 c=sqlite3.connect(catalog,timeout=60);c.row_factory=sqlite3.Row;c.execute('PRAGMA foreign_keys=ON');c.execute('ATTACH DATABASE ? AS identity',(str(identity),));c.execute('BEGIN IMMEDIATE')
 before=list(c.execute('PRAGMA foreign_key_check'));identity_before=list(c.execute('PRAGMA identity.foreign_key_check'));assert not before and not identity_before
 touched=set();counts={};now=datetime.now(timezone.utc).isoformat()
 try:
  for m in PLAN['merges']:
   old,new=m['remove'],m['keep'];src=c.execute('select * from tracks where id=?',(old,)).fetchone();dst=c.execute('select * from tracks where id=?',(new,)).fetchone()
   assert src and dst and not Path(src['absolute_path']).exists() and Path(dst['absolute_path']).is_file(),m
   touched.add(new)
   # Preserve user and provider associations. Do not silently discard conflicting profile/match rows.
   for tab in ['track_dj_profile','track_tags','fingerprints','duplicate_group_tracks','track_soundcloud_matches','soundcloud_match_candidates']:
    rows=list(c.execute(f'select * from {tab} where track_id=?',(old,)))
    info=list(c.execute(f'pragma table_info({tab})'));pk=[r['name'] for r in info if r['pk']]
    for r in rows:
     v=dict(r);v['track_id']=new;where=' AND '.join(f'"{k}"=?' for k in pk)
     existing=c.execute(f'select * from {tab} where {where}',[v[k] for k in pk]).fetchone()
     if existing is None:
      c.execute(f'insert into {tab} ({",".join(v)}) values ({",".join("?" for _ in v)})',list(v.values()));counts[tab]=counts.get(tab,0)+1
     elif tab in ('track_dj_profile','track_soundcloud_matches'):
      differences={k for k in v if existing[k]!=v[k]}
      if tab=='track_soundcloud_matches' and differences <= {'matched_at','confirmed_at','confidence','method','reasons_json'}:
       if differences:
        c.execute('insert into audit_log(action,entity_type,entity_id,before_json,after_json,created_at) values (?,?,?,?,?,?)',('merge_duplicate_match_metadata','track',old,json.dumps(dict(r),ensure_ascii=False),json.dumps(dict(existing),ensure_ascii=False),now))
      else:
       assert not differences,f'Conflicting saved information {tab} {old}->{new}'
    c.execute(f'delete from {tab} where track_id=?',(old,))
   for tab,col in [('set_tracks','track_id'),('play_events','track_id'),('track_pair_notes','from_track_id'),('track_pair_notes','to_track_id')]:
    n=c.execute(f'update {tab} set {col}=? where {col}=?',(new,old)).rowcount;counts[tab]=counts.get(tab,0)+n
   c.execute('update tracks set play_count=play_count+?,last_played_at=CASE WHEN last_played_at IS NULL OR last_played_at<? THEN ? ELSE last_played_at END,rating=COALESCE(rating,?) where id=?',(src['play_count'],src['last_played_at'],src['last_played_at'],src['rating'],new))
   # Retain historical source entity IDs and collection membership, redirect their playable asset.
   for e in list(c.execute('select * from identity.entities where local_track_id=?',(old,))):
    md=json.loads(e['metadata_json']);norm=json.loads(e['normalized_json']);md['replaced_missing_catalog_id']=old;md['previous_absolute_path']=md.get('absolute_path');md.update({k:dst[k] for k in ('id','absolute_path','normalized_path','file_name','file_size','missing')});md['missing']=0;norm['local_track_id']=new
    c.execute('update identity.entities set local_track_id=?,metadata_json=?,normalized_json=? where id=?',(new,json.dumps(md,ensure_ascii=False),json.dumps(norm,ensure_ascii=False),e['id']))
    c.execute('insert into identity.canonical_events(recording_id,action,before_json,after_json,created_at) values (?,?,?,?,?)',(e['recording_id'],'missing_catalog_asset_redirect',json.dumps({'entity_id':e['id'],'track_id':old}),json.dumps({'track_id':new,'basis':m['basis']}),now))
   c.execute('delete from track_search where rowid=?',(old,));c.execute('delete from tracks where id=?',(old,))
   c.execute('insert into audit_log(action,entity_type,entity_id,before_json,after_json,created_at) values (?,?,?,?,?,?)',('merge_missing_duplicate','track',old,json.dumps(dict(src),ensure_ascii=False),json.dumps(m),now))
  # Completed missing/live review groups now contain only the kept member.
  resolved=[]
  for g in c.execute("select id from duplicate_groups where status='needs_review'").fetchall():
   ids=[r[0] for r in c.execute('select track_id from duplicate_group_tracks where group_id=?',(g[0],))]
   if len(ids)==1 and ids[0] in touched:
    c.execute("update duplicate_groups set status='resolved' where id=?",(g[0],));c.execute("update duplicate_group_tracks set role='master' where group_id=?",(g[0],));resolved.append(g[0])
  # Refresh only affected FTS rows, within the same transaction.
  for tid in touched:
   row=c.execute("select t.artist,t.title,t.album,t.label,t.genre,t.comment,p.notes,(select group_concat(g.name,' ') from track_tags tt join tags g on g.id=tt.tag_id where tt.track_id=t.id) from tracks t left join track_dj_profile p on p.track_id=t.id where t.id=?",(tid,)).fetchone()
   c.execute('delete from track_search where rowid=?',(tid,));c.execute('insert into track_search(rowid,artist,title,album,label,genre,comment,notes,tags) values (?,?,?,?,?,?,?,?,?)',[tid,*[v or '' for v in row]])
  assert not list(c.execute('PRAGMA foreign_key_check'));assert not list(c.execute('PRAGMA identity.foreign_key_check'))
  assert not c.execute('select count(*) from identity.entities e where e.local_track_id is not null and not exists(select 1 from main.tracks t where t.id=e.local_track_id)').fetchone()[0]
  result={'removed':len(PLAN['merges']),'remaining_total':c.execute('select count(*) from tracks').fetchone()[0],'remaining_missing':c.execute('select count(*) from tracks where missing=1').fetchone()[0],'resolved_groups':resolved,'transferred_rows':counts}
  c.commit();return result
 except: c.rollback();raise
 finally:c.close()
def snapshot(source,target):
 s=sqlite3.connect(source.resolve().as_uri()+'?mode=ro',uri=True);d=sqlite3.connect(target);s.backup(d);d.close();s.close()
if __name__=='__main__':
 mode=sys.argv[1];assert mode in ('--rehearse','--apply')
 stamp=datetime.now().strftime('%Y%m%d-%H%M%S');folder=OUT/('rehearsal-'+stamp if mode=='--rehearse' else 'backup-'+stamp);folder.mkdir(exist_ok=False)
 for name in ('cratemind','identity'):snapshot(ROOT/f'backend/data/{name}.sqlite',folder/f'{name}.sqlite')
 target=folder if mode=='--rehearse' else ROOT/'backend/data'
 result=merge(target/'cratemind.sqlite',target/'identity.sqlite');result['snapshot']=str(folder)
 (OUT/('rehearsal-result.json' if mode=='--rehearse' else 'applied-result.json')).write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
