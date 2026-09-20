"""Exploratory second pass; reused holdout must not be called unseen validation."""
import sys,json,hashlib
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'refinement'))
import experiment as first
import numpy as np
import librosa
first.OUT=Path(__file__).parent
old_features=first.features
# Opposite of suppressing bass/percussion: retain raw energy and emphasize bass.
def features(audio,feature):
 if feature=='stft':return librosa.feature.chroma_stft(y=audio,sr=22050,n_fft=8192,hop_length=1024,norm=None,tuning=None)
 C=np.abs(librosa.cqt(y=audio,sr=22050,hop_length=512,n_bins=252,bins_per_octave=36,tuning=None))
 if feature=='bass':C=C[:108]
 return librosa.feature.chroma_cqt(C=C,sr=22050,bins_per_octave=36,n_octaves=C.shape[0]//36,norm=None)
first.features=features
first.LIB=[{'engine':'librosa','feature':f,'aggregation':a,'profile':p} for f in ('raw_cqt','bass','stft') for a in ('mean','median') for p in first.PROFILES]
first.ESS=[{'engine':'essentia','profileType':p,'hpcpSize':36,'frameSize':frame,'hopSize':4096,'minFrequency':freq,'pcpThreshold':threshold} for p in ('edmm','braw') for frame in (4096,8192) for freq in (25,100) for threshold in (.0,.2)]
def warmup():
 a=np.random.default_rng(7).normal(0,.01,22050*4).astype(np.float32)
 for f in ('raw_cqt','bass','stft'):features(a,f)
 first.base.librosa_key(a);first.es.KeyExtractor()(np.repeat(a,2))
first.warmup=warmup
if __name__=='__main__':
 if sys.argv[1]=='select':
  first.select()
  p=first.OUT/'selection.json';data=json.loads(p.read_text());data['v2_script_sha256']=hashlib.sha256(Path(__file__).read_bytes()).hexdigest();p.write_text(json.dumps(data,indent=2))
 else:first.run(sys.argv[1])
