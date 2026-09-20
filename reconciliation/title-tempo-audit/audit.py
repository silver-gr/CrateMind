"""Read-only title tempo audit; title values are references, not ground truth."""
import csv,json,re,sqlite3,unicodedata
from pathlib import Path
from collections import Counter
from datetime import datetime,timezone
OUT=Path(__file__).resolve().parent
ROOT=OUT.parents[1]
NUMBER=r'\d{2,3}(?:\.\d+)?'
TOKEN=re.compile(rf'(?<![\w.])({NUMBER})(?![\d.]|[^\W\d_])',re.I)
EXPLICIT=re.compile(rf'(?<![\w.])({NUMBER})\s*bpm\b',re.I)
RANGE=re.compile(rf'(?<![\w.])({NUMBER})\s*(?:bpm\s*)?(?:[-–—~〜/]|\bto\b)\s*({NUMBER})(?:\s*bpm)?(?![\d.])',re.I)
BRACKET=re.compile(rf'[\[(]\s*({NUMBER})\s*(?:bpm)?\s*[\])]',re.I)
def parse(title):
 s=unicodedata.normalize('NFKC',title or '')
 ranges=[m.group() for m in RANGE.finditer(s) if all(60<=float(m.group(i))<=400 for i in [1,2])]
 if ranges:return 'range',None,ranges
 explicit=list(EXPLICIT.finditer(s));brackets=list(BRACKET.finditer(s))
 hits=explicit+brackets
 if not hits:
  if re.search(r'\btop\s+100\b|\d:\d|\d,\d{3}',s,re.I):
   return 'other_number',None,[]
  hits=list(TOKEN.finditer(s))
 vals=sorted({float(m.group(1)) for m in hits if 60<=float(m.group(1))<=400})
 if len(vals)>1:return 'ambiguous',None,[m.group() for m in hits]
 if len(vals)==1:return ('explicit' if explicit else 'bracketed' if brackets else 'bare'),vals[0],[m.group() for m in hits]
 return 'other_number',None,[]
def relation(ref,bpm):
 if not bpm:return 'no_analysis',None,None
 delta=bpm-ref;ratio=bpm/ref
 if abs(delta)<=1:kind='within_1_bpm'
 elif abs(bpm*2-ref)<=1:kind='half_time'
 elif abs(bpm/2-ref)<=1:kind='double_time'
 elif abs(delta)<=3:kind='near_1_to_3_bpm'
 elif abs(ratio-2/3)<=.006:kind='two_thirds'
 elif abs(ratio-3/2)<=.006:kind='three_halves'
 else:kind='other_mismatch'
 return kind,round(delta,3),round(ratio,5)
if __name__=='__main__':
 c=sqlite3.connect((ROOT/'backend/data/cratemind.sqlite').as_uri()+'?mode=ro',uri=True);c.row_factory=sqlite3.Row
 rows=[]
 for t in c.execute('select * from tracks order by id'):
  if not re.search(r'\d',t['title'] or ''):continue
  kind,ref,tokens=parse(t['title'])
  rel,delta,ratio=relation(ref,t['bpm_analyzed']) if ref else ('excluded',None,None)
  rows.append(dict(id=t['id'],artist=t['artist'],title=t['title'],title_type=kind,title_bpm=ref,matched_tokens=' | '.join(tokens),analyzed_bpm=t['bpm_analyzed'],delta_bpm=delta,ratio=ratio,relation=rel,method=t['bpm_analyzed_method'],analyzed_at=t['analyzed_at'],tag_bpm=t['bpm'],reccobeats_bpm=t['bpm_reccobeats'],consensus_bpm=t['bpm_consensus'],analysis_error=t['analysis_error'],outside_current_range=bool(ref and not 135<=ref<=286),at_search_boundary=t['bpm_analyzed'] in (135,250,286),missing=bool(t['missing']),absolute_path=t['absolute_path']))
 sets={'all_numbered_titles':rows,'tempo_candidates':[r for r in rows if r['title_bpm']], 'range_removal_review':[r for r in rows if r['title_type']=='range'],'ambiguous_numbers':[r for r in rows if r['title_type'] in ('ambiguous','other_number')]}
 sets['mismatches']=[r for r in sets['tempo_candidates'] if r['relation']!='within_1_bpm']
 for name,data in sets.items():
  with (OUT/(name+'.csv')).open('w') as f:
   w=csv.DictWriter(f,fieldnames=list(rows[0]));w.writeheader();w.writerows(data)
 summary={'created_at':datetime.now(timezone.utc).isoformat(),'catalog_total':c.execute('select count(*) from tracks').fetchone()[0],'numbered_titles':len(rows),'title_types':dict(Counter(r['title_type'] for r in rows)),'relations':dict(Counter(r['relation'] for r in sets['tempo_candidates'])),'strong_relations':dict(Counter(r['relation'] for r in rows if r['title_type'] in ('explicit','bracketed'))),'outside_current_range':sum(r['outside_current_range'] for r in sets['tempo_candidates'])}
 (OUT/'results.json').write_text(json.dumps({'summary':summary,**sets},ensure_ascii=False,indent=2))
 print(json.dumps(summary,indent=2))
 print('RANGES',json.dumps(sets['range_removal_review'],ensure_ascii=False))
 print('MISMATCHES',json.dumps([{k:r[k] for k in ('id','artist','title','title_type','title_bpm','analyzed_bpm','relation')} for r in sets['mismatches']],ensure_ascii=False))
