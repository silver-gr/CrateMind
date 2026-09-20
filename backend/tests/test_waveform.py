import json, shutil, wave
import numpy as np
import pytest
from app.services import waveform as wf
pytestmark=pytest.mark.skipif(not shutil.which('ffmpeg'),reason='ffmpeg required')
def audio(path,samples):
 with wave.open(str(path),'wb') as w:
  w.setnchannels(2);w.setsampwidth(2);w.setframerate(wf.RATE)
  w.writeframes((np.clip(samples,-1,1)*32767).astype('<i2').tobytes())
@pytest.fixture
def cache(tmp_path,monkeypatch):
 target=tmp_path/'cache';target.mkdir();monkeypatch.setattr(wf,'_cache_dir',lambda:target);return target

def test_high_frequencies_phase_silence_and_last_sample(tmp_path,cache):
 # Old 1kHz mono decoding suppresses 8kHz and cancels inverted stereo.
 n=wf.WINDOW*8;t=np.arange(n)/wf.RATE;tone=.7*np.sin(2*np.pi*8000*t)
 samples=np.zeros((n*3+1,2));samples[:n]=np.column_stack([tone,-tone]);samples[-1]=[.95,-.95]
 path=tmp_path/'signal.wav';audio(path,samples);r=wf.get_or_compute_waveform(1,str(path))
 assert r['sample_frames']==len(samples)
 assert r['duration']==pytest.approx(len(samples)/wf.RATE)
 assert min(r['peaks'][:8])>.69
 assert np.mean(r['rms'][:8])==pytest.approx(.7/np.sqrt(2),abs=.002)
 assert r['peaks'][8:24]==r['rms'][8:24]==[0]*16
 assert r['peaks'][-1]>.94 and r['rms'][-1]>.94

def test_reduction_keeps_transient_separate_from_rms(tmp_path,cache,monkeypatch):
 monkeypatch.setattr(wf,'MAX_POINTS',16)
 samples=np.zeros((wf.WINDOW*40+7,2));samples[-1]=[1,-1]
 path=tmp_path/'impulse.wav';audio(path,samples);r=wf.get_or_compute_waveform(2,str(path))
 assert len(r['peaks'])==16 and r['peaks'][-1]>.99
 assert 0<r['rms'][-1]<.1 and r['peaks'][:-1]==[0]*15

def test_cache_hit_file_change_corruption_and_deletion(tmp_path,cache,monkeypatch):
 path=tmp_path/'cached.wav';audio(path,np.full((4096,2),.25))
 original=wf._decode;calls=[]
 def count(*a):calls.append(1);return original(*a)
 monkeypatch.setattr(wf,'_decode',count)
 a=wf.get_or_compute_waveform(3,str(path))
 assert wf.get_or_compute_waveform(3,str(path))==a and len(calls)==1
 audio(path,np.full((4097,2),.75));b=wf.get_or_compute_waveform(3,str(path))
 assert b['peaks'][0]>.74 and len(calls)==2
 (cache/'3-v2.json').write_text('{corrupt')
 assert wf.get_or_compute_waveform(3,str(path))==b and len(calls)==3
 path.unlink()
 assert wf.get_or_compute_waveform(3,str(path))['peaks']==[] and len(calls)==3

def test_old_cache_ignored_and_silence_stays_zero(tmp_path,cache):
 path=tmp_path/'silence.wav';audio(path,np.zeros((4096,2)))
 (cache/'4.json').write_text(json.dumps([1]*160))
 r=wf.get_or_compute_waveform(4,str(path))
 assert r['version']==2 and r['peaks']==[0]*4
