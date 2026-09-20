"""Read-only key experiments. Select on development before evaluating holdout.
Timing is sequential, warmed, includes all feature extraction, excludes decode.
"""
import sys,json,time,sqlite3,random,hashlib,platform
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import run as base
import numpy as np
import librosa
import essentia.standard as es
OUT=Path(__file__).parent
PROFILES={'ks':(base.KSMAJ,base.KSMIN),'temperley':(np.array([5,2,3.5,2,4.5,4,2,4.5,2,3.5,1.5,4]),np.array([5,2,3.5,4.5,2,4,2,4.5,3.5,2,1.5,4]))}
ESS=[{'engine':'essentia','profileType':p,'hpcpSize':n} for n in (12,36) for p in ('bgate','braw','edma','edmm','shaath','krumhansl','temperley')]
LIB=[{'engine':'librosa','feature':f,'aggregation':a,'profile':p} for f in ('cqt','harmonic_cqt','upper_cqt') for a in ('mean','median') for p in PROFILES]
def name(c):return ':'.join(str(v) for v in c.values())
def classify(chroma,c):
 vec=getattr(np,c['aggregation'])(chroma,axis=1)
 choices=[]
 for i in range(12):
  for scale,profile in zip(('major','minor'),PROFILES[c['profile']]):
   corr=float(np.corrcoef(np.roll(profile,i),vec)[0,1]);choices.append((corr,base.NOTES[i],scale))
 strength,key,scale=max(choices)
 return {'camelot':base.camelot(key,scale),'strength':strength}
def features(audio,feature):
 if feature=='cqt':return librosa.feature.chroma_cqt(y=audio,sr=22050,hop_length=512)
 # Suppress transient percussion in the CQT domain, or remove the two bass octaves.
 C=np.abs(librosa.cqt(y=audio,sr=22050,hop_length=512,n_bins=252,bins_per_octave=36,tuning=None))
 if feature=='harmonic_cqt':C=librosa.decompose.hpss(C,margin=2)[0]
 if feature=='upper_cqt':C=C[72:];fmin=librosa.note_to_hz('C3')
 else:fmin=librosa.note_to_hz('C1')
 return librosa.feature.chroma_cqt(C=C,sr=22050,fmin=fmin,bins_per_octave=36,n_octaves=C.shape[0]//36)
def estimate(audio,c):
 if c['engine']=='librosa':return classify(features(audio,c['feature']),c)
 key,scale,strength=es.KeyExtractor(sampleRate=44100,**{k:v for k,v in c.items() if k!='engine'})(audio)
 return {'camelot':base.camelot(key,scale),'strength':float(strength)}
def warmup():
 a=np.random.default_rng(7).normal(0,.01,22050*4).astype(np.float32)
 for f in ('cqt','harmonic_cqt','upper_cqt'):features(a,f)
 base.librosa_key(a);es.KeyExtractor()(np.repeat(a,2))
def run(split):
 manifest=json.loads((base.OUT/'manifest.json').read_text())
 if split=='development':configs=ESS+LIB
 else:configs=json.loads((OUT/'selection.json').read_text())['configs']
 path=OUT/(split+'.json');rows=json.loads(path.read_text()) if path.exists() else [];done={r['track_id'] for r in rows}
 conn=sqlite3.connect(base.DB.as_uri()+'?mode=ro',uri=True)
 warmup()
 for row in manifest['tracks']:
  if row['split']!=split or row['track_id'] in done:continue
  tid=row['track_id'];audio_path=conn.execute('select absolute_path from tracks where id=?',(tid,)).fetchone()[0]
  result={**row,'methods':{},'decode_seconds':{}}
  audios={}
  for sr in (22050,44100):
   t=time.perf_counter();audios[sr]=base.decode(audio_path,sr);result['decode_seconds'][str(sr)]=time.perf_counter()-t
  order=list(configs);random.Random(tid).shuffle(order)
  cache={}
  for c in order:
   t=time.perf_counter()
   if split=='development' and c['engine']=='librosa':
    f=c['feature']
    if f not in cache:
     ft=time.perf_counter();chroma=features(audios[22050],f);cache[f]=(chroma,time.perf_counter()-ft)
    ct=time.perf_counter();r=classify(cache[f][0],c);seconds=cache[f][1]+time.perf_counter()-ct
   else:r=estimate(audios[22050 if c['engine']=='librosa' else 44100],c);seconds=time.perf_counter()-t
   result['methods'][name(c)]={**r,'seconds':seconds}
  # Re-time both baselines in this same sequential warmed process.
  for engine in ('librosa','essentia'):
   t=time.perf_counter()
   r=base.librosa_key(audios[22050]) if engine=='librosa' else estimate(audios[44100],{'engine':'essentia','profileType':'bgate','hpcpSize':12})
   result['methods'][engine+':baseline']={**r,'seconds':time.perf_counter()-t}
  rows.append(result);path.write_text(json.dumps(rows,indent=2,ensure_ascii=False));print(split,tid,len(rows),flush=True)
def select():
 rows=json.loads((OUT/'development.json').read_text());assert len(rows)==60
 scores={name(c):sum(r['methods'][name(c)]['camelot']==r['djay_key'] for r in rows) for c in ESS+LIB}
 chosen=[]
 for bank in (LIB,ESS):
  # Stable predefined bank order breaks accuracy ties, never holdout performance.
  chosen.append(max(bank,key=lambda c:scores[name(c)]))
 payload={'configs':chosen,'development_exact':scores,'selection_rule':'Maximum development exact matches, ties use predefined bank order; no holdout selection','development_sha256':hashlib.sha256((OUT/'development.json').read_bytes()).hexdigest(),'script_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
 (OUT/'selection.json').write_text(json.dumps(payload,indent=2));print(json.dumps(payload,indent=2))
if __name__=='__main__':
 if sys.argv[1]=='select':select()
 else:run(sys.argv[1])
