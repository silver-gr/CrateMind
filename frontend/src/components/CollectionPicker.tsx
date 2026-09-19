import {useEffect,useState} from 'react';
import {Button} from './ui/button';
import {Popover,PopoverTrigger,PopoverContent} from './ui/popover';
import {Command,CommandInput,CommandList,CommandItem,CommandEmpty} from './ui/command';
export default function CollectionPicker({value,onChange,label='Συλλογή'}:{value:string;onChange:(id:string)=>void;label?:string}){
 const [open,setOpen]=useState(false),[rows,setRows]=useState<{id:string;name:string;service:string}[]>([]),[error,setError]=useState('');
 useEffect(()=>{let active=true;fetch('/api/identity/collections').then(r=>{if(!r.ok)throw Error('Αποτυχία φόρτωσης συλλογών');return r.json()}).then(v=>{if(active)setRows(v)}).catch(e=>{if(active)setError(e.message)});return()=>{active=false}},[]);
 return <Popover open={open} onOpenChange={setOpen}><PopoverTrigger asChild><Button variant="outline" aria-label={label} className="max-w-full justify-start truncate">{rows.find(r=>r.id===value)?.name||label}</Button></PopoverTrigger><PopoverContent className="w-[min(480px,90vw)] p-0"><Command filter={(v,q,keywords)=>[v,...(keywords||[])].join(' ').toLowerCase().includes(q.toLowerCase())?1:0}><CommandInput placeholder="Αναζήτηση συλλογής…"/><CommandList className="max-h-72"><CommandEmpty>{error||'Δεν βρέθηκε συλλογή'}</CommandEmpty><CommandItem onSelect={()=>{onChange('');setOpen(false)}}>Χωρίς επιλογή</CommandItem>{rows.map(r=><CommandItem key={r.id} value={r.id} keywords={[r.name,r.service]} onSelect={()=>{onChange(r.id);setOpen(false)}}>{r.service} · {r.name}</CommandItem>)}</CommandList></Command></PopoverContent></Popover>;
}
