import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog';

type Source = { id: string; service: string; title: string; artist: string; recording_id: string; duration_ms: number | null; path?: string; isrc?: string | null; versions: string[]; asset?: { playable: boolean; audio_url: string } };
type MetadataChoice = { recording_id: string; title: string; artist: string; state: string; version?: string; release?: string; credits?: { name: string; role: string }[] };
type Comparison = { left_id: string; right_id: string; token: string; groups: Source[][]; hard_blocks: string[]; hard_block_details?: { conflict: string }[]; automatic_reasons: string[]; metadata_choices: MetadataChoice[]; recommended_metadata_id?: string | null; isrc_override?: { allowed: boolean } };
const sources: Record<string, string> = { local: 'Τοπικό αρχείο', spotify: 'Spotify', soundcloud: 'SoundCloud' };

async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch('/api/identity/' + path, { signal, ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw Error(typeof data.detail === 'string' ? data.detail : data.detail?.message || 'Αποτυχία αιτήματος');
  return data;
}

export function IdentityLinker({ entityId, targetId, onChanged }: { entityId: string; targetId?: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<Source[]>([]);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [preferred, setPreferred] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [comparing, setComparing] = useState(false);
  const comparisonRequest = useRef(0);

  useEffect(() => {
    if (!open || comparison || comparing || targetId) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      request<{ items: Source[] }>('items?' + new URLSearchParams({ q: query, mode: 'recordings', limit: '30' }), undefined, abort.signal)
        .then(result => setRows(result.items))
        .catch(e => { if (e.name !== 'AbortError') setError(e.message); });
    }, 200);
    return () => { abort.abort(); clearTimeout(timer); };
  }, [query, open, comparison, comparing, targetId]);

  async function compare(id: string) {
    const sequence = ++comparisonRequest.current;
    setError(''); setComparison(null); setOverrideReason(''); setComparing(true);
    try {
      const result = await request<Comparison>('compare-identity?' + new URLSearchParams({ left_id: entityId, right_id: id }));
      if (sequence !== comparisonRequest.current) return;
      setComparison(result);
      setPreferred(result.recommended_metadata_id || '');
    } catch (e) {
      if (sequence === comparisonRequest.current) setError((e as Error).message);
    } finally {
      if (sequence === comparisonRequest.current) setComparing(false);
    }
  }

  function changeOpen(next: boolean) {
    if (!next) { comparisonRequest.current++; setComparing(false); }
    setOpen(next);
  }

  async function decide(accept: boolean) {
    if (!comparison) return;
    setBusy(true); setError('');
    try {
      await request(accept ? 'confirm-identity' : 'reject-identity', {
        left_id: entityId, right_id: comparison.right_id, token: comparison.token,
        metadata_from: preferred, ...(accept && comparison.isrc_override?.allowed ? { isrc_override_reason: overrideReason.trim() } : {}),
      });
      changeOpen(false); onChanged();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  const override = Boolean(comparison?.isrc_override?.allowed);
  const blocked = Boolean(comparison?.hard_blocks.length) && (!override || !overrideReason.trim());
  const selectedMetadata = comparison?.metadata_choices.find(choice => choice.recording_id === preferred);

  return <>
    <Button variant="outline" size="sm" onClick={() => {
      setOpen(true); setError(''); setComparison(null); setRows([]); setOverrideReason('');
      if (targetId) void compare(targetId);
    }}>{targetId ? 'Σύγκριση & σύνδεση' : 'Σύνδεση με άλλη πηγή'}</Button>
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Είναι η ίδια ηχογράφηση;</DialogTitle>
          <DialogDescription>Συγκρίνετε έκδοση, διάρκεια και πηγές. Η σύνδεση μπορεί να αναιρεθεί από το ιστορικό.</DialogDescription>
        </DialogHeader>
        {error && <div className="space-y-2">
          <p role="alert" className="text-sm text-cm-rose">{error}</p>
          {comparison && <Button variant="outline" size="sm" disabled={busy || comparing} onClick={() => void compare(comparison.right_id)}>Ανανέωση σύγκρισης</Button>}
        </div>}
        {comparing ? <p role="status" className="py-6 text-sm text-cm-muted">Φόρτωση σύγκρισης…</p> : !comparison ? <>
          {targetId ? <Button onClick={() => void compare(targetId)}>Επανάληψη σύγκρισης</Button> : <>
            <Input aria-label="Αναζήτηση ηχογράφησης" value={query} onChange={e => setQuery(e.target.value)} placeholder="Τίτλος ή καλλιτέχνης…" />
            {rows.filter(row => row.id !== entityId).map(row => <Button key={row.id} className="h-auto justify-start whitespace-normal" variant="outline" onClick={() => void compare(row.id)}>{row.artist} — {row.title}</Button>)}
          </>}
        </> : <>
          <div className="grid gap-4 sm:grid-cols-2">
            {comparison.groups.map((group, i) => <section key={i} className="space-y-4 rounded-lg border border-cm-line/20 p-4">
              {group.map(source => <div key={source.id} className="space-y-2 text-sm">
                <p className="text-xs font-medium text-cm-muted">{sources[source.service] || source.service}</p>
                <strong className="block">{source.artist} — {source.title}</strong>
                <p>{source.duration_ms == null ? 'Άγνωστη διάρκεια' : `${(source.duration_ms / 1000).toFixed(2)} s`} · {source.versions.join(', ') || 'Χωρίς ένδειξη διαφορετικής έκδοσης'}</p>
                {override && source.isrc && <p className="font-mono text-xs">ISRC: {source.isrc}</p>}
                {source.asset?.playable && <audio controls preload="none" className="w-full" src={source.asset.audio_url} aria-label={`Ακρόαση ${source.title}`} />}
              </div>)}
            </section>)}
          </div>
          {override ? <div className="space-y-2 rounded-lg border border-cm-amber/30 p-3">
            <p className="text-sm">Οι πηγές έχουν διαφορετικό ISRC. Αν επαληθεύσατε ότι είναι η ίδια έκδοση, καταγράψτε την αιτία της σύνδεσης.</p>
            <Textarea aria-label="Τεκμηρίωση σύνδεσης παρά τη διαφορά ISRC" value={overrideReason} onChange={e => setOverrideReason(e.target.value)} placeholder="Π.χ. σύγκρινα την ηχογράφηση και επιβεβαίωσα την ίδια έκδοση…" />
          </div> : comparison.hard_blocks.length > 0 ? <p role="alert" className="text-sm text-cm-rose">Υπάρχει σύγκρουση έκδοσης, προηγούμενη απόρριψη ή παλιά τοπική εγγραφή. Επιλέξτε τη σωστή πηγή πριν από τη σύνδεση.</p> : null}
          {comparison.recommended_metadata_id && selectedMetadata ? <p className="text-sm text-cm-muted">Εμφάνιση ως <strong className="text-cm-text">{selectedMetadata.artist} — {selectedMetadata.title}</strong></p> : <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium">Ποια στοιχεία να εμφανίζονται στη βιβλιοθήκη;</legend>
            {comparison.metadata_choices.map(choice => <label key={choice.recording_id} className="flex items-start gap-2 text-sm">
              <input className="mt-1" type="radio" name={`metadata-${entityId}`} value={choice.recording_id} checked={preferred === choice.recording_id} onChange={() => setPreferred(choice.recording_id)} />
              <span>{choice.artist} — {choice.title}{choice.release && <span className="block text-xs text-cm-muted">{choice.release}</span>}{choice.version && <span className="block text-xs text-cm-muted">{choice.version}</span>}</span>
            </label>)}
          </fieldset>}
          <details className="text-xs text-cm-muted">
            <summary className="cursor-pointer">Στοιχεία πηγών και ελέγχου</summary>
            <div className="mt-2 space-y-2 break-all">
              {comparison.groups.flat().map(source => <p key={source.id}>{source.id}{source.path ? ` · ${source.path}` : ''}</p>)}
              {[...comparison.automatic_reasons, ...comparison.hard_blocks].map((reason, i) => <p key={i}>{reason}</p>)}
            </div>
          </details>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy || blocked || !preferred} onClick={() => void decide(true)}>Ίδια ηχογράφηση · Σύνδεση</Button>
            <Button variant="outline" disabled={busy} onClick={() => void decide(false)}>Διαφορετική ηχογράφηση</Button>
          </div>
        </>}
      </DialogContent>
    </Dialog>
  </>;
}

export function UndoIdentity({ leftId, rightId, onChanged }: { leftId: string; rightId: string; onChanged: () => void }) {
  const [message, setMessage] = useState('');
  return <><Button variant="outline" size="sm" onClick={async () => {
    try {
      const result = await request<{ still_connected: boolean }>('undo-identity', { left_id: leftId, right_id: rightId });
      setMessage(result.still_connected ? 'Άλλη αποδεκτή σύνδεση κρατά τις πηγές μαζί.' : 'Η σύνδεση αναιρέθηκε.'); onChanged();
    } catch (e) { setMessage((e as Error).message); }
  }}>Αναίρεση σύνδεσης</Button>{message && <p className="text-xs">{message}</p>}</>;
}
