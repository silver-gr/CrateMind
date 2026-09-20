"""Freeze a deterministic title-derived sample before running any analyzers."""
import json,re,random
from pathlib import Path
from collections import Counter
import urllib.request
out=Path(__file__).parent/'title100';out.mkdir(exist_ok=True)
rows=[]
while True:
 batch=json.load(urllib.request.urlopen(f'http://localhost:5173/api/tracks?limit=5000&offset={len(rows)}'))
 rows.extend(batch)
 if len(batch)<5000:break
# Unicode word boundary rejects attached letters/digits/underscore; reject decimals.
pattern=re.compile(r'(?<![\w.])(?:(?P<explicit>\d{3})\s*BPM\b|\(\s*(?P<paren>\d{3})\s*\)|\[\s*(?P<bracket>\d{3})\s*\])',re.I)
accepted=[];held=[];seen=set()
for t in sorted(rows,key=lambda t:t['id']):
 title=t['title'] or ''
 matches=list(pattern.finditer(title))
 if not matches:
  if re.search(r'\d{3}',title):held.append({'id':t['id'],'title':title,'reason':'No unambiguous standalone BPM suffix or bracketed three-digit token'})
  continue
 vals={int(m.group('explicit') or m.group('paren') or m.group('bracket')) for m in matches}
 reason=None
 if len(vals)!=1:reason='Conflicting title tempos'
 elif not 135<=next(iter(vals))<=250:reason='Outside 135–250 BPM psytrance benchmark range; held for review'
 elif t['missing'] or not Path(t['absolute_path']).is_file():reason='Audio unavailable'
 elif not t['duration'] or t['duration']<270:reason='Too short for the fixed three-section protocol'
 key=((t['artist'] or '').casefold(),title.casefold())
 if key in seen:reason='Duplicate artist/title'
 if reason:held.append({'id':t['id'],'title':title,'reason':reason});continue
 seen.add(key)
 accepted.append({'id':t['id'],'title':title,'artist':t['artist'],'reference_bpm':next(iter(vals)),'matched_text':[m.group() for m in matches]})
assert len(accepted)>=100,len(accepted)
sample=random.Random(20260919).sample(accepted,100)
(out/'selection.json').write_text(json.dumps({'seed':20260919,'eligible_count':len(accepted),'selection':sample,'held':held},indent=2,ensure_ascii=False))
print('eligible',len(accepted),'sample',len(sample),'tempo range',min(t['reference_bpm'] for t in sample),max(t['reference_bpm'] for t in sample))
print(Counter(t['reference_bpm'] for t in sample))
# Boundary regression checks before trusting title references.
for title in ['Song [193]','Song (190)','Song (210BPM)','Song 200 BPM','Song [200 BPM]']:
 assert pattern.search(title),title
for title in ['ArtistX200BPM','Song A200 BPM','Song 200.5 BPM','Song 1200 BPM','Song 200']:
 assert not pattern.search(title),title
print('Title parser boundary checks passed')
