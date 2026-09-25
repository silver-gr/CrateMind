import {useEffect,useState} from 'react';
import {Button} from './ui/button';
import {Input} from './ui/input';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from './ui/dialog';
type Source={id:string;title:string;artist:string;recording_id:string;duration_ms:number;path?:string;versions:string[];asset?:{playable:boolean;audio_url:string}};
type Comparison={left_id:string;right_id:string;token:string;groups:Source[][];hard_blocks:string[];automatic_reasons:string[];metadata_choices:{recording_id:string;title:string;artist:string;state:string}[]};
async function request(path:string,body?:unknown){const r=await fetch('/api/identity/'+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined);const data=await r.json();if(!r.ok)throw Error(data.detail||'Αποτυχία');return data;}
export function IdentityLinker({entityId,targetId,onChanged}:{entityId:string;targetId?:string;onChanged:()=>void}){
 const [open,setOpen]=useState(false),[query,setQuery]=useState(''),[rows,setRows]=useState<Source[]>([]),[comparison,setComparison]=useState<Comparison|null>(null),[preferred,setPreferred]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{if(!open)return;let active=true;const timer=setTimeout(()=>{request('items?'+new URLSearchParams({q:query,mode:'recordings',limit:'30'})).then(r=>{if(active)setRows(r.items)}).catch(e=>{if(active)setError(e.message)})},200);return()=>{active=false;clearTimeout(timer)}},[query,open]);
 async function compare(id:string){setError('');setComparison(null);try{const c=await request('compare-identity?'+new URLSearchParams({left_id:entityId,right_id:id}));setComparison(c);setPreferred('')}catch(e){setError((e as Error).message)}}
 async function decide(accept:boolean){if(!comparison)return;setBusy(true);setError('');try{await request(accept?'confirm-identity':'reject-identity',{left_id:entityId,right_id:comparison.right_id,token:comparison.token,metadata_from:preferred});setOpen(false);onChanged()}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 return <><Button variant="outline" size="sm" onClick={()=>{setOpen(true);setError('');setComparison(null);if(targetId)void compare(targetId)}}>{targetId?'Σύγκριση ταυτότητας':'Σύνδεση με υπάρχουσα ηχογράφηση'}</Button>
 <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl"><DialogHeader><DialogTitle>Σύγκριση ηχογράφησης</DialogTitle><DialogDescription>Η σύνδεση αλλάζει μόνο τον κατάλογο CrateMind. Δεν αλλάζει αρχεία ή απομακρυσμένους λογαριασμούς.</DialogDescription></DialogHeader>
 {error&&<p role="alert" className="text-red-400">{error}</p>}
 {!comparison?<><Input aria-label="Αναζήτηση ηχογράφησης" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Τίτλος, καλλιτέχνης ή ID…"/>{rows.filter(r=>r.id!==entityId).map(r=><Button key={r.id} className="h-auto justify-start whitespace-normal" variant="outline" onClick={()=>compare(r.id)}>{r.artist} — {r.title}</Button>)}</>:<>
 <div className="grid gap-4 sm:grid-cols-2">{comparison.groups.map((group,i)=><section key={i} className="space-y-3 rounded border p-3">{group.map(s=><div key={s.id} className="space-y-1 text-sm"><strong>{s.artist} — {s.title}</strong><p className="break-all text-xs">{s.id}</p><p>{(s.duration_ms/1000).toFixed(2)} s · {s.versions.join(', ')||'Χωρίς ένδειξη έκδοσης'}</p>{s.path&&<p className="break-all text-xs">{s.path}</p>}{s.asset?.playable&&<audio controls preload="none" className="w-full" src={s.asset.audio_url}/>}</div>)}</section>)}</div>
 {comparison.automatic_reasons.map((r,i)=><p key={i} className="text-sm text-amber-400">{r}</p>)}
 {comparison.hard_blocks.map((r,i)=><p key={i} role="alert" className="text-sm text-red-400">{r}</p>)}
 <fieldset className="space-y-2"><legend>Ποια υπάρχοντα μεταδεδομένα να εμφανίζονται;</legend>{comparison.metadata_choices.map((m,i)=><label key={i} className="block text-sm"><input type="radio" name="metadata" value={m.recording_id} checked={preferred===m.recording_id} onChange={()=>setPreferred(m.recording_id)}/> {m.artist} — {m.title} ({m.state})</label>)}</fieldset>
 <p className="text-xs text-cm-muted">Οι προηγούμενες επιλογές μεταδεδομένων διατηρούνται στο ιστορικό.</p>
 <div className="flex flex-wrap gap-2"><Button disabled={busy||comparison.hard_blocks.length>0||!preferred} onClick={()=>decide(true)}>Ίδια ηχογράφηση · Σύνδεση</Button><Button variant="outline" disabled={busy} onClick={()=>decide(false)}>Δεν είναι η ίδια ηχογράφηση</Button></div>
 </>}
 </DialogContent></Dialog></>;
}
export function UndoIdentity({leftId,rightId,onChanged}:{leftId:string;rightId:string;onChanged:()=>void}){
 const [message,setMessage]=useState('');return <><Button variant="outline" size="sm" onClick={async()=>{try{const r=await request('undo-identity',{left_id:leftId,right_id:rightId});setMessage(r.still_connected?'Άλλη αποδεκτή διαδρομή κρατά την ομάδα συνδεδεμένη.':'Η σύνδεση αναιρέθηκε.');onChanged()}catch(e){setMessage((e as Error).message)}}}>Αναίρεση σύνδεσης</Button>{message&&<p className="text-xs">{message}</p>}</>;
}
