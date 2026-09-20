"""Apply/undo only local collection presentation; verify immutable baseline subsets."""
import argparse
import hashlib
import json
import sqlite3
import sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'backend'))
from app.services import canonical_library,collection_consolidation as c,library_completeness as completeness
OUT=ROOT/'reconciliation/identity/consolidation'


def rows(db,table):return [tuple(r) for r in db.execute(f'SELECT * FROM "{table}" ORDER BY rowid')]
def hash_rows(values):return hashlib.sha256(repr(values).encode()).hexdigest()


def verify(db):
    before=sqlite3.connect(f'file:{OUT / "before.sqlite"}?mode=ro',uri=True)
    checks={}
    baseline=json.loads((OUT/'before.json').read_text())
    for table,info in baseline['tables'].items():
        if table in {'collections','memberships'}:
            original=rows(before,table);keys={r[0] if table=='collections' else r[:2] for r in original}
            current=[r for r in rows(db,table) if (r[0] if table=='collections' else r[:2]) in keys]
            checks[table]=hash_rows(current)==info['sha256']
        else:checks[table]=hash_rows(rows(db,table))==info['sha256']
    before.close()
    if not all(checks.values()):raise RuntimeError(f'Frozen baseline changed: {checks}')
    return checks


def main():
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['apply','verify','undo']);parser.add_argument('--batch');args=parser.parse_args()
    OUT.mkdir(exist_ok=True)
    with canonical_library.connect() as db:
        if args.action=='undo':
            if not args.batch:parser.error('--batch is required for undo')
            print(json.dumps(c.undo(db,batch_id=args.batch),indent=2));return
        if args.action=='verify':print(json.dumps(verify(db),indent=2));return
        db.execute('BEGIN IMMEDIATE')
        frozen=verify(db)
        if (OUT/'manifest.json').exists():
            # Idempotent rerun never overwrites the accounting of the actual production batch.
            result=c.apply_automatic(db,args.batch)
            if result['decisions']:raise RuntimeError('A prior manifest exists and new groups are eligible; retain a new explicit batch manifest before applying')
            print(json.dumps(result,indent=2));return
        before_counts={rid:(v['collection_family_count'],v['source_collection_count'],v['raw_collection_occurrences']) for rid,v in completeness.index(db).items()}
        result=c.apply_automatic(db,args.batch or 'collection-consolidation-v1')
        frozen=verify(db)
        after_counts={rid:(v['collection_family_count'],v['source_collection_count'],v['raw_collection_occurrences']) for rid,v in completeness.index(db).items()}
        assert before_counts==after_counts,'Collection interest semantics changed'
        absorbed={i for d in result['decisions'] for i in d['absorbed']};created={i for d in result['decisions'] for i in d['created']};reused={i for d in result['decisions'] for i in d['reused']}
        assert result['after']==result['before']-len(absorbed)+len(created)
        missing=db.execute('''SELECT m.collection_id,m.position FROM memberships m WHERE m.collection_id IN
         (SELECT b.source_id FROM collection_representation_bindings b JOIN collection_consolidations d ON d.id=b.decision_id WHERE d.status='active')
         AND NOT EXISTS(SELECT 1 FROM collection_position_dispositions p WHERE p.source_id=m.collection_id AND p.source_position=m.position)''').fetchall()
        assert not missing,'Absorbed positions without disposition'
        groups=c.review_groups(db)
        summary={**result,'original_observations_absorbed':len(absorbed),'representatives_created':len(created),'representatives_reused':len(reused),
          'automatic_groups':len(result['decisions']),'human_groups':0,'kept_separate_groups':sum(g['state']=='kept_separate' for g in groups),'unresolved_groups':sum(g['state']=='needs_review' for g in groups),
          'original_observations_retained':json.loads((OUT/'before.json').read_text())['tables']['collections']['count'],'original_positions_retained':json.loads((OUT/'before.json').read_text())['tables']['memberships']['count'],
          'stored_collections':db.execute('SELECT count(*) FROM collections').fetchone()[0],
          'stored_positions':db.execute('SELECT count(*) FROM memberships').fetchone()[0],
          'new_representative_positions':sum(db.execute('SELECT count(*) FROM memberships WHERE collection_id=?',(i,)).fetchone()[0] for i in created),
          'historical_only_occurrences':sum(len(d['historical_only']) for d in result['decisions']),
          'frozen_tables_preserved':frozen,'frequency_changes':0,'position_dispositions_complete':True}
        # Write the manifest only after the SQLite commit succeeds.
        db.commit()
        (OUT/'manifest.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2))
        print(json.dumps({k:v for k,v in summary.items() if k!='decisions'},indent=2))

if __name__=='__main__':main()
