
# Archived experiment: fail closed before any old path or audio side effect.
import sys as _dataset_sys
from pathlib import Path as _DatasetPath
_dataset_sys.path.insert(0, str(next(parent for parent in _DatasetPath(__file__).resolve().parents if (parent / "backend/app").is_dir()) / "backend"))
from app.services.writer_context import reject_legacy_script
reject_legacy_script(_DatasetPath(__file__))
import json,re,sqlite3,collections
from pathlib import Path
from audit import norm,key,OUT
A=json.loads((OUT/'audit.json').read_text());db=sqlite3.connect('file:backend/data/cratemind.sqlite?mode=ro',uri=True);db.row_factory=sqlite3.Row
tracks={r['id']:dict(r) for r in db.execute('select * from tracks')}
# Explicit reviewed exceptions: matching recordings with changed title/artist tags and identical durations.
manual={1010:1871,1271:4183,2471:1869,3271:3270,1004:1089,2743:321,2745:3310,3404:4047,4016:2499,3684:3702,3686:3706,3689:3709,3690:3703}
mapping={}
for r in A['missing_matches']:
 cs=r['candidates'];keep=max(cs,key=lambda t:(t.get('actual_mtime',0),t['id']))
 mapping[r['missing']['id']]={'keep':keep['id'],'basis':'same normalized artist and title'}
placeholder={'unknown artist','downloaded by mediahuman',''}
for r in A['unmatched']:
 t=r['missing'];tid=t['id']
 if tid in manual:
  k=tracks[manual[tid]];assert abs((t['duration'] or 0)-(k['duration'] or 0))<.1
  mapping[tid]={'keep':k['id'],'basis':'reviewed tag/tempo/artist-credit variation; identical duration'};continue
 cs=[k for k in tracks.values() if Path(k['absolute_path']).is_file() and norm(k['title'])==norm(t['title']) and norm(k['file_name'])==norm(t['file_name']) and norm(k['artist']) in placeholder and norm(t['artist']) in placeholder and abs((k['duration'] or 0)-(t['duration'] or 0))<1]
 if cs:mapping[tid]={'keep':cs[0]['id'],'basis':'identical filename/title/duration; placeholder artist changed'}
# Missing members of /duplicates are processed first.
group_missing={t['id'] for g in A['groups'] for t in g['tracks'] if not t['exists']}
merges=[{'remove':i,**v} for i,v in sorted(mapping.items(),key=lambda kv:(kv[0] not in group_missing,kv[0]))]
# Existing-file deletion suggestions: normalize tempo/marketing annotations, never remove remix identity.
def simple_title(t):
 s=t['title'] or '';s=re.sub(r'[\[(]\s*\d{2,3}\s*(?:bpm)?\s*[\])]',' ',s,flags=re.I)
 s=re.sub(r'\((?:original mix|download link|VA The New Era is coming|V.A. Free Ranged Radicals|Xerks Music|LostinSound.org Spring 2015 V/A 004)\)',' ',s,flags=re.I)
 return norm(s)
commands=[];review=[];keepers=set();removes=set()
for g in A['groups']:
 ms=[t for t in g['tracks'] if t['exists']]
 if len(ms)<2:continue
 same=g['same_metadata'] or len({(norm(t['artist']),simple_title(t)) for t in ms})==1
 if not same:review.append(g);continue
 keep=max(ms,key=lambda t:(t['actual_mtime'],t['birthtime'] or 0,t['id']));keepers.add(keep['id'])
 for t in ms:
  if t['id']==keep['id']:continue
  removes.add(t['id']);commands.append({'group_id':g['id'],'remove_id':t['id'],'keep_id':keep['id'],'remove_path':t['absolute_path'],'keep_path':keep['absolute_path'],'remove_size':t['actual_size'],'keep_size':keep['actual_size'],'remove_mtime':t['actual_mtime'],'keep_mtime':keep['actual_mtime'],'artist':t['artist'],'title':t['title'],'basis':'same artist/title (ignoring tempo/promo labels); keep newer mtime, then birthtime'})
assert not keepers&removes
# Redirect missing copies to the copy designated to survive future optional deletion.
future={r['remove_id']:r['keep_id'] for r in commands}
for m in merges:
 if m['keep'] in future:m['keep']=future[m['keep']]
payload={'merges':merges,'remaining_missing':[r['missing'] for r in A['unmatched'] if r['missing']['id'] not in mapping],'delete_existing_files':commands,'duplicate_groups_for_review':review}
(OUT/'plan.json').write_text(json.dumps(payload,indent=2,ensure_ascii=False))
print('MERGES',len(merges),'first duplicate IDs',[m['remove'] for m in merges[:6]],'remaining missing',[(t['id'],t['artist'],t['title']) for t in payload['remaining_missing']]);print('file deletion suggestions',len(commands),'unresolved groups',len(review))
for tab in ['track_dj_profile','track_tags','set_tracks','track_pair_notes','play_events','track_soundcloud_matches']:
 ids=list(mapping);col='from_track_id' if tab=='track_pair_notes' else 'track_id'
 print(tab,db.execute(f'select count(*) from {tab} where {col} in ({",".join("?" for _ in ids)})',ids).fetchone()[0])
