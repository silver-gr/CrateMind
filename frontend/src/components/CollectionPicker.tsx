import {collectionAccountLabel, collectionOriginLabel} from '../lib/collectionLabels';
import {loadCollectionOptions, subscribeCollectionOptions, type CollectionOption} from '../lib/collectionOptions';
import {useEffect,useState} from 'react';
import {Button} from './ui/button';
import {Popover,PopoverTrigger,PopoverContent} from './ui/popover';
import {Command,CommandInput,CommandList,CommandItem,CommandEmpty} from './ui/command';
export default function CollectionPicker({value,onChange,label='Συλλογή'}:{value:string;onChange:(id:string)=>void;label?:string}){
 const [open,setOpen]=useState(false),[rows,setRows]=useState<CollectionOption[]>([]),[error,setError]=useState('');
 useEffect(()=>{
  if(!open&&!value)return;
  let active=true,version=0;
  const load=()=>{const current=++version;setError('');loadCollectionOptions().then(rows=>{if(active&&current===version)setRows(rows)}).catch(error=>{if(active&&current===version)setError(error.message)})};
  load();const unsubscribe=subscribeCollectionOptions(load);
  return()=>{active=false;unsubscribe()};
 },[open,value]);
 return <Popover open={open} onOpenChange={setOpen}><PopoverTrigger asChild><Button variant="outline" aria-label={label} className="max-w-full justify-start truncate">{rows.find(r=>r.id===value)?.name||label}</Button></PopoverTrigger><PopoverContent className="w-[min(480px,90vw)] p-0"><Command filter={(v,q,keywords)=>[v,...(keywords||[])].join(' ').toLowerCase().includes(q.toLowerCase())?1:0}><CommandInput placeholder="Αναζήτηση συλλογής…"/><CommandList className="max-h-72"><CommandEmpty>{error||'Δεν βρέθηκε συλλογή'}</CommandEmpty><CommandItem onSelect={()=>{onChange('');setOpen(false)}}>Χωρίς επιλογή</CommandItem>{rows.map(r=><CommandItem key={r.id} value={r.id} keywords={[r.name,r.service,...(r.aliases||[]),...(r.source_services||[]),...(r.source_accounts||[]),...(r.source_accounts||[]).map(a=>collectionAccountLabel((r.source_services||[]).includes('soundcloud')?'soundcloud':r.service,a))]} onSelect={()=>{onChange(r.id);setOpen(false)}}>{collectionOriginLabel(r)} · {r.name}</CommandItem>)}</CommandList></Command></PopoverContent></Popover>;
}
