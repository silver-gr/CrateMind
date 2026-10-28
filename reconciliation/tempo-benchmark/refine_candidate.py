"""Experimental multi-lag onset periodicity estimator; no reference BPM input."""

# Archived experiment: fail closed before any old path or audio side effect.
import sys as _dataset_sys
from pathlib import Path as _DatasetPath
_dataset_sys.path.insert(0, str(next(parent for parent in _DatasetPath(__file__).resolve().parents if (parent / "backend/app").is_dir()) / "backend"))
from app.services.writer_context import reject_legacy_script
reject_legacy_script(_DatasetPath(__file__))
import numpy as np
import librosa
from scipy.signal import fftconvolve, find_peaks

def estimate(audio,sr=22050):
 hop=128
 env=librosa.onset.onset_strength(y=audio,sr=sr,hop_length=hop)
 env=np.maximum(env-np.median(env),0)
 env=np.minimum(env,np.percentile(env,99))
 ac=fftconvolve(env,env[::-1],mode='full')[len(env)-1:]
 ac=ac/np.maximum(1,np.arange(len(env),0,-1))
 ac=ac/max(float(ac[0]),1e-12)
 grid=np.arange(135,250.001,.02)
 periods=60*sr/(hop*grid)
 # Evidence over many beats resolves frame quantization without trusting beat picks.
 scores=np.zeros(len(grid))
 for multiple in range(1,25):
  lag=periods*multiple
  scores+=np.interp(lag,np.arange(len(ac)),ac)/np.sqrt(multiple)
 idx=int(np.argmax(scores))
 return {'bpm':round(float(grid[idx]),2),'score':float(scores[idx]),'method':'librosa-onset-multilag-v2-experimental'}
