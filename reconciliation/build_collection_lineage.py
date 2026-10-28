"""Populate additive provenance only; freeze every pre-existing source/identity row."""
import sys,json,sqlite3,hashlib,ast
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'backend'))
from app.services.writer_context import dataset_writer
from app.services import canonical_library,collection_lineage as lineage
OUT=ROOT/'reconciliation/identity/lineage'
TABLES=['entities','identity_acceptances','candidates','collections','memberships','canonical_recordings','recording_artists']
def digest(db):return {t:hashlib.sha256(repr([tuple(r) for r in db.execute(f'SELECT * FROM {t} ORDER BY rowid')]).encode()).hexdigest() for t in TABLES}
@dataset_writer
def main():
    OUT.mkdir(parents=True,exist_ok=True)
    with canonical_library.connect() as db:
        before=digest(db)
        if not (OUT/'before.sqlite').exists():
            with sqlite3.connect(OUT/'before.sqlite') as backup:db.backup(backup)
            (OUT/'before.json').write_text(json.dumps(before,indent=2))
        result=lineage.infer(db)
        assert before==digest(db),'Frozen catalog changed'
        result['frozen_tables_unchanged']=True
        (OUT/'summary.json').write_text(json.dumps(result,indent=2))
        (OUT/'relationships.json').write_text(json.dumps(lineage.relationships(db),ensure_ascii=False,indent=2))
        print(json.dumps(result,indent=2))

if __name__=='__main__':main()
