
# Archived experiment: fail closed before any old path or audio side effect.
import sys as _dataset_sys
from pathlib import Path as _DatasetPath
_dataset_sys.path.insert(0, str(next(parent for parent in _DatasetPath(__file__).resolve().parents if (parent / "backend/app").is_dir()) / "backend"))
from app.services.writer_context import reject_legacy_script
reject_legacy_script(_DatasetPath(__file__))
import sys,time,json,sqlite3,subprocess
from pathlib import Path
import numpy as np
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'backend'))
from app.services.waveform import get_or_compute_waveform
c=sqlite3.connect((ROOT/'backend/data/cratemind.sqlite').as_uri()+'?mode=ro',uri=True)
rows=[]
for tid in (58,4167,4194):
 t=c.execute('select id,artist,title,absolute_path from tracks where id=?',(tid,)).fetchone()
 if not t:continue
 start=time.perf_counter();raw=subprocess.check_output(['ffmpeg','-v','error','-i',t[3],'-ac','1','-ar','1000','-f','s16le','-']);pcm=np.frombuffer(raw,dtype=np.int16);bucket=len(pcm)//160
 old=[float(np.max(np.abs(pcm[i*bucket:(i+1)*bucket]))) for i in range(160)];old_time=time.perf_counter()-start
 old=[max(.04,p/max(old)) for p in old]
 start=time.perf_counter();data=get_or_compute_waveform(tid,t[3]);cold=time.perf_counter()-start
 start=time.perf_counter();again=get_or_compute_waveform(tid,t[3]);warm=time.perf_counter()-start
 assert again==data and data['peaks'] and len(data['peaks'])==len(data['rms'])
 r={'id':tid,'artist':t[1],'title':t[2],'duration':data['duration'],'old_points':160,'new_points':len(data['peaks']),'old_seconds':old_time,'new_first_call_seconds':cold,'new_cached_seconds':warm}
 rows.append(r);print(r,flush=True)
 (Path(__file__).parent/f'track-{tid}.json').write_text(json.dumps({'old':old,'new':data}))
(Path(__file__).parent/'timings.json').write_text(json.dumps(rows,indent=2))
