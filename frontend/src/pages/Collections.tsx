import { CatalogLoading } from "../components/ui/CatalogLoading";
import {collectionOriginLabel} from '../lib/collectionLabels';
import {invalidateCollectionOptions} from '../lib/collectionOptions';
import {Tabs,TabsList,TabsTrigger,TabsContent} from '../components/ui/tabs';
import {usePlayer} from '../lib/player';
import {api} from '../lib/api';
import {Play} from '../lib/icons';
import {CollectionSources,ConsolidationReview} from '../components/CollectionConsolidation';
import {CollectionLineagePanel} from './CollectionProvenance';
import CollectionAlgebra from '../components/CollectionAlgebra';
import {Choice,ProviderCounts,type Recording} from '../components/CompletenessControls';
import { useEffect,useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Select,SelectTrigger,SelectValue,SelectContent,SelectItem } from '../components/ui/select';
import { Dialog,DialogContent,DialogTitle,DialogDescription,DialogHeader } from '../components/ui/dialog';

type Availability={playable_local:number;remote_only:number;local_unavailable:number;unresolved?:number};
type Collection={aliases?:string[];source_services?:string[];source_accounts?:string[];related_variants?:Collection[];relationship_kind?:string;id:string;name:string;service:string;kind:string;track_count:number;editable:boolean;availability:Availability;provenance:{account?:string;origin_collection?:string;relationships?:string[]}};
type Entry={collection_family_count:number;raw_collection_occurrences:number;collection_count:number;unique_to_collection:boolean;providers:Recording['providers'];position:number;id:string;recording_id:string;title:string;artist:string;source_title:string;source_artist:string;service:string;permalink:string;availability:string;local_assets:{local_track_id:number;playable:boolean;audio_url:string|null}[]};
type Detail=Collection&{entries:Entry[]};
const PAGE_SIZE=100;
const sources:Record<string,string>={cratemind:'CrateMind',spotify:'Spotify',soundcloud:'SoundCloud'};
const availability:Record<string,string>={playable_local:'Διαθέσιμο τοπικά',remote_only:'Μόνο στην πηγή',local_unavailable:'Τοπικό αρχείο μη διαθέσιμο'};
async function request<T>(path:string,body?:unknown):Promise<T>{const r=await fetch(`/api/identity/${path}`,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined);if(!r.ok){const err=await r.json();throw Error(err.detail||'Αποτυχία φόρτωσης')}return r.json()}
function CollectionListRow({collection:c,selected,onSelect}:{collection:Collection;selected:string;onSelect:(id:string)=>void}) {
 const variants=c.related_variants||[];
 const active=c.id===selected||variants.some(variant=>variant.id===selected);
 return <li><Button variant="ghost" title={c.name} className={`h-auto min-h-12 w-full justify-start gap-3 rounded-none px-3 py-2 text-left ${active?'bg-cm-line/10':''}`} onClick={()=>onSelect(c.id)}><span className="min-w-0 flex-1"><span className="block truncate font-medium">{c.name}</span><span className="block truncate text-xs font-normal text-cm-muted">{collectionOriginLabel(c)}</span></span><span className="shrink-0 text-right text-xs font-normal tabular-nums"><span className="block">{c.track_count} θέσεις</span><span className="text-cm-chartreuse">{c.availability.playable_local} τοπικά</span><span className="text-cm-muted"> · {c.availability.remote_only} στην πηγή</span>{c.availability.local_unavailable>0&&<span className="block text-cm-muted">{c.availability.local_unavailable} μη διαθέσιμα</span>}</span></Button>{variants.length>0&&<details className="px-3 pb-2" open={variants.some(variant=>variant.id===selected)||undefined}><summary className="cursor-pointer text-xs text-cm-cyan">{variants.length+1} σχετικές συλλογές · {c.relationship_kind==='exact'?'ίδιο περιεχόμενο και σειρά':c.relationship_kind==='subset'?'διαφορές στη σειρά ή στις προσθήκες':'κοινά κομμάτια'}</summary><ul className="mt-2 divide-y divide-cm-line/20 rounded border border-cm-line/20">{variants.map(variant=><CollectionListRow key={variant.id} collection={variant} selected={selected} onSelect={onSelect}/>)}</ul></details>}</li>;
}

export default function Collections(){
 const {play}=usePlayer();
 const [sourceCount,setSourceCount]=useState<number|null>(null),[lineageCount,setLineageCount]=useState<number|null>(null);
 const [loadingTrack,setLoadingTrack]=useState<number|null>(null);
 async function playLocal(id:number){setLoadingTrack(id);setError('');try{const result=await api.getTrack(id);play(result.track)}catch(e){setError((e as Error).message)}finally{setLoadingTrack(null)}}
 const [entryFilter,setEntryFilter]=useState(''),[unique,setUnique]=useState(false);
 const [params,setParams]=useSearchParams();const selected=params.get('id')||'';const original=params.get('original')==='1';const [allSources,setAllSources]=useState(params.get('all_sources')==='true');
 const [groupRelated,setGroupRelated]=useState(true);
 const [q,setQ]=useState(''),[service,setService]=useState('all'),[offset,setOffset]=useState(0),[revision,setRevision]=useState(0);
 const [rows,setRows]=useState<{items:Collection[];total:number;collection_total?:number}>({items:[],total:0}),[detail,setDetail]=useState<Detail|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [listLoading,setListLoading]=useState(true),[detailLoading,setDetailLoading]=useState(false);
 const [open,setOpen]=useState(false),[name,setName]=useState(''),[copy,setCopy]=useState<string|null>(null),[trackQuery,setTrackQuery]=useState(''),[tracks,setTracks]=useState<{id:string;title:string;artist:string}[]>([]);
 useEffect(()=>{let active=true;setListLoading(true);const timer=setTimeout(()=>request<typeof rows>(`collection-browser?${new URLSearchParams({q,service:service==='all'?'':service,offset:String(offset),all_sources:String(allSources),grouped:String(groupRelated)})}`).then(v=>{if(active)setRows(v)}).catch(e=>{if(active)setError(e.message)}).finally(()=>{if(active)setListLoading(false)}),180);return()=>{active=false;clearTimeout(timer)}},[q,service,offset,revision,allSources,groupRelated]);
 useEffect(()=>{let active=true;setDetail(null);setDetailLoading(Boolean(selected));if(selected)request<Detail>(`collection?id=${encodeURIComponent(selected)}&original=${original}`).then(v=>{if(active)setDetail(v)}).catch(e=>{if(active)setError(e.message)}).finally(()=>{if(active)setDetailLoading(false)});return()=>{active=false}},[selected,revision,original]);
 useEffect(()=>{setEntryFilter('');setUnique(false);setSourceCount(null);setLineageCount(null)},[selected]);
 useEffect(()=>{let active=true;setTracks([]);if(!detail?.editable||!trackQuery.trim())return;const timer=setTimeout(()=>request<{items:typeof tracks}>(`items?limit=10&q=${encodeURIComponent(trackQuery)}`).then(v=>{if(active)setTracks(v.items)}).catch(e=>{if(active)setError(e.message)}),200);return()=>{active=false;clearTimeout(timer)}},[trackQuery,detail?.editable]);
 async function create(){setBusy(true);setError('');try{const c=await request<Detail>('collections/native',{name,source_id:copy});invalidateCollectionOptions();setParams({id:c.id});setOpen(false);setRevision(v=>v+1)}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 async function add(id:string){if(!detail)return;setBusy(true);try{await request(`collections/native/${encodeURIComponent(detail.id)}/entries`,{entity_ids:[id]});invalidateCollectionOptions();setTrackQuery('');setRevision(v=>v+1)}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 const groups=Array.from(rows.items.reduce((map,c)=>{const label=collectionOriginLabel(c);const group=map.get(label)||{label,items:[] as Collection[]};group.items.push(c);map.set(label,group);return map},new Map<string,{label:string;items:Collection[]}>()).values());
 const changed=()=>setRevision(value=>value+1);
 return <div className="h-full space-y-5 overflow-y-auto p-6 text-cm-text"><header className="flex flex-wrap justify-between gap-3"><div><h1 className="text-2xl font-semibold">Συλλογές</h1><p className="mt-2 text-sm text-cm-muted">Playlists και Likes, με την αρχική σειρά και τις πηγές τους.</p></div><Button onClick={()=>{setName('');setCopy(null);setOpen(true)}}>Νέα συλλογή CrateMind</Button></header>
 {error&&<p role="alert" className="text-rose-300">{error}</p>}
 <ConsolidationReview onChanged={changed}/>
 <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={allSources} onChange={e=>{setAllSources(e.target.checked);setOffset(0)}}/>Όλες οι αρχικές παρατηρήσεις (ιστορικό)</label>{!allSources&&<label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={groupRelated} onChange={event=>{setGroupRelated(event.target.checked);setOffset(0)}}/>Σχετικές παραλλαγές στην ίδια γραμμή</label>}
 <div className="flex flex-wrap gap-3"><Input aria-label="Αναζήτηση συλλογών" value={q} onChange={e=>{setQ(e.target.value);setOffset(0)}} placeholder="Αναζήτηση συλλογής…" className="min-w-52 flex-1"/><Select value={service} onValueChange={v=>{setService(v);setOffset(0)}}><SelectTrigger aria-label="Πηγή συλλογών"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="all">Όλες οι πηγές</SelectItem>{Object.entries(sources).map(([id,label])=><SelectItem key={id} value={id}>{label}</SelectItem>)}</SelectContent></Select></div>
 <div className="grid items-start gap-5 xl:grid-cols-2"><section aria-label="Λίστα συλλογών" className="min-w-0 rounded-xl border border-cm-line/20"><div className="flex flex-wrap items-center justify-between gap-2 p-3 text-xs"><span>{listLoading?"Φόρτωση συλλογών…":`${rows.total} εγγραφές${rows.collection_total&&rows.collection_total!==rows.total?` από ${rows.collection_total} συλλογές`:""} · ${rows.total?offset+1:0}–${Math.min(offset+PAGE_SIZE,rows.total)}`}</span><div><Button size="sm" variant="ghost" disabled={listLoading||!offset} onClick={()=>setOffset(v=>Math.max(0,v-PAGE_SIZE))}>Προηγούμενα</Button><Button size="sm" variant="ghost" disabled={listLoading||offset+PAGE_SIZE>=rows.total} onClick={()=>setOffset(v=>v+PAGE_SIZE)}>Επόμενα</Button></div></div><div className="overflow-x-auto" aria-busy={listLoading}>{listLoading?<CatalogLoading title="Φόρτωση συλλογών…" description="Ανάκτηση συλλογών και τοπικής διαθεσιμότητας…"/>:groups.map(group=><section key={group.label} aria-label={group.label}><h2 className="border-y border-cm-line/20 bg-cm-panel px-3 py-2 text-xs font-semibold text-cm-cyan">{group.label}</h2><ul className="divide-y divide-cm-line/20">{group.items.map(c=><CollectionListRow key={c.id} collection={c} selected={selected} onSelect={id=>setParams(allSources?{id,original:'1'}:{id})}/>)}</ul></section>)}</div></section>
 <section className="min-w-0 space-y-4 rounded-xl border border-cm-line/20 p-4">{detailLoading?<CatalogLoading title="Φόρτωση συλλογής…" description="Ανάκτηση κομματιών και προέλευσης…"/>:!detail?<p className="text-cm-muted">Επιλέξτε συλλογή για περιεχόμενα και τοπική διαθεσιμότητα.</p>:<><header><h2 className="text-xl">{detail.name}</h2><p className="mt-1 text-xs text-cm-muted">{collectionOriginLabel(detail)} · {detail.editable?'Επεξεργάσιμη στο CrateMind':'Αμετάβλητο στιγμιότυπο πηγής'}</p><p className="mt-2 text-sm">{detail.availability.playable_local}/{detail.entries.length} διαθέσιμα τοπικά · {detail.availability.remote_only} μόνο στην πηγή · {detail.availability.local_unavailable} λείπουν αρχεία · {detail.availability.unresolved||0} ανεπίλυτες</p><p className="mt-1 text-xs text-cm-muted">{detail.provenance.relationships?.join(' · ')}</p></header>
 <Tabs key={selected} defaultValue="tracks" className="gap-0 overflow-hidden rounded-lg border border-cm-line/20"><TabsList className="!h-auto w-full flex-wrap justify-start gap-1 rounded-none border-b border-cm-line/20 bg-transparent p-2" aria-label="Πληροφορίες συλλογής"><TabsTrigger value="tracks" className="flex-none text-xs">Κομμάτια ({detail.entries.length})</TabsTrigger><TabsTrigger value="sources" className="flex-none text-xs">Πηγές & ιστορικό{sourceCount!==null?` (${sourceCount})`:''}</TabsTrigger><TabsTrigger value="lineage" className="flex-none text-xs">Προέλευση συλλογής{lineageCount!==null?` (${lineageCount})`:''}</TabsTrigger><TabsTrigger value="compare" className="flex-none text-xs">Σύγκριση & πράξεις συλλογών</TabsTrigger></TabsList>
 <TabsContent value="sources" className="bg-[var(--muted)] p-4 data-[state=inactive]:hidden"><CollectionSources key={`${selected}:${revision}`} embedded onCount={setSourceCount} id={selected||detail.id} onChanged={changed}/></TabsContent>
 <TabsContent value="lineage" className="bg-[var(--muted)] p-4 data-[state=inactive]:hidden"><CollectionLineagePanel embedded onCount={setLineageCount} id={detail.id}/></TabsContent>
 <TabsContent value="compare" className="bg-[var(--muted)] p-4"><CollectionAlgebra embedded left={detail.id} onSaved={id=>{setParams({id});changed()}}/></TabsContent>
 <TabsContent value="tracks" className="space-y-4 bg-[var(--muted)] p-4">
 <div className="flex flex-wrap gap-2"><Choice label="Διαθεσιμότητα θέσεων" value={entryFilter} onChange={setEntryFilter} options={{'':`Όλες (${detail.entries.length})`,playable_local:`Τοπικά (${detail.availability.playable_local})`,remote_only:`Μόνο στην πηγή (${detail.availability.remote_only})`,local_unavailable:`Λείπουν αρχεία (${detail.availability.local_unavailable})`,unresolved:`Ανεπίλυτες (${detail.availability.unresolved||0})`}}/><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={unique} onChange={e=>setUnique(e.target.checked)}/>Μόνο σε αυτή τη συλλογή</label><a className="text-xs text-cm-cyan underline" href={`/recovery?collection=${encodeURIComponent(detail.id)}`}>Ανάκτηση ελλείψεων</a></div>
 <Button variant="outline" onClick={()=>{setName(`${detail.name} — CrateMind`);setCopy(detail.id);setOpen(true)}}>Αντιγραφή σε νέα συλλογή CrateMind</Button>
 {detail.editable&&<div className="space-y-2"><Input aria-label="Προσθήκη κομματιού" placeholder="Αναζήτηση για προσθήκη κομματιού…" value={trackQuery} onChange={e=>setTrackQuery(e.target.value)}/>{tracks.map(t=><Button key={t.id} variant="outline" className="h-auto w-full justify-start whitespace-normal text-left" disabled={busy} onClick={()=>add(t.id)}>+ {t.artist} — {t.title}</Button>)}</div>}
 <ol className="divide-y divide-cm-line/20">
 {detail.entries.filter(e=>(!entryFilter||e.availability===entryFilter)&&(!unique||e.unique_to_collection)).map(e=>(
   <li key={e.position} className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-start gap-3 py-3">
     <span className="text-xs text-cm-muted">{e.position+1}</span>
     <div className="min-w-0">
       <a className="text-sm hover:text-cm-cyan" href={`/canonical?id=${encodeURIComponent(e.recording_id)}`}>{e.artist||'Άγνωστος καλλιτέχνης'} — {e.title||e.source_title||'Μη διαθέσιμο κομμάτι'}</a>
       <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
         <span className={e.availability==='playable_local'?'text-cm-chartreuse':'text-cm-muted'}>{availability[e.availability]||'Ανεπίλυτο'} · {e.collection_count} πηγές / {e.collection_family_count} οικογένειες</span>
         <ProviderCounts inline providers={e.providers||[]}/>
       </div>
       <details className="mt-1 text-xs text-cm-muted"><summary>Αρχικά στοιχεία {sources[e.service]||'τοπικού αρχείου'}</summary>{e.source_artist} — {e.source_title}{e.permalink&&<a href={e.permalink} target="_blank" rel="noreferrer" className="ml-2 text-cm-cyan underline">Πηγή</a>}</details>
     </div>
     <div className="flex flex-col items-end gap-2 self-center">
       {e.local_assets.filter(a=>a.playable).map(a=><Button key={a.local_track_id} className="cursor-pointer disabled:cursor-not-allowed" variant="outline" size="sm" aria-label={`Αναπαραγωγή θέσης ${e.position+1} στο κάτω player${e.local_assets.filter(a=>a.playable).length>1?` · αρχείο ${a.local_track_id}`:''}`} disabled={loadingTrack!==null} onClick={()=>playLocal(a.local_track_id)}><Play className="h-4 w-4"/>{loadingTrack===a.local_track_id?'Φόρτωση…':'Αναπαραγωγή'}{e.local_assets.filter(a=>a.playable).length>1?` · ${a.local_track_id}`:''}</Button>)}
     </div>
   </li>
 ))}
 </ol>{!detail.entries.length&&<p className="text-sm text-cm-muted">Η συλλογή είναι κενή. Αναζητήστε ένα κομμάτι για να το προσθέσετε.</p>}</TabsContent></Tabs></>}</section></div>
 <Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogHeader><DialogTitle>Νέα συλλογή CrateMind</DialogTitle><DialogDescription>{copy?'Αντιγράφει όλες τις θέσεις με την ίδια σειρά και διατηρεί την προέλευση.':'Δημιουργεί μια κενή προσωπική συλλογή.'} Αποθηκεύεται μόνο στο CrateMind.</DialogDescription></DialogHeader><Input aria-label="Όνομα νέας συλλογής" placeholder="Όνομα συλλογής" value={name} maxLength={200} onChange={e=>setName(e.target.value)}/><Button disabled={busy||!name.trim()} onClick={create}>Δημιουργία</Button></DialogContent></Dialog>
 </div>;
}
