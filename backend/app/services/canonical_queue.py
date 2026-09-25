"""Actionable metadata inbox. Keeps unknown/provider-only groups separately accessible."""
import json
from .identity_matching import text_key

VIEWS={'needs_review','auto_applied','conflicts','provider_only','local_only','complete','unknown','all'}

def flags(row,services):
    proposal=json.loads(row['proposal_json']);evidence=json.loads(row['evidence_json'])
    useful=bool(proposal.get('title') and proposal.get('artist') and proposal.get('credits'))
    changed=any(text_key(proposal.get(k))!=text_key(row[k]) for k in ('artist','title'))
    uncertain=bool(proposal.get('credit_ambiguity')) or bool(useful and not any(c['role'] in {'primary','collaborator'} for c in proposal['credits']))
    conflict=bool(evidence.get('provider_disagreement'))
    pending=row['state']=='review'
    relevant = changed or conflict or uncertain
    needs=bool('local' in services and useful and (pending and (relevant or evidence.get('patterns')) or row['state'] in {'rejected','kept_local'} and relevant))
    unknown=not (row['artist'] and row['title'] and proposal.get('credits'))
    return {'needs_review':needs,'auto_applied':row['state']=='derived','conflicts':conflict or uncertain,
            'provider_only':'local' not in services,'local_only':services=={'local'},
            'complete':row['state'] in {'derived','human','kept_local'} and not unknown and not conflict and not uncertain,
            'unknown':unknown,'all':True,'proposal_differs':changed,'uncertain_credits':uncertain}


def list_items(db,q='',state='',pattern='',artist_id='',role='',offset=0,view='needs_review'):
    if view not in VIEWS:raise ValueError('Unknown review view')
    services={}
    for r in db.execute('SELECT recording_id,service FROM entities GROUP BY recording_id,service'):services.setdefault(r['recording_id'],set()).add(r['service'])
    credits={};artist_matches=set()
    for r in db.execute('SELECT ra.recording_id,ra.artist_id,ra.role,a.name FROM recording_artists ra JOIN canonical_artists a ON a.id=ra.artist_id'):
        credits.setdefault(r['recording_id'],[]).append(r['name'])
        if r['artist_id']==artist_id and (not role or role==r['role']):artist_matches.add(r['recording_id'])
    counts={key:0 for key in VIEWS};matched=[]
    for row in db.execute("SELECT * FROM canonical_recordings c WHERE EXISTS(SELECT 1 FROM entities e WHERE e.recording_id=c.recording_id AND COALESCE(json_extract(e.metadata_json,'$.asset_lifecycle.state'),'')!='retired') ORDER BY artist,title,recording_id"):
        f=flags(row,services.get(row['recording_id'],set()))
        for key in counts:counts[key]+=bool(f[key])
        if not f[view] or state and row['state']!=state:continue
        if artist_id and row['recording_id'] not in artist_matches:continue
        if q and text_key(q) not in text_key(' '.join([row['title'] or '',row['artist'] or '',*credits.get(row['recording_id'],[])])):continue
        e=json.loads(row['evidence_json'])
        if pattern and pattern not in e.get('patterns',[]):continue
        value=dict(row);value['proposal']=json.loads(value.pop('proposal_json'));value['evidence']=e;value.pop('evidence_json');value['review_flags']=f
        matched.append(value)
    matched.sort(key=lambda r:('local' not in services.get(r['recording_id'],set()),not bool(r['title']),r['artist'] or '',r['title'] or ''))
    return {'items':matched[offset:offset+50],'total':len(matched),'counts':counts,'view':view}
