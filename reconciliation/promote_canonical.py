"""Apply local Identity v1 promotion after a consistent SQLite backup."""
import sys,json,sqlite3
from pathlib import Path
from datetime import datetime,timezone
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'backend'))
from app.services.writer_context import dataset_writer
from app.services import canonical_library,identity_library

@dataset_writer
def main():
    folder=ROOT/'reconciliation/identity/canonical'
    folder.mkdir(parents=True,exist_ok=True)
    stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    with identity_library.connect() as source:
        with sqlite3.connect(folder/f'before-{stamp}.sqlite') as dest:source.backup(dest)
        before=identity_library.summary(source)
    with canonical_library.connect() as db:
        report=canonical_library.promote(db)
        assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
        assert not db.execute('PRAGMA foreign_key_check').fetchall()
        assert not db.execute('SELECT c.id FROM collections c LEFT JOIN memberships m ON m.collection_id=c.id GROUP BY c.id HAVING c.track_count!=count(m.position)').fetchall()
    report['before']=before['coverage']
    report['backup']=str(folder/f'before-{stamp}.sqlite')
    (folder/'results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
    print(json.dumps({k:v for k,v in report.items() if k!='patterns'},ensure_ascii=False,indent=2))
if __name__=='__main__':main()
