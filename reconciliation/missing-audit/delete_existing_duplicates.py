"""Explicit opt-in file deletion. Default only previews. Does not edit catalog."""

# Archived experiment: fail closed before any old path or audio side effect.
import sys as _dataset_sys
from pathlib import Path as _DatasetPath
_dataset_sys.path.insert(0, str(next(parent for parent in _DatasetPath(__file__).resolve().parents if (parent / "backend/app").is_dir()) / "backend"))
from app.services.writer_context import reject_legacy_script
reject_legacy_script(_DatasetPath(__file__))
import argparse,json,sys
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--delete',action='store_true');args=p.parse_args()
rows=json.loads(Path(__file__).with_name('plan.json').read_text())['delete_existing_files']
# Validate the whole batch before deleting anything. Abort if either copy changed.
for r in rows:
 for side in ('remove','keep'):
  f=Path(r[side+'_path'])
  if not f.is_file():sys.exit(f'Aborted: file no longer exists: {f}')
  s=f.stat()
  if s.st_size!=r[side+'_size'] or abs(s.st_mtime-r[side+'_mtime'])>.0001:sys.exit(f'Aborted: file changed since review: {f}')
 if Path(r['remove_path']).samefile(r['keep_path']):sys.exit('Aborted: both paths refer to the same file')
for r in rows:
 if args.delete:Path(r['remove_path']).unlink()
 print(('DELETED' if args.delete else 'WOULD DELETE')+': '+r['remove_path'])
 print('KEEP: '+r['keep_path'])
print(f'{len(rows)} older copies '+('deleted. Rescan the library to refresh file availability.' if args.delete else 'reviewed; no files changed. Add --delete to execute this exact batch.'))
