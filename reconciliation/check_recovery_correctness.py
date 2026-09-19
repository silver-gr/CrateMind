"""Bounded read-only filesystem diagnostics: saved paths, existing rows and same-directory siblings only."""
import sys,sqlite3,json,hashlib,os
from pathlib import Path
from collections import Counter,defaultdict
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'backend'))
from app.services import identity_library,library_completeness as c,provider_resolution as p,hashing,recovery_prioritization as recovery
OUT=ROOT/'reconciliation/identity/recovery-correctness';OUT.mkdir(parents=True,exist_ok=True)
with identity_library.connect() as db,sqlite3.connect(f'file:{ROOT}/backend/data/cratemind.sqlite?mode=ro',uri=True) as primary:
    primary.row_factory=sqlite3.Row
    frozen_tables=['entities','identity_acceptances','candidates','canonical_recordings','recording_artists','collections','memberships','collection_relationships']
    fingerprint=lambda conn,table:hashlib.sha256(repr([tuple(r) for r in conn.execute(f'SELECT * FROM {table} ORDER BY rowid')]).encode()).hexdigest()
    before={t:fingerprint(db,t) for t in frozen_tables};before['primary_tracks']=fingerprint(primary,'tracks')
    baseline=OUT/'before.json'
    if not baseline.exists():baseline.write_text(json.dumps(before,indent=2))
    assert json.loads(baseline.read_text())==before,'Catalog changed since baseline'
    catalog=c.index(db)
    current={r['id']:dict(r) for r in primary.execute('SELECT * FROM tracks')}
    snapshots=[(dict(r),json.loads(r['metadata_json'])) for r in db.execute('SELECT * FROM entities WHERE service="local"')]
    bad=[];flagged=set();signature_paths=defaultdict(list)
    for e,m in snapshots:
        a=p.local_asset(e)
        if a['catalog_missing_flag']:flagged.add(e['recording_id'])
        if a['file_evidence']['state']=='present':signature_paths[(m.get('file_size'),m.get('quick_hash'))].append(m['absolute_path'])
        if not a['playable']:bad.append((e,m,a))
    scans={};diagnostics=[]
    for e,m,a in bad:
        path=Path(m['absolute_path']);same_signature=list(signature_paths.get((m.get('file_size'),m.get('quick_hash')),[]))
        # No recursive/root-wide search; inspect only the recorded file's immediate parent.
        try:
            if path.parent not in scans:scans[path.parent]=list(path.parent.iterdir())
            for sibling in scans[path.parent]:
                if sibling==path or not sibling.is_file():continue
                if sibling.stat().st_size==m.get('file_size') and m.get('quick_hash') and hashing.quick_hash(sibling)==m['quick_hash']:
                    same_signature.append(str(sibling))
        except OSError:pass
        alternatives=sorted(set(same_signature))
        diagnostics.append({'local_id':e['local_track_id'],'recording_id':e['recording_id'],'path':str(path),'root':m.get('volume_root'),
            'catalog_flag':a['catalog_missing_flag'],'file_evidence':a['file_evidence'],
            'stale_path_evidence':'same size and existing sampled SHA256 signature at another path' if alternatives else 'not established',
            'alternative_paths':alternatives,'another_accepted_asset_playable':catalog[e['recording_id']]['availability']['playable']})
    remote=[v for v in catalog.values() if v['availability']['remote_only']];recovery.local_candidates(db,remote)
    candidates={'remote_only_groups':len(remote),'with_plausible_unaccepted_local_files':sum(v['local_candidate_evidence']['plausible_local_files']>0 for v in remote),
        'ambiguous_only':sum(not v['local_candidate_evidence']['plausible_local_files'] and v['local_candidate_evidence']['ambiguous_local_files']>0 for v in remote),
        'guarded_only':sum(v['local_candidate_evidence']['candidate_pairs']>0 and not v['local_candidate_evidence']['plausible_local_files'] and not v['local_candidate_evidence']['ambiguous_local_files'] for v in remote),
        'no_stored_local_candidate_pairs':sum(v['local_candidate_evidence']['candidate_pairs']==0 for v in remote)}
    example=next(v for v in remote if v['local_candidate_evidence']['plausible_local_files'])
    report={'file_rows':len(snapshots),'local_recording_groups':sum(bool(v['local_assets']) for v in catalog.values()),
        'primary_missing_flags':sum(bool(v['missing']) for v in current.values()),'snapshot_missing_flags':sum(bool(m['missing']) for e,m in snapshots),
        'flagged_recording_groups':len(flagged),'flagged_groups_without_playable_asset':sum(not catalog[rid]['availability']['playable'] for rid in flagged),
        'unavailable_unflagged_groups_without_playable_asset':sum(not d['catalog_flag'] and not d['another_accepted_asset_playable'] for d in diagnostics),
        'root_observations':{root:{'is_directory':Path(root).is_dir(),'is_mount':os.path.ismount(root),'readable':os.access(root,os.R_OK)} for root in {m.get('volume_root') for e,m,a in bad} if root},'primary_snapshot_path_differences':sum(current[e['local_track_id']]['absolute_path']!=m['absolute_path'] for e,m in snapshots),
        'live_unavailable_file_rows':len(bad),'unflagged_unavailable_rows':sum(not a['catalog_missing_flag'] for e,m,a in bad),
        'groups_with_unavailable_rows':len({e['recording_id'] for e,m,a in bad}),
        'groups_rescued_by_other_playable_asset':sum(d['another_accepted_asset_playable'] for d in diagnostics),
        'groups_without_playable_assets':sum(v['availability']['missing_file'] for v in catalog.values()),
        'causes_by_file_row':dict(Counter(d['file_evidence']['state'] for d in diagnostics)),
        'stale_path_signature_evidence_rows':sum(bool(d['alternative_paths']) for d in diagnostics),
        'stale_path_signature_flagged_rows':sum(bool(d['alternative_paths']) and d['catalog_flag'] for d in diagnostics),
        'audio_absent_everywhere':'not established; confirmed absence is limited to recorded paths',
        'candidate_summary':candidates,'candidate_example':{k:example[k] for k in ['recording_id','artist','title','availability','local_assets','local_candidate_evidence']}}
    assert before=={**{t:fingerprint(db,t) for t in frozen_tables},'primary_tracks':fingerprint(primary,'tracks')}
    report['frozen_tables_unchanged']=True
    (OUT/'findings.json').write_text(json.dumps(report,indent=2,ensure_ascii=False));(OUT/'file-diagnostics.json').write_text(json.dumps(diagnostics,indent=2,ensure_ascii=False))
    print(json.dumps({k:v for k,v in report.items() if k!='candidate_example'},indent=2))
