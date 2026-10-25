import {collectionAccountLabel} from '../lib/collectionLabels';
import {invalidateCollectionOptions} from '../lib/collectionOptions';
import {useEffect,useState,useRef} from 'react';
import {toast} from 'sonner';
import {Button} from './ui/button';
import {Input} from './ui/input';
import {Choice,identityRequest} from './CompletenessControls';
import CollectionAlgebra from './CollectionAlgebra';

type Source={id:string;name:string;track_count:number;service:string;provenance_json:string};
type Group={id:string;ids:string[];hashes:Record<string,string>;sources:Source[];selected:string;state:string;potential_reduction:number;relationship_kind?:string};
type Position={position:number;title:string;artist:string;added_at:string;recording_id:string};
type Preview={ids:string[];selected:string;hashes:Record<string,string>;historical_only:(Position&{key:string;source_id:string})[];comparisons:{source_id:string;summary:{shared_positions:number;source_positions:number;destination_positions:number;exact_ordered:boolean;source_timestamp_days:Record<string,number>;destination_timestamp_days:Record<string,number>};positions:{classification:string;source:Position[];destination:Position[]}[]}[]};
type Decision={id:string;batch_id:string;status:string;mode:string;result:{representatives:string[]}};
type History={absorbed:boolean;representative_ids:string[];sources:Source[];decisions:Decision[]};
const route=(id:string,original=false)=>`/collections?id=${encodeURIComponent(id)}${original?'&original=1':''}`;
function context(s:Source){const p=JSON.parse(s.provenance_json);return `${s.service} · ${collectionAccountLabel(s.service,p.account,'')} · ${s.track_count} θέσεις · ${p.observed_at||'χωρίς ημερομηνία στιγμιότυπου'}${p.source_snapshot?.owner_username?' · '+p.source_snapshot.owner_username:''}`}

export function CollectionSources({id,onChanged,embedded=false,onCount}:{id:string;onChanged:()=>void;embedded?:boolean;onCount?:(count:number)=>void}){
 const [data,setData]=useState<History|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{let live=true;identityRequest<History>(`collections/history?id=${encodeURIComponent(id)}`).then(v=>{if(live){setData(v);onCount?.(v.sources.length)}}).catch(e=>{if(live)setError(e.message)});return()=>{live=false}},[id,onCount]);
 async function mutate(path:string,body:unknown){setBusy(true);try{const result=await identityRequest<{protected_native_edits?:string[]}>(path,body);invalidateCollectionOptions();if(result.protected_native_edits?.length)toast.info('Διατηρήθηκαν οι μεταγενέστερες αλλαγές του αντιπροσώπου. Η επεξεργασμένη συλλογή παραμένει ενεργή.');setData(await identityRequest<History>(`collections/history?id=${encodeURIComponent(id)}`));onChanged()}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 const Container=embedded?'div':'details';
 if(!data)return error?<p role="alert">{error}</p>:<p className="text-sm text-cm-muted">Φόρτωση πηγών…</p>;
 return <section className="space-y-2 rounded-lg border border-cyan-500/20 p-3">
 {data.absorbed&&<p className="text-sm">Αρχική παρατήρηση — εκπροσωπείται στην καθημερινή βιβλιοθήκη από: {data.representative_ids.map(r=><a className="mr-3 text-cm-cyan underline" key={r} href={route(r)}>Άνοιγμα αντιπροσώπου</a>)}</p>}
 <Container>{!embedded&&<summary className="cursor-pointer">Πηγές & ιστορικό ({data.sources.length})</summary>}<p className="my-2 text-xs text-cm-muted">Οι αρχικές θέσεις διατηρούνται. Η εκπροσώπηση δεν αλλάζει τις ιστορικές σχέσεις ή τις ταυτότητες κομματιών.</p>
 {data.sources.map(s=><div className="my-2 border-t border-cm-line/20 pt-2" key={s.id}><a className="text-cm-cyan underline" href={route(s.id,true)}>{s.name}</a><p className="text-xs text-cm-muted">{context(s)}</p><details className="text-xs text-cm-muted"><summary>Αρχικά ονόματα, σημειώσεις & στοιχεία πηγής</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap">{JSON.stringify(JSON.parse(s.provenance_json),(key,value)=>key==='account'?collectionAccountLabel(s.service,value,''):value,2)}</pre></details><Button size="sm" variant="outline" disabled={busy} onClick={()=>mutate('collections/consolidation/restore',{id:s.id})}>Επαναφορά ως ξεχωριστή</Button></div>)}
 {data.decisions.filter(d=>d.status==='active').map(d=><div key={d.id} className="flex flex-wrap gap-2 py-2"><Button size="sm" variant="outline" disabled={busy} onClick={()=>mutate('collections/consolidation/undo',{decision_id:d.id})}>Αναίρεση ενοποίησης</Button>{d.mode==='automatic'&&<Button size="sm" variant="outline" disabled={busy} onClick={()=>mutate('collections/consolidation/undo',{batch_id:d.batch_id})}>Αναίρεση αυτόματης παρτίδας</Button>}</div>)}
 </Container>{error&&<p role="alert">{error}</p>}</section>
}

function DecisionCardContent({group,onChanged}:{group:Group;onChanged:()=>void}){
 const [ids,setIds]=useState(group.ids),[sources,setSources]=useState(group.sources),[selected,setSelected]=useState(group.selected),[preview,setPreview]=useState<Preview|null>(null),[ack,setAck]=useState(false),[order,setOrder]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const comparisonKey=useRef('');comparisonKey.current=JSON.stringify([ids,selected]);
 useEffect(()=>{setPreview(null);setAck(false);setOrder(false)},[ids,selected]);
 async function load(){const key=comparisonKey.current;setBusy(true);setError('');try{const value=await identityRequest<Preview>('collections/consolidation/preview',{ids,selected});if(key===comparisonKey.current)setPreview(value)}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 async function decide(action:string){setBusy(true);setError('');try{await identityRequest('collections/consolidation/decision',{ids,hashes:preview?.hashes||group.hashes,action,selected,acknowledged:ack?preview?.historical_only.map(p=>p.key):[]});invalidateCollectionOptions();onChanged()}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 const sameChoice=group.relationship_kind==='exact'&&sources.every(source=>source.name===sources[0].name&&source.service===sources[0].service&&source.track_count===sources[0].track_count);
 async function combined(id:string){const s=await identityRequest<Source>(`collection?id=${encodeURIComponent(id)}`);setSources(v=>[...v,{...s,provenance_json:'{}'}]);setIds(v=>[...v,id]);setSelected(id)}
 return <article className="mt-3 space-y-3"><p className="text-xs text-cm-muted">{{needs_review:'Για έλεγχο',kept_separate:'Ξεχωριστές',defer:'Αργότερα'}[group.state]||group.state} · έως {ids.length-1} λιγότερες καθημερινές εγγραφές. </p>
 <ul>{sources.map(s=><li key={s.id} className="my-2 text-sm"><a href={route(s.id,true)} className="text-cm-cyan underline">{s.name}</a><p className="text-xs text-cm-muted">{context(s)}</p><details className="text-xs text-cm-muted"><summary>Αρχικά ονόματα, σημειώσεις & στοιχεία πηγής</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap">{JSON.stringify(JSON.parse(s.provenance_json),(key,value)=>key==='account'?collectionAccountLabel(s.service,value,''):value,2)}</pre></details></li>)}</ul>
 <>{sameChoice?<p className="text-sm text-cm-muted">Ίδιο περιεχόμενο και σειρά σε όλες τις πηγές.</p>:<Choice label="Περιεχόμενο & σειρά αντιπροσώπου" value={selected} onChange={setSelected} options={Object.fromEntries(sources.map(s=>[s.id,`${s.name} · ${s.service} · ${s.track_count}`]))}/>}</>
 <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={load}>Σύγκριση επιλογής</Button><Button variant="outline" disabled={busy} onClick={()=>decide('keep_separate')}>Διατήρηση όλων ξεχωριστά</Button><Button variant="ghost" disabled={busy} onClick={()=>decide('defer')}>Αργότερα</Button></div>
 {preview&&<><p className="text-xs text-amber-200">Ελέγξτε τις διαφορές πριν επιλέξετε περιεχόμενο και σειρά.</p>{preview.comparisons.map(c=><details key={c.source_id}><summary>{sources.find(s=>s.id===c.source_id)?.name} · {c.summary.shared_positions} κοινές θέσεις · {c.summary.exact_ordered?'ίδια σειρά':'διαφορές περιεχομένου / σειράς'}</summary><p className="my-2 text-xs text-cm-muted">Ημέρες προσθήκης στην πηγή: {JSON.stringify(c.summary.source_timestamp_days)} · στην επιλογή: {JSON.stringify(c.summary.destination_timestamp_days)}</p><div className="max-h-72 overflow-y-auto">{c.positions.map((d,i)=><div key={i} className="my-2 text-xs"><strong>{d.classification}</strong>{d.source.map(p=><p key={'s'+p.position}>Πηγή #{p.position+1}: {p.artist||'Άγνωστος καλλιτέχνης'} — <a className="text-cm-cyan underline" href={`/canonical?id=${encodeURIComponent(p.recording_id)}`}>{p.title||p.recording_id}</a> · {p.added_at||'χωρίς ημερομηνία'}</p>)}{d.destination.map(p=><p key={'d'+p.position}>Επιλογή #{p.position+1}: {p.artist||'Άγνωστος καλλιτέχνης'} — <a className="text-cm-cyan underline" href={`/canonical?id=${encodeURIComponent(p.recording_id)}`}>{p.title||p.recording_id}</a> · {p.added_at||'χωρίς ημερομηνία'}</p>)}</div>)}</div></details>)}
 {preview.historical_only.length>0&&<label className="block text-sm"><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/> Αναγνωρίζω ότι οι {preview.historical_only.length} μη εκπροσωπούμενες θέσεις που φαίνονται στις διαφορές θα μείνουν μόνο στο αρχικό ιστορικό.</label>}
 <label className="block text-sm"><input type="checkbox" checked={order} onChange={e=>setOrder(e.target.checked)}/> Εγκρίνω το επιλεγμένο περιεχόμενο, τη σειρά και τις επαναλήψεις ως την καθημερινή συλλογή.</label>
 <Button disabled={busy||!order||(preview.historical_only.length>0&&!ack)} onClick={()=>decide('representative')}>Χρήση ως αντιπροσώπου</Button></>}
 <CollectionAlgebra left={selected} onSaved={combined}/><p className="text-xs text-cm-muted">Για συνδυασμό, αποθηκεύστε νέα συλλογή από τις πράξεις και συγκρίνετέ την.</p>
 {error&&<p role="alert">{error}</p>}</article>
}

function ConsolidationReviewContent({onChanged}:{onChanged:()=>void}){
 const [groups,setGroups]=useState<Group[]>([]),[revision,setRevision]=useState(0),[offset,setOffset]=useState(0),[filter,setFilter]=useState('needs_review'),[error,setError]=useState('');
 useEffect(()=>{let active=true;identityRequest<{groups:Group[]}>('collections/consolidation').then(v=>{if(active)setGroups(v.groups)}).catch(e=>{if(active)setError(e.message)});return()=>{active=false}},[revision]);
 const [query,setQuery]=useState('');
 const filtered=groups.filter(g=>(filter==='all'||g.state===filter)&&g.sources.some(s=>s.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())));
 return <div className="mt-3 space-y-3"><p className="text-sm text-cm-muted">{groups.filter(g=>g.state==='needs_review').length} ομάδες με κοινό περιεχόμενο. Ανοίξτε μία για σύγκριση.</p><Input aria-label="Αναζήτηση ομάδων ενοποίησης" placeholder="π.χ. freeyourmind, Psytech" value={query} onChange={e=>{setQuery(e.target.value);setOffset(0)}}/><Choice label="Κατάσταση απόφασης" value={filter} onChange={v=>{setFilter(v);setOffset(0)}} options={{needs_review:'Για έλεγχο',defer:'Αργότερα',kept_separate:'Ξεχωριστές',all:'Όλες'}}/>{error&&<p role="alert">{error}</p>}{filtered.slice(offset,offset+5).map(g=><DecisionCard key={`${g.id}:${revision}`} group={g} onChanged={()=>{setRevision(v=>v+1);onChanged()}}/>)}<Button variant="ghost" disabled={!offset} onClick={()=>setOffset(v=>v-5)}>Προηγούμενες</Button><Button variant="ghost" disabled={offset+5>=filtered.length} onClick={()=>setOffset(v=>v+5)}>Επόμενες</Button></div>
}


const relationshipLabels:Record<string,string>={exact:'Ίδιο περιεχόμενο και σειρά',subset:'Σχετικές παραλλαγές',overlap:'Κοινά κομμάτια'};
function DecisionCard({group,onChanged}:{group:Group;onChanged:()=>void}) {
 const [open,setOpen]=useState(false);
 return <details className="border-t border-cm-line/20 py-3" onToggle={event=>setOpen(event.currentTarget.open)}><summary className="cursor-pointer text-sm"><span className="font-medium">{group.sources[0].name}</span><span className="ml-3 text-cm-muted">{group.ids.length} συλλογές · {relationshipLabels[group.relationship_kind||'overlap']}</span></summary>{open&&<DecisionCardContent group={group} onChanged={onChanged}/>}</details>;
}

export function ConsolidationReview({onChanged}:{onChanged:()=>void}) {
 const [open,setOpen]=useState(false);
 return <details className="rounded-xl border border-cm-line/20 p-4" onToggle={event=>setOpen(event.currentTarget.open)}><summary className="cursor-pointer font-medium">Έλεγχος παρόμοιων συλλογών</summary>{open&&<ConsolidationReviewContent onChanged={onChanged}/>}</details>;
}
