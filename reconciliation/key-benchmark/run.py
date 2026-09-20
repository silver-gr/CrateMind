"""Read-only comparison with copied djay references; never writes catalog/audio."""
import csv,json,sqlite3,subprocess,time,sys,random,hashlib
from pathlib import Path
import numpy as np
import librosa
import essentia.standard as es
OUT=Path(__file__).parent
SOURCE=Path('/Users/silver/Projects/Music-Library/djay_cratemind_tracks.csv')
DB=Path('/Volumes/6937130292/Projects/CrateMind/backend/data/cratemind.sqlite')
MAJOR={0:8,1:3,2:10,3:5,4:12,5:7,6:2,7:9,8:4,9:11,10:6,11:1}
PCS={'C':0,'C#':1,'Db':1,'D':2,'D#':3,'Eb':3,'E':4,'F':5,'F#':6,'Gb':6,'G':7,'G#':8,'Ab':8,'A':9,'A#':10,'Bb':10,'B':11}
NOTES=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
KSMAJ=np.array([6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88])
KSMIN=np.array([6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17])
def camelot(key,scale):
 pc=PCS[key];minor=scale=='minor'
 return str(MAJOR[(pc+3)%12] if minor else MAJOR[pc])+('A' if minor else 'B')
def decode(path,sr):
 raw=subprocess.check_output(['ffmpeg','-v','error','-i',path,'-t','120','-ac','1','-ar',str(sr),'-f','f32le','-'])
 return np.frombuffer(raw,dtype=np.float32).copy()
def librosa_key(audio):
 chroma=librosa.feature.chroma_cqt(y=audio,sr=22050,hop_length=512)
 vec=np.mean(chroma,axis=1);choices=[]
 for i in range(12):
  for scale,profile in [('major',KSMAJ),('minor',KSMIN)]:
   corr=float(np.corrcoef(np.roll(profile,i),vec)[0,1]);choices.append((corr,NOTES[i],scale))
 corr,key,scale=max(choices)
 return {'key':key,'scale':scale,'camelot':camelot(key,scale),'strength':corr}
def run(shard):
 c=sqlite3.connect(DB.as_uri()+'?mode=ro',uri=True);c.row_factory=sqlite3.Row
 manifest=json.loads((OUT/'manifest.json').read_text());output=OUT/f'part-{shard}.json'
 results=json.loads(output.read_text()) if output.exists() else [];done={r['track_id'] for r in results}
 for row in manifest['tracks']:
  tid=row['track_id']
  if tid%3!=shard or tid in done:continue
  t=c.execute('select * from tracks where id=?',(tid,)).fetchone();result={**row,'stored_key':t['key_analyzed'],'embedded_key':t['key_text']}
  try:
   tick=time.perf_counter();a=decode(t['absolute_path'],22050);result['librosa_decode_seconds']=round(time.perf_counter()-tick,3)
   tick=time.perf_counter();result['librosa']=librosa_key(a);result['librosa']['seconds']=round(time.perf_counter()-tick,3)
   tick=time.perf_counter();a=decode(t['absolute_path'],44100);result['essentia_decode_seconds']=round(time.perf_counter()-tick,3)
   tick=time.perf_counter();key,scale,strength=es.KeyExtractor(sampleRate=44100)(a)
   result['essentia']={'key':key,'scale':scale,'camelot':camelot(key,scale),'strength':float(strength),'seconds':round(time.perf_counter()-tick,3)}
  except Exception as exc:result['error']=str(exc)
  results.append(result);output.write_text(json.dumps(results,indent=2,ensure_ascii=False))
  print(tid,'complete',len(results),flush=True)
if __name__=='__main__':
 if sys.argv[1]=='prepare':
  rows=list(csv.DictReader(SOURCE.open()));matched=[r for r in rows if r['djay_key']]
  ids=[int(r['track_id']) for r in matched];random.Random(20260921).shuffle(ids);dev=set(ids[:60])
  c=sqlite3.connect(DB.as_uri()+'?mode=ro',uri=True)
  tracks=[]
  for r in matched:
   tid=int(r['track_id']);path,album=c.execute('select absolute_path,album from tracks where id=?',(tid,)).fetchone();assert Path(path).is_file()
   tracks.append({**r,'track_id':tid,'album':album,'split':'development' if tid in dev else 'holdout'})
  assert len(tracks)==119 and len(set(ids))==119
  payload={'source_csv_sha256':hashlib.sha256(SOURCE.read_bytes()).hexdigest(),'window':'first 120 seconds of each file','seed':20260921,'tracks':tracks,'excluded':[r for r in rows if not r['djay_key']],'essentia_profile':es.KeyExtractor().paramValue('profileType'),'essentia_hpcp_size':es.KeyExtractor().paramValue('hpcpSize'),'reference':'djay estimates from copied DB; not human ground truth'}
  (OUT/'manifest.json').write_text(json.dumps(payload,indent=2,ensure_ascii=False));print('Frozen 119 tracks: 60 development / 59 holdout')
 else:run(int(sys.argv[1]))
