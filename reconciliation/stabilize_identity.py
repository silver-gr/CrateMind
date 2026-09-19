"""One-time metadata-role correction. Never scores, promotes or changes identity groups."""
import sys,json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'backend'))
from app.services import canonical_library as c,canonical_metadata as m

def main():
    report={'changed_recordings':0,'changed_credits':0,'manual_recordings_preserved':0}
    with c.connect() as db:
        for row in db.execute('SELECT * FROM canonical_recordings').fetchall():
            if row['state'] in {'human','kept_local','rejected'}:
                report['manual_recordings_preserved']+=1;continue
            p=json.loads(row['proposal_json']);old=json.loads(row['proposal_json'])
            source=db.execute('SELECT * FROM entities WHERE id=?',(p.get('source_id'),)).fetchone()
            if not source:continue
            fresh=m.proposal(source);role_map={m.text_key(r['name']):r['role'] for r in fresh['credits']}
            for r in p['credits']:
                if m.text_key(r['name']) in role_map:r['role']=role_map[m.text_key(r['name'])]
            current=c.detail(db,row['recording_id'])['credits']
            updated=[dict(v) for v in current]
            if row['state']=='derived':
                for r in updated:
                    if m.text_key(r['name']) in role_map:r['role']=role_map[m.text_key(r['name'])]
            else:
                base=[v for v in updated if v['role'] in {'primary','collaborator'}]
                if len(base)>1:
                    for v in base:v['role']='collaborator'
            if old['credits']==p['credits'] and [r['role'] for r in current]==[r['role'] for r in updated]:continue
            p['artist']=m.display_credit(p['credits'])
            artist=m.display_credit(updated) if row['state']=='derived' else row['artist']
            report['changed_recordings']+=1;report['changed_credits']+=sum(a['role']!=b['role'] for a,b in zip(current,updated))
            db.execute('UPDATE canonical_recordings SET proposal_json=?,artist=?,updated_at=? WHERE recording_id=?',(c.dump(p),artist,c.now(),row['recording_id']))
            for r in updated:db.execute('UPDATE recording_artists SET role=? WHERE recording_id=? AND credit_order=?',(r['role'],row['recording_id'],r['credit_order']))
            db.execute('INSERT INTO canonical_events(recording_id,action,before_json,after_json,created_at) VALUES (?,?,?,?,?)',(row['recording_id'],'credit_semantics_v2',c.dump({'proposal':old,'credits':current,'artist':row['artist']}),c.dump({'proposal':p,'credits':updated,'artist':artist}),c.now()))
        db.execute("INSERT OR REPLACE INTO metadata VALUES ('credit_semantics_version','2')")
    (ROOT/'reconciliation/identity/stabilization/credits.json').write_text(c.dump(report))
    print(c.dump(report))
if __name__=='__main__':main()
