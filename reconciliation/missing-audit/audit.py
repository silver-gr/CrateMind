
# Archived experiment: fail closed before any old path or audio side effect.
import sys as _dataset_sys
from pathlib import Path as _DatasetPath
_dataset_sys.path.insert(0, str(next(parent for parent in _DatasetPath(__file__).resolve().parents if (parent / "backend/app").is_dir()) / "backend"))
from app.services.writer_context import reject_legacy_script
reject_legacy_script(_DatasetPath(__file__))
import sqlite3,json,unicodedata,re,os,collections
from pathlib import Path
OUT=Path(__file__).parent
DB=Path('backend/data/cratemind.sqlite')
def norm(v):return ' '.join(''.join(c if c.isalnum() else ' ' for c in unicodedata.normalize('NFKC',v or '').casefold()).split())
def key(t):return (norm(t['artist']),norm(t['title']))
if __name__=='__main__':
 c=sqlite3.connect(DB.as_uri()+'?mode=ro',uri=True) if DB.is_absolute() else sqlite3.connect('file:'+str(DB)+'?mode=ro',uri=True);c.row_factory=sqlite3.Row
 tracks={r['id']:dict(r) for r in c.execute('select * from tracks')}
 for t in tracks.values():
  p=Path(t['absolute_path']);t['exists']=p.is_file()
  if t['exists']:
   s=p.stat();t['actual_mtime']=s.st_mtime;t['birthtime']=getattr(s,'st_birthtime',None);t['actual_size']=s.st_size
 groups=[]
 for g in c.execute("select * from duplicate_groups where status='needs_review'"):
  ms=[tracks[r[0]] for r in c.execute('select track_id from duplicate_group_tracks where group_id=?',(g['id'],))]
  groups.append({**dict(g),'tracks':ms,'live':sum(t['exists'] for t in ms),'missing':sum(not t['exists'] for t in ms),'same_metadata':len({key(t) for t in ms})==1})
 live=collections.defaultdict(list)
 for t in tracks.values():
  if t['exists'] and all(key(t)):live[key(t)].append(t)
 matches=[];unmatched=[]
 for t in tracks.values():
  if t['exists']:continue
  candidates=live.get(key(t),[]) if all(key(t)) else []
  (matches if candidates else unmatched).append({'missing':t,'candidates':candidates})
 data={'groups':groups,'missing_matches':matches,'unmatched':unmatched,'counts':{'total':len(tracks),'missing':sum(not t['exists'] for t in tracks.values()),'flagged_missing':sum(t['missing'] for t in tracks.values())}}
 (OUT/'audit.json').write_text(json.dumps(data,ensure_ascii=False,indent=2))
 print('COUNTS',data['counts']);print('GROUPS',dict(collections.Counter((g['live']>0,g['missing']>0,g['same_metadata']) for g in groups)));print('missing matched',len(matches),'unmatched',len(unmatched))
 for g in groups:
  if g['missing'] or not g['same_metadata']:print('GROUP',g['id'],g['reason'],[(t['id'],t['artist'],t['title'],t['exists']) for t in g['tracks']])
 print('UNMATCHED',[(r['missing']['id'],r['missing']['artist'],r['missing']['title']) for r in unmatched])
