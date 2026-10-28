"""Remove the user-deleted duplicate catalog entries; never change audio files.
Plan: validate exact reviewed paths, snapshot both databases, rehearse the
association-preserving merge on copies, then apply and verify foreign keys.
"""

# Archived experiment: fail closed before any old path or audio side effect.
import sys as _dataset_sys
from pathlib import Path as _DatasetPath
_dataset_sys.path.insert(0, str(next(parent for parent in _DatasetPath(__file__).resolve().parents if (parent / "backend/app").is_dir()) / "backend"))
from app.services.writer_context import reject_legacy_script
reject_legacy_script(_DatasetPath(__file__))
import json
import sys
from datetime import datetime
from pathlib import Path
import merge_missing as migration

out = Path(__file__).resolve().parent
root = out.parents[1]
rows = json.loads((out / 'plan.json').read_text())['delete_existing_files']
assert len(rows) == 66
migration.PLAN = {'merges': [
    {'remove': r['remove_id'], 'keep': r['keep_id'],
     'basis': 'user-deleted reviewed duplicate; ' + r['basis']}
    for r in rows
]}
for row in rows:
    assert not Path(row['remove_path']).exists(), row
    assert Path(row['keep_path']).is_file(), row

mode = sys.argv[1]
assert mode in ('--rehearse', '--apply')
stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
folder = out / (f'deleted-66-{mode[2:]}-{stamp}')
folder.mkdir()
for name in ('cratemind', 'identity'):
    migration.snapshot(root / f'backend/data/{name}.sqlite', folder / f'{name}.sqlite')
target = folder if mode == '--rehearse' else root / 'backend/data'
result = migration.merge(target / 'cratemind.sqlite', target / 'identity.sqlite')
result['snapshot'] = str(folder)
(out / f'deleted-66-{mode[2:]}-result.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result, indent=2))
