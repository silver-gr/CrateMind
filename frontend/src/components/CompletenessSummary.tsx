import {useEffect,useState} from 'react';
import {identityRequest} from './CompletenessControls';
export default function CompletenessSummary(){
 const [metrics,setMetrics]=useState<Record<string,number>|null>(null);
 useEffect(()=>{let active=true;identityRequest<Record<string,number>>('completeness-summary').then(v=>{if(active)setMetrics(v)}).catch(()=>{});return()=>{active=false}},[]);
 return <a href="/recovery" className="mx-6 my-4 block rounded-lg border border-cyan-500/20 p-3 text-sm text-cm-text"><strong>Πληρότητα βιβλιοθήκης →</strong><p className="mt-1 text-xs text-cm-muted">{metrics?`${metrics.locally_playable.toLocaleString()} τοπικά · ${metrics.remote_only.toLocaleString()} μόνο σε πηγές · ${metrics.local_missing_files} μη διαθέσιμες τοπικές ομάδες · ${metrics.in_recovery_queue} προς απόκτηση`:'Αγαπημένα που λείπουν, διαθεσιμότητα και ουρά ανάκτησης'}</p></a>
}
