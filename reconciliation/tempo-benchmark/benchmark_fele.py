"""Read-only tempo benchmark. Never updates the catalog or source audio."""
import json, time, subprocess, urllib.request
from pathlib import Path
import numpy as np
import librosa
import essentia.standard as es

OUT=Path(__file__).parent / "fele200"
OUT.mkdir(exist_ok=True)
SR=22050

def decode(path,start,seconds,sr):
    raw=subprocess.run(['ffmpeg','-v','error','-ss',str(start),'-i',path,'-t',str(seconds),'-ac','1','-ar',str(sr),'-f','f32le','-'],capture_output=True,check=True).stdout
    return np.frombuffer(raw,dtype=np.float32).copy()

def corrected(bpm):
    return round(bpm*2 if bpm<109 else bpm,2)

def refined(audio):
    hop=128
    onset=librosa.onset.onset_strength(y=audio,sr=SR,hop_length=hop)
    tempos=librosa.feature.tempo(onset_envelope=onset,sr=SR,hop_length=hop,aggregate=None)
    coarse=float(np.median(tempos))
    _,beats=librosa.beat.beat_track(onset_envelope=onset,sr=SR,hop_length=hop,bpm=coarse,trim=True)
    # Measure across 16 beat intervals, reducing individual frame quantization.
    times=librosa.frames_to_time(beats,sr=SR,hop_length=hop)
    spans=times[16:]-times[:-16]
    estimates=960/spans if len(spans) else np.array([])
    raw=float(np.median(estimates)) if len(estimates) else coarse
    return {'coarse_raw':round(coarse,5),'raw':round(raw,5),'bpm':corrected(raw),'beat_count':len(beats),'span_bpm_iqr':round(float(np.percentile(estimates,75)-np.percentile(estimates,25)),4) if len(estimates) else None}

results=[]
for tid,reference in [(i,200) for i in [1036,1058,1041]]:
    t=json.load(urllib.request.urlopen(f'http://localhost:5173/api/tracks/{tid}'))['track']
    row={'id':tid,'title':t['title'],'reference_bpm':reference,'stored_bpm':t['bpm_analyzed'],'stored_raw':t['bpm_analyzed_raw'],'stored_key':t['key_text'] or t['key_analyzed'],'segments':[]}
    print('START',tid,t['title'],flush=True)
    for start in [30,120,210]:
        segment={'start_seconds':start,'duration_seconds':60}
        audio=decode(t['absolute_path'],start,60,SR)
        tick=time.perf_counter();segment['librosa_refined']=refined(audio);segment['librosa_refined']['seconds']=round(time.perf_counter()-tick,3)
        audio44=decode(t['absolute_path'],start,60,44100)
        for method in ['degara','multifeature']:
            tick=time.perf_counter()
            bpm,beats,confidence,estimates,intervals=es.RhythmExtractor2013(method=method,minTempo=60,maxTempo=240)(audio44)
            segment['essentia_'+method]={'raw':round(float(bpm),5),'bpm':corrected(float(bpm)),'confidence':float(confidence) if method=='multifeature' else None,'seconds':round(time.perf_counter()-tick,3)}
        tick=time.perf_counter()
        key,scale,strength=es.KeyExtractor(sampleRate=44100)(audio44)
        segment['essentia_key']={'key':str(key),'scale':str(scale),'strength':float(strength),'seconds':round(time.perf_counter()-tick,3)}
        row['segments'].append(segment)
        print(json.dumps(segment),flush=True)
    for engine in ['librosa_refined','essentia_degara','essentia_multifeature']:
        values=[s[engine]['bpm'] for s in row['segments']]
        row[engine]={'median_bpm':round(float(np.median(values)),2),'error_vs_reference':round(float(np.median(values))-reference,2),'range_bpm':[min(values),max(values)]}
    values=[row[e]['median_bpm'] for e in ['librosa_refined','essentia_degara','essentia_multifeature']]
    row['engine_disagreement_bpm']=round(max(values)-min(values),2)
    row['review_required']=row['engine_disagreement_bpm']>1 or any(abs(v-reference)>1 for v in values)
    results.append(row)
    (OUT/'results.json').write_text(json.dumps(results,indent=2))
print('COMPLETE',flush=True)
