
# Archived experiment: fail closed before any old path or audio side effect.
import sys as _dataset_sys
from pathlib import Path as _DatasetPath
_dataset_sys.path.insert(0, str(next(parent for parent in _DatasetPath(__file__).resolve().parents if (parent / "backend/app").is_dir()) / "backend"))
from app.services.writer_context import reject_legacy_script
reject_legacy_script(_DatasetPath(__file__))
import json
from pathlib import Path
p=Path(__file__).parent/'title100'
rows=[]
for f in [p/'results.json',*sorted(p.glob('part-*.json'))]:
 if f.exists():rows.extend(json.loads(f.read_text()))
by_id={r['id']:r for r in rows}
selected=json.loads((p/'selection.json').read_text())['selection']
assert len(by_id)==100, f'{len(by_id)}/100 complete'
assert set(by_id)=={r['id'] for r in selected}
(p/'results.json').write_text(json.dumps([by_id[r['id']] for r in selected],indent=2))
print('Merged 100 unique selected tracks')
