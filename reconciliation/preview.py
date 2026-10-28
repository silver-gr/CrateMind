"""Offline, repeatable integration preview. Never imports app startup or writes sources."""
from __future__ import annotations
import argparse, collections, csv, hashlib, html, importlib.util, io, json, os, re, sqlite3, tarfile, unicodedata, zipfile
from pathlib import Path
from datetime import datetime, timezone
from urllib.parse import urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('source_audit', ROOT / 'verification/audit_inputs.py')
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)
LIKES = {'account1':'liked.csv','account2':'liked.csv','account3':'Liked_Songs.csv'}
VERSIONS = re.compile(r'\b(remix|rmx|edit|extended|live|remaster(?:ed)?|instrumental|dub|bootleg|radio|original)\b', re.I)
URL = re.compile(r'https?://[^\s<>"\']+')

def dumps(v): return json.dumps(v, ensure_ascii=False, sort_keys=True, separators=(',',':'))
def sha(p): return AUDIT.sha(Path(p))
def key(*parts): return hashlib.sha256(dumps(parts).encode()).hexdigest()
def write_json(p,v): p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
def write_rows(p,rows): p.write_text(''.join(dumps(r)+'\n' for r in rows))
def read_rows(p): return [json.loads(x) for x in p.read_text(encoding='utf-8').split('\n') if x]
def norm(s): return ' '.join(re.findall(r'\w+',unicodedata.normalize('NFKC',s or '').casefold()))
def versions(s): return sorted(set('remix' if x.lower()=='rmx' else x.lower() for x in VERSIONS.findall(s or '')))
def number(v):
 try: return float(v) if v not in ('',None) else None
 except (TypeError,ValueError): return None

def clean(value):
 """Preserve metadata while removing credentials, including URLs embedded in text."""
 if isinstance(value,dict):
  return {str(k):('[REDACTED]' if re.search(r'token|authorization|cookie|password|secret|client_id|jwt',str(k),re.I) else clean(v)) for k,v in value.items()}
 if isinstance(value,list): return [clean(v) for v in value]
 if isinstance(value,str):
  if value.lstrip().startswith(('{','[')):
   try: return dumps(clean(json.loads(value)))
   except (ValueError, TypeError): pass
  def redact(m):
   try:
    p=urlsplit(m[0]); path=re.sub(r'/s-[A-Za-z0-9]+(?=/|$)','/[PRIVATE]',p.path)
    return urlunsplit((p.scheme,p.hostname or '',path,'',''))
   except ValueError: return '[INVALID_URL]'
  return URL.sub(redact,value)
 return value

def ro_db(path):
 c=sqlite3.connect(Path(path).resolve().as_uri()+'?mode=ro',uri=True);c.row_factory=sqlite3.Row;c.execute('PRAGMA query_only=ON');return c

def db_digest(c):
 out={}
 for (name,) in c.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name"):
  rows=[dumps([{'sqlite_blob_hex':v.hex()} if isinstance(v,bytes) else v for v in r]) for r in c.execute('SELECT * FROM "'+name.replace('"','""')+'"')]
  out[name]={'rows':len(rows),'sha256':hashlib.sha256('\n'.join(sorted(rows)).encode()).hexdigest()}
 return out

def snapshot(live,dest):
 if dest.exists(): raise FileExistsError('Snapshot already exists; use --snapshot to reuse explicitly')
 source=ro_db(live)
 with sqlite3.connect(dest) as target: source.backup(target)
 source.close();dest.chmod(0o400)

FIELDS={'Track URI':'uri','URI κομματιού':'uri','Track Name':'title','Όνομα κομματιού':'title',
 'Artist Name(s)':'artists','Όνομα/τα καλλιτέχνη':'artists','Artist URI(s)':'artist_uris','URI καλλιτέχνη/ων':'artist_uris',
 'Album Name':'album','Όνομα άλμπουμ':'album','Release Date':'release_date','Ημερομηνία κυκλοφορίας άλμπουμ':'release_date',
 'Duration (ms)':'duration_ms','Διάρκεια κομματιού (ms)':'duration_ms','Added At':'added_at','Προστέθηκε στις':'added_at',
 'Added By':'added_by','Προστέθηκε από':'added_by','ISRC':'isrc'}

def parse_spotify(path,account):
 digest=sha(path); collections_out=[];members=[];items={};observations=[]
 with zipfile.ZipFile(path) as z:
  bad=z.testzip()
  if bad: raise ValueError('ZIP CRC failure: '+bad)
  likes_found=0
  for index,info in enumerate(z.infolist()):
   if info.is_dir() or not info.filename.lower().endswith('.csv'): continue
   body=z.read(info);reader=csv.DictReader(io.StringIO(body.decode('utf-8-sig'),newline=''))
   headers=reader.fieldnames or []
   if not {'uri','title'} <= {FIELDS.get(h,h) for h in headers}: raise ValueError('Unsupported Spotify schema')
   cid=key('spotify',account,digest,index,info.filename);is_likes=info.filename==LIKES[account];likes_found+=is_likes
   count=0
   for pos,raw in enumerate(reader):
    r={FIELDS.get(k,k):v for k,v in raw.items()};uri=(r.get('uri') or '').strip()
    kind=uri.split(':')[1] if uri.startswith('spotify:') and len(uri.split(':'))>=3 else 'unknown'
    sid=uri if uri else 'unknown:'+key(cid,pos)
    item={'source_item_id':sid,'service':'spotify','remote_id':uri or None,'type':kind,'title':r.get('title'),
      'performer':r.get('artists'),'artist_uris':r.get('artist_uris'),'uploader':None,'duration_ms':number(r.get('duration_ms')),
      'isrc':r.get('isrc'),'release_date':r.get('release_date'),'version_tokens':versions(r.get('title')),
      'content_kind':'long_form' if (number(r.get('duration_ms')) or 0)>=1200000 or re.search(r'\bdj\s*(mix|set)\b',r.get('title') or '',re.I) else kind,
      'availability':'unknown','service_url':'https://open.spotify.com/track/'+uri.split(':')[-1] if kind=='track' else None}
    items.setdefault(sid,item)
    mid=key(cid,pos)
    observations.append({'observation_id':mid,'source_item_id':sid,'archive_sha256':digest,'member_index':index,
      'member':info.filename,'position':pos,'metadata':item,'raw_metadata':clean(raw),'observed_at':None,'observation_time_basis':'export time not exposed'})
    members.append({'membership_id':mid,'collection_id':cid,'position':pos,'source_item_id':sid,'added_at':r.get('added_at'),
      'added_by':r.get('added_by'),'account':account,'is_likes':is_likes});count+=1
   collections_out.append({'collection_id':cid,'service':'spotify','account':account,'source_remote_id':None,
     'name':info.filename,'name_basis':'archive member label, not verified remote title','archive_sha256':digest,'member_index':index,
     'member_sha256':hashlib.sha256(body).hexdigest(),'headers':headers,'relationships':['liked_tracks' if is_likes else 'saved_playlist_ownership_unknown'],
     'is_likes':is_likes,'track_count':count,'observed_at':None})
  if likes_found!=1: raise ValueError('Expected one explicitly configured Likes member for '+account)
 return collections_out,members,items,observations

def candidate_evidence(left,right):
 """Bounded blocking by exact normalized title/ISRC; never auto-accept."""
 lt=norm(left.get('title'));rt=norm(right.get('title'))
 # SC titles often prefix the performer; preserve the original title in every record.
 short=norm((right.get('title') or '').split(' - ',1)[-1])
 title_equal=bool(lt and lt in (rt,short))
 li=AUDIT.isrc(left.get('isrc'));ri=AUDIT.isrc(right.get('isrc'));isrc_equal=bool(li and li==ri)
 if not title_equal and not isrc_equal: return None
 lv=versions(left.get('title'));rv=versions(right.get('title'))
 dl=number(left.get('duration_ms'));dr=number(right.get('duration_ms'));delta=abs(dl-dr)/1000 if dl is not None and dr is not None else None
 lp=norm(left.get('performer'));rp=norm(right.get('performer'))
 performer_equal=bool(lp and rp and lp==rp)
 flags=[]
 if lv!=rv: flags.append('version_tokens_differ')
 if delta is None: flags.append('duration_unknown')
 elif delta>3: flags.append('duration_differs')
 if not performer_equal: flags.append('performer_not_corroborrated')
 if left.get('type')!='track' or right.get('type')!='track' or left.get('content_kind')=='long_form' or right.get('content_kind')=='long_form': flags.append('non_song_or_long_form_review')
 score=(35*title_equal+30*isrc_equal+20*performer_equal+15*(delta is not None and delta<=3))
 return {'title_equal':title_equal,'isrc_equal':isrc_equal,'performer_equal':performer_equal,'duration_delta_seconds':delta,
   'left_version_tokens':lv,'right_version_tokens':rv,'flags':flags,'heuristic_score':score,'score_is_probability':False}

def reconcile(items,local,accepted,history,extra):
 candidates=[];blocked={(r['track_id'],str(r['soundcloud_track_id'])):r['status'] for r in history}
 by_title=collections.defaultdict(list);by_isrc=collections.defaultdict(list)
 targets=[v for v in items.values() if v['service']=='soundcloud']
 targets += [{'source_item_id':'local:'+str(t['id']),'service':'local','title':t['title'],'performer':t['artist'],
   'duration_ms':t['duration']*1000 if t['duration'] is not None else None,'type':'track' if (t['duration'] or 0)<1200 else 'long_form'} for t in local]
 for t in targets:
  for title in {norm(t.get('title')),norm((t.get('title') or '').split(' - ',1)[-1])}:
   if title: by_title[title].append(t)
  if AUDIT.isrc(t.get('isrc')): by_isrc[AUDIT.isrc(t['isrc'])].append(t)
 sources=[x for x in items.values() if x['service']=='spotify' and x['type']=='track']
 sources += [t for t in targets if t['service']=='local']
 for s in sources:
  pool={t['source_item_id']:t for t in by_title.get(norm(s.get('title')),[])+by_isrc.get(AUDIT.isrc(s.get('isrc')),[])}
  for tid,t in sorted(pool.items()):
   if s['source_item_id']==tid or s['service']==t['service']:continue
   if s['service']=='local' and (int(s['source_item_id'].split(':')[1]),str(t.get('remote_id'))) in blocked:continue
   evidence=candidate_evidence(s,t)
   if evidence:
    candidates.append({'candidate_id':key(s['source_item_id'],tid),'left':s['source_item_id'],'right':tid,
      'status':'ambiguous' if evidence['flags'] else 'pending','method':'offline_metadata_candidate','evidence':evidence})
 candidates.extend(extra)
 # No accepted or rejected decision is overwritten; duplicate candidate evidence gets a stable key.
 return sorted({r['candidate_id']:r for r in candidates}.values(),key=lambda r:r['candidate_id'])

def build_preview(collections_out,members,items,local,accepted,candidates):
 assets={r['id']:r for r in local};links=collections.defaultdict(list)
 for r in accepted:links['soundcloud:tracks:'+str(r['soundcloud_track_id'])].append(r)
 grouped=collections.defaultdict(list)
 for m in members:grouped[m['collection_id']].append(m)
 choices=[]
 for c in collections_out:
  rows=grouped[c['collection_id']];n=sum(bool(links[r['source_item_id']]) for r in rows)
  if c['service']=='soundcloud' and not c['is_likes'] and n and n<len(rows): choices.append((abs(len(rows)-20),-n,c['collection_id'],c))
 if not choices:raise ValueError('No representative mixed collection')
 c=min(choices)[-1];rows=sorted(grouped[c['collection_id']],key=lambda x:x['position']);out=[]
 for m in rows:
  item=items[m['source_item_id']];a=[]
  for link in links[m['source_item_id']]:
   t=assets[link['track_id']];p=Path(t['absolute_path']);present=p.is_file()
   a.append({'local_track_id':t['id'],'path':str(p),'file_exists_checked':present,'catalog_missing_flag':bool(t['missing']),
     'playback_url':'http://127.0.0.1:8000/api/tracks/'+str(t['id'])+'/audio' if present else None,
     'match_method':link['method'],'match_evidence':clean(link),'local_title':t['title']})
  out.append({**m,'title':item.get('title'),'service_url':item.get('service_url'),'remote_availability':item['availability'],
    'local_assets':a,'state':'local_asset_present' if any(x['file_exists_checked'] for x in a) else ('linked_asset_missing' if a else 'remote_only_unresolved'),
    'candidate_ids':[x['candidate_id'] for x in candidates if m['source_item_id'] in (x['left'],x['right'])]})
 return {'source_snapshot':c,'source_entries':out,'proposed_local_collection':{'name':c['name'],'status':'proposal_only',
   'origin_collection_id':c['collection_id'],'entries':[{'position':m['position'],'source_item_id':m['source_item_id'],
   'local_track_ids':[a['local_track_id'] for a in m['local_assets']]} for m in out]},'physical_check_scope':'only linked assets in this preview'}

def preview_html(preview):
 rows=[]
 for r in preview['source_entries']:
  players=''.join('<audio controls preload="none" src="'+html.escape(a['playback_url'],quote=True)+'"></audio>' for a in r['local_assets'] if a['playback_url'])
  state={'local_asset_present':'Τοπικό αρχείο διαθέσιμο','linked_asset_missing':'Συνδεδεμένο αρχείο που λείπει','remote_only_unresolved':'Χωρίς επιβεβαιωμένο τοπικό αρχείο'}[r['state']]
  link='<a rel="noreferrer" href="'+html.escape(r['service_url'],quote=True)+'">SoundCloud</a>' if r['service_url'] else ''
  rows.append(f'<tr><td>{r["position"]+1}</td><td>{html.escape(r["title"] or r["source_item_id"])}</td><td>{state}<br>{players}</td><td>{link}</td></tr>')
 return '<!doctype html><html lang="el"><meta charset="utf-8"><title>CrateMind · Προεπισκόπηση συλλογής</title><style>body{font:16px system-ui;background:#111827;color:#e5e7eb;max-width:1200px;margin:40px auto;padding:24px}td,th{padding:14px;text-align:left;border-bottom:1px solid #374151}a{color:#93c5fd}audio{width:250px;margin-top:10px}input{font:inherit;padding:8px;width:80%}</style><h1>Προεπισκόπηση συλλογής</h1><p>Τοπικό προσχέδιο. Οι πηγές και ο κατάλογος παραμένουν αμετάβλητα.</p><label>Προτεινόμενο όνομα <input value="'+html.escape(preview['source_snapshot']['name'],quote=True)+'"></label><p>Η επεξεργασία ονόματος μένει σε αυτή τη σελίδα και δεν αποθηκεύεται. Η αναπαραγωγή χρησιμοποιεί τον τοπικό CrateMind server.</p><table><tr><th>Θέση</th><th>Τίτλος</th><th>Τοπική διαθεσιμότητα</th><th>Πηγή</th></tr>'+''.join(rows)+'</table></html>'

def run(out,db_path,snapshot_path=None):
 out=Path(out).resolve();out.mkdir(parents=True,exist_ok=True);out.chmod(0o700)
 marker=out/'.preview-owned'
 if any(out.iterdir()) and not marker.exists():raise ValueError('Refusing an existing non-preview output directory')
 marker.touch()
 source_base=ROOT/'SoundCloud-Library-Download';sc=source_base/'data/soundcloud';snap='20260913T225252Z'
 expected=json.loads((ROOT/'verification/input_manifest.json').read_text());inventory=[]
 paths={a:source_base/'inputs/spotify'/f'{a}_exportify.zip' for a in LIKES}
 paths['soundcloud']=sc/'archives'/f'soundcloud_{snap}.tar.gz'
 for role,p in paths.items():
  h=sha(p);wanted=next(x['sha256'] for x in expected if x['role']==role)
  if h!=wanted:raise ValueError('Input hash mismatch: '+role)
  inventory.append({'role':role,'path':str(p),'sha256':h,'bytes':p.stat().st_size,'matches_handoff':True})
 # Validate every archive member, and ensure loose normalized/raw inputs are identical.
 archive=paths['soundcloud'];verified=0
 with tarfile.open(archive) as tar:
  files={m.name:m for m in tar.getmembers() if m.isfile()}
  manifest_name=next(n for n in files if n.endswith('snapshot_sha256_manifest.json'))
  manifest=json.load(tar.extractfile(files[manifest_name]))
  # The manifest schema is intentionally checked, never guessed from a partial match.
  entries=[{'path':k,'sha256':v} for k,v in manifest.items()] if isinstance(manifest,dict) else manifest
  if not isinstance(entries,list):raise ValueError('Unknown SoundCloud manifest schema')
  for e in entries:
   name=e['path'];member=files.get(name)
   if member is None:raise ValueError('Missing archive member '+name)
   h=hashlib.sha256(tar.extractfile(member).read()).hexdigest()
   if h!=e['sha256']:raise ValueError('Archive member hash mismatch '+name)
   if name.startswith('data/soundcloud/normalized/') or name.endswith('/tracks_cache.json'):
    if sha(source_base/name)!=h:raise ValueError('Loose input differs from archive: '+name)
   verified+=1
 inventory.append({'role':'soundcloud_members','verified_files':verified})
 db_path=Path(db_path).resolve();dest=Path(snapshot_path).resolve() if snapshot_path else out/'catalog_snapshot.sqlite'
 live=ro_db(db_path);live.execute('BEGIN');before=db_digest(live);live.rollback();live.close()
 if not snapshot_path:snapshot(db_path,dest)
 c=ro_db(dest);quick=c.execute('PRAGMA quick_check').fetchall();fk=c.execute('PRAGMA foreign_key_check').fetchall()
 if [r[0] for r in quick]!=['ok'] or fk:raise ValueError('Invalid catalog snapshot')
 snap_digest=db_digest(c)
 tables={r[0]:[dict(x) for x in c.execute('SELECT * FROM "'+r[0]+'"')] for r in c.execute("select name from sqlite_master where type='table' and name in ('tracks','track_soundcloud_matches','soundcloud_match_candidates','soundcloud_tracks')").fetchall()}
 schema=[dict(r) for r in c.execute("select type,name,sql from sqlite_master where sql is not null order by name")];c.close()
 local=tables['tracks'];accepted=tables['track_soundcloud_matches'];history=tables['soundcloud_match_candidates']
 inventory.append({'role':'analysis_catalog','path':str(dest),'source_live_path':str(db_path),'sha256':sha(dest),
   'method':'SQLite online backup from mode=ro connection' if not snapshot_path else 'explicit reuse of previous consistent snapshot',
   'matches_uploaded_bytes':sha(dest)==next(e['sha256'] for e in expected if e['role']=='database'),
   'logical_tables':snap_digest,'quick_check':'ok','foreign_key_violations':0})
 for role in ['database','tunemymusic1','tunemymusic2']:
  e=next(e for e in expected if e['role']==role)
  inventory.append({'role':'original_'+role,'expected_filename':e['filename'],'expected_sha256':e['sha256'],
    'status':'separate original not located; snapshot comparison provided' if role=='database' else 'not located; not needed for Exportify-first preview'})
 collections_out=[];members=[];items={};observations=[]
 for account in LIKES:
  cc,mm,ii,oo=parse_spotify(paths[account],account);collections_out+=cc;members+=mm;items.update(ii);observations+=oo
 raw=json.loads((sc/'raw'/snap/'tracks_cache.json').read_text());tracks=read_rows(sc/'normalized/tracks.jsonl');likes=read_rows(sc/'normalized/likes_tracks.jsonl')
 for t in tracks+likes:
  sid='soundcloud:tracks:'+str(t['track_id'])
  if sid in items:continue
  raw_t=raw.get(str(t['track_id']),{})
  item={'source_item_id':sid,'remote_id':str(t['track_id']),'urn':t.get('urn'),'service':'soundcloud',
    'type':'long_form' if (t.get('duration_ms') or 0)>=1200000 or re.search(r'\bdj\s*(mix|set)\b',t.get('title') or '',re.I) else 'track',
    'title':t.get('title'),'performer':t.get('publisher_artist'),'uploader':t.get('uploader_username'),'uploader_id':t.get('uploader_id'),
    'uploader_permalink':t.get('uploader_permalink'),'uploader_permalink_url':t.get('uploader_permalink_url'),
    'duration_ms':t.get('full_duration_ms') or t.get('duration_ms'),'isrc':t.get('isrc'),'created_at':t.get('created_at'),
    'release_date':t.get('release_date'),'availability':t.get('availability_state','unknown'),'service_url':clean(t.get('permalink_url')),
    'version_tokens':versions(t.get('title')),'snapshot':snap,'popularity':{k:raw_t.get(k) for k in ['playback_count','likes_count','reposts_count','comment_count','download_count']},
    'popularity_observed_at':snap,'popularity_time_basis':'snapshot acquisition window; see raw request_metadata.jsonl',
    'raw_metadata':clean(raw_t),'normalized_metadata':clean(t)}
  items[sid]=item
 sc_collections=read_rows(sc/'normalized/playlists.jsonl')
 for row in sc_collections:
  collections_out.append({'collection_id':'sc:'+snap+':'+row['playlist_id'],'service':'soundcloud','account':'7149789','name':row['title'],
    'source_remote_id':row['playlist_id'],'is_likes':False,'track_count':row['track_count'],'relationships':row['relationships'],
    'observed_at':row['acquired_at'],'source_snapshot':clean(row)})
 for row in read_rows(sc/'normalized/playlist_tracks.jsonl'):
  cid='sc:'+snap+':'+row['playlist_id'];sid='soundcloud:tracks:'+str(row['track_id']) if row['track_id'] is not None else 'unknown:'+key(cid,row['position'])
  items.setdefault(sid,{'source_item_id':sid,'service':'soundcloud','remote_id':row['track_id'],'type':'unknown','title':row.get('title'),'availability':'unknown'})
  members.append({'membership_id':key(cid,row['position']),'collection_id':cid,'position':row['position'],'source_item_id':sid,'added_at':None,
     'is_likes':False,'account':'7149789','raw_membership':clean(row)})
 cid='sc:'+snap+':likes';collections_out.append({'collection_id':cid,'service':'soundcloud','account':'7149789','name':'SoundCloud Likes',
   'is_likes':True,'relationships':['liked_tracks'],'track_count':len(likes),'observed_at':snap})
 for row in likes:
  pos=row['like_index'];members.append({'membership_id':key(cid,pos),'collection_id':cid,'position':pos,'source_item_id':'soundcloud:tracks:'+str(row['track_id']),
    'added_at':row.get('like_created_at'),'is_likes':True,'account':'7149789','raw_membership':clean(row)})
 # Every additional captured source membership survives too (reposts and uploads are distinct from Likes).
 for label,filename in [('reposts','reposts_tracks.jsonl')]:
  rows=read_rows(sc/'normalized'/filename);cid='sc:'+snap+':'+label
  collections_out.append({'collection_id':cid,'service':'soundcloud','account':'7149789','name':label,'is_likes':False,'relationships':[label],'track_count':len(rows),'observed_at':snap,'object_type':'activity_snapshot'})
  for pos,row in enumerate(rows):members.append({'membership_id':key(cid,pos),'collection_id':cid,'position':pos,'source_item_id':'soundcloud:tracks:'+str(row['track_id']),'added_at':row.get('reposted_at'),'is_likes':False,'account':'7149789','raw_membership':clean(row)})
 relationships=read_rows(sc/'normalized/playlist_relationships.jsonl')
 # Exact provider identities are distinct from a cross-provider recording hypothesis.
 aliases=collections.defaultdict(set)
 for m in members:
  if m['source_item_id'].startswith('spotify:'):aliases[m['source_item_id']].add(m['account'])
 write_rows(out/'same_service_aliases.jsonl',[{'source_item_id':s,'accounts':sorted(a),'basis':'exact same Spotify URI; no distinct-ID relinking inferred'} for s,a in sorted(aliases.items()) if len(a)>1])
 write_rows(out/'source_observations.jsonl',observations)
 write_rows(out/'source_items.jsonl',sorted(items.values(),key=lambda r:r['source_item_id']))
 write_rows(out/'source_collections.jsonl',collections_out);write_rows(out/'source_memberships.jsonl',members)
 write_rows(out/'playlist_relationships.jsonl',relationships)
 write_rows(out/'local_assets.jsonl',[clean(t) for t in local]);write_rows(out/'accepted_links.jsonl',[clean(t) for t in accepted])
 write_rows(out/'existing_candidate_history.jsonl',[clean(t) for t in history]);write_rows(out/'previous_soundcloud_observations.jsonl',[clean(t) for t in tables['soundcloud_tracks']])
 write_json(out/'catalog_schema.json',schema)
 # Inspect only catalog-associated directories, never traverse or read the audio library wholesale.
 local_paths={str(Path(t['absolute_path']).resolve()):t['id'] for t in local};old=[];extra=[];sidecars=[];url_to_sc={clean(t.get('service_url')):s for s,t in items.items() if t['service']=='soundcloud' and t.get('service_url')}
 for p in sorted(ROOT.parent.glob('sc_*.json')):
  values=json.loads(p.read_text());old.append({'path':str(p),'sha256':sha(p),'rows':len(values),'evidence_class':'historical heuristic, not accepted'})
  for row in values:
   lp=row.get('local');sid='soundcloud:tracks:'+str(row.get('id'));lid=local_paths.get(str(Path(lp).resolve())) if lp else None
   if lid and sid in items:extra.append({'candidate_id':key('historical',p.name,lid,sid),'left':'local:'+str(lid),'right':sid,'status':'historical_unreviewed',
      'method':'legacy_heuristic','evidence':{'file':str(p),'row':clean(row),'not_explicit_download_identity':True}})
 checked_dirs=set()
 for t in local:
  p=Path(t['absolute_path']);parent=p.parent
  if parent not in checked_dirs:
   checked_dirs.add(parent)
   try:sidecars.extend(q for q in parent.iterdir() if q.is_file() and q.name.endswith(('.info.json','.description','.url')))
   except OSError:pass
  for u in URL.findall(t.get('comment') or ''):
   sid=url_to_sc.get(clean(u))
   if sid:extra.append({'candidate_id':key('comment_url',t['id'],sid),'left':'local:'+str(t['id']),'right':sid,'status':'pending',
    'method':'explicit_comment_url','evidence':{'field':'tracks.comment','url':clean(u),'requires_review':True}})
 sidecar_results=[]
 for p in sorted(set(sidecars)):
  if p.stat().st_size>2000000:sidecar_results.append({'path':str(p),'status':'skipped_over_2MB'});continue
  text=p.read_text(errors='replace');matched=[]
  for u in URL.findall(text):
   sid=url_to_sc.get(clean(u))
   if sid:matched.append(sid)
  # A filename neighbour is not proof of which file this sidecar describes.
  sidecar_results.append({'path':str(p),'sha256':sha(p),'source_items':sorted(set(matched)),'status':'inspected; file association unconfirmed'})
 write_json(out/'provenance_evidence.json',{'legacy_reports':old,'catalog_directories_checked':len(checked_dirs),'sidecars':sidecar_results,
   'scope':'directory listings only; no audio analysis, tag reading or library rescan','note':'No path-prefix rewriting of historical paths without evidence'})
 candidates=reconcile(items,local,accepted,history,extra)
 memberships_by_item=collections.defaultdict(set)
 for m in members:memberships_by_item[m['source_item_id']].add(m['collection_id'])
 for r in candidates:r['collection_context']={'left':sorted(memberships_by_item[r['left']]),'right':sorted(memberships_by_item[r['right']]),'used_for_identity_score':False}
 write_rows(out/'match_candidates.jsonl',candidates)
 preview=build_preview(collections_out,members,items,local,accepted,candidates)
 write_json(out/'collection_preview.json',preview);(out/'collection_preview.html').write_text(preview_html(preview))
 sp_members=[m for m in members if m['account'] in LIKES];sc_members=[m for m in members if m['account']=='7149789']
 counts={'spotify':{a:{'collections':sum(c.get('account')==a for c in collections_out),'rows':sum(m['account']==a for m in sp_members),'likes_rows':sum(m['account']==a and m['is_likes'] for m in sp_members)} for a in LIKES},
  'spotify_likes_uri_union':len({m['source_item_id'] for m in sp_members if m['is_likes'] and m['source_item_id'].startswith('spotify:track:')}),
  'spotify_music_uri_union':len({m['source_item_id'] for m in sp_members if m['source_item_id'].startswith('spotify:track:')}),
  'spotify_non_music_positions':dict(collections.Counter(items[m['source_item_id']]['type'] for m in sp_members if items[m['source_item_id']]['type']!='track')),
  'soundcloud_playlists':len(sc_collections),'soundcloud_playlist_positions':sum(c['track_count'] for c in sc_collections),'soundcloud_likes':len(likes),
  'soundcloud_unknown_likes':sum(not t.get('title') for t in likes),'soundcloud_counter_gap':2,
  'local_assets':len(local),'catalog_missing_flags':sum(bool(t['missing']) for t in local),
  'accepted_links':len(accepted),'accepted_distinct_soundcloud_ids':len({r['soundcloud_track_id'] for r in accepted}),
  'accepted_methods':dict(collections.Counter(r['method'] for r in accepted)),'existing_candidate_states':dict(collections.Counter(r['status'] for r in history)),
  'generated_candidate_states':dict(collections.Counter(r['status'] for r in candidates)),'generated_candidates':len(candidates),
  'preview_name':preview['source_snapshot']['name'],'preview_states':dict(collections.Counter(r['state'] for r in preview['source_entries'])),
  'source_items':len(items),'source_collections':len(collections_out),'source_memberships':len(members),
  'spotify_with_no_accepted_local_link':len({m['source_item_id'] for m in sp_members if m['source_item_id'].startswith('spotify:track:')}),
  'new_accepted_matches':0,'soundcloud_archive_members_verified':verified}
 write_json(out/'metrics.json',counts);write_json(out/'INPUT_INVENTORY.json',inventory)
 live=ro_db(db_path);live.execute('BEGIN');after=db_digest(live);live.rollback();live.close()
 write_json(out/'source_preservation.json',{'before':before,'after':after,'all_logical_tables_unchanged':before==after,
  'snapshot_equals_initial_live_logical_tables':snap_digest==before,'source_connections_read_only':True,
  'input_hashes_unchanged':all(sha(Path(x['path']))==x['sha256'] for x in inventory if x['role'] in paths)})
 print(json.dumps(counts,ensure_ascii=False,indent=2))

if __name__=='__main__':
 import sys
 sys.path.insert(0,str(ROOT/'backend'))
 from app.services.writer_context import catalog_path
 p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);p.add_argument('--db',type=Path,default=None);p.add_argument('--snapshot',type=Path)
 a=p.parse_args();run(a.output,catalog_path(a.db),a.snapshot)
