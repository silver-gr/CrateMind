import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { canApplyExchange, type ExchangePreview } from "../lib/libraryExchange";
import { stopMediaPlayback } from "../lib/desktopRuntime";
import { preferenceStorage } from "../lib/preferenceStorage";
import { usePlayer } from "../lib/player";
import { Button } from "./ui/button";
import { GlassPanel } from "./ui/GlassPanel";

const statuses = { ready: "Έτοιμο για εισαγωγή", replay: "Το στιγμιότυπο έχει ήδη εφαρμοστεί",
  stale: "Παλαιότερο στιγμιότυπο", conflict: "Υπάρχουν διαφορετικές αλλαγές στις δύο βιβλιοθήκες" };

export function LibraryExchangeSettings({ desktop }: { desktop: boolean }) {
  const [preview, setPreview] = useState<ExchangePreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const { clear } = usePlayer();

  useEffect(() => {
    if (!preview) return;
    const timer = window.setTimeout(() => {
      setPreview(null); setConfirmed(false);
      setError("Η προεπισκόπηση έληξε. Επίλεξε ξανά το αρχείο ανταλλαγής.");
    }, Math.max(0, preview.expires_at_unix * 1000 - Date.now()));
    return () => window.clearTimeout(timer);
  }, [preview]);

  async function exportLibrary() {
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await api.exportExchange(desktop);
      if (!result.canceled) setMessage(`Το αρχείο ανταλλαγής αποθηκεύτηκε: ${result.path}`);
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }
  async function inspect(file: File) {
    setBusy(true); setError(""); setMessage(""); setPreview(null); setConfirmed(false);
    try { setPreview(await api.inspectExchange(file)); }
    catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }
  async function apply() {
    if (!canApplyExchange(preview, confirmed) || !preview) return;
    setBusy(true); setError("");
    try {
      await preferenceStorage.flush();
      stopMediaPlayback(); clear();
      await api.commitExchange(preview, preview.conflict ? "replace" : "import");
      setApplying(true);
    } catch (reason) {
      setError((reason as Error).message);
      setPreview(null); setConfirmed(false);
    } finally { setBusy(false); }
  }

  return <GlassPanel className="mb-4 space-y-3 p-4">
    <h2 className="font-semibold text-cm-text">Μεταφορά πλήρους βιβλιοθήκης</h2>
    <p className="max-w-3xl text-xs text-cm-muted">Συνέχισε σε άλλη συσκευή με τις ίδιες συλλογές, σημειώσεις, cues και αποφάσεις. Μετέφερε το αρχείο ανταλλαγής πριν δουλέψεις στην άλλη βιβλιοθήκη. Τα αρχεία ήχου και οι ρυθμίσεις συσκευής μεταφέρονται χωριστά.</p>
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="outline" size="sm" disabled={busy || applying} onClick={() => void exportLibrary()}>Εξαγωγή για άλλη συσκευή</Button>
      <label className="text-sm text-cm-text">
        <span className="mr-2">Έλεγχος αρχείου ανταλλαγής</span>
        <input type="file" accept=".cmexchange" disabled={busy || applying} className="max-w-full text-xs" onChange={event => {
          const file = event.currentTarget.files?.[0];
          if (file) void inspect(file);
          event.currentTarget.value = "";
        }} />
      </label>
    </div>
    {busy && <p role="status" className="text-sm text-cm-muted">Έλεγχος και ασφαλής προετοιμασία της βιβλιοθήκης…</p>}
    {error && <p role="alert" className="text-sm text-cm-rose">{error}</p>}
    {message && <p role="status" className="break-all text-sm text-cm-cyan">{message}</p>}
    {applying && <p role="status" className="text-sm text-cm-cyan">Η εφαρμογή κλείνει για να εφαρμόσει τη βιβλιοθήκη και θα ανοίξει ξανά αυτόματα…</p>}
    {preview && !applying && <div className="space-y-3 rounded-lg border border-cm-line/20 p-3">
      <h3 className="text-sm font-medium text-cm-text">{statuses[preview.status]}</h3>
      <p className="text-xs text-cm-muted">{preview.reason}</p>
      <p className="break-all text-xs text-cm-muted">Στιγμιότυπο: {preview.manifest.snapshot_id}</p>
      <details className="text-xs text-cm-muted">
        <summary className="cursor-pointer">Ιστορία και προέλευση της μεταφοράς</summary>
        <p className="mt-2 break-all">Τρέχουσα βιβλιοθήκη: {preview.local_lineage_id ?? "Νέα βιβλιοθήκη"}</p>
        <p className="break-all">Τρέχον στιγμιότυπο: {preview.local_snapshot_id ?? "Δεν έχει εξαχθεί ακόμη"}</p>
        <p className="break-all">Εισερχόμενη βιβλιοθήκη: {preview.manifest.lineage_id}</p>
      </details>
      {!!preview.change_summary?.length && <div className="overflow-x-auto">
        <p className="mb-2 text-xs text-cm-muted">Διαφορές από την τρέχουσα βιβλιοθήκη. Μια αλλαγμένη εγγραφή μετρά και στις δύο πλευρές.</p>
        <table className="w-full text-left text-xs text-cm-text">
          <thead><tr><th scope="col">Στοιχεία</th><th scope="col">Μόνο στην τρέχουσα</th><th scope="col">Μόνο στην εισερχόμενη</th></tr></thead>
          <tbody>{preview.change_summary.map(change => <tr key={`${change.database}:${change.table}`}>
            <td className="py-1">{change.label}</td><td>{change.local_only}</td><td>{change.incoming_only}</td>
          </tr>)}</tbody>
        </table>
      </div>}
      <p className="text-xs text-cm-muted">{preview.manifest.logical_roots.length} φάκελοι μουσικής · οι τοπικές διαδρομές θα ελεγχθούν μετά την εισαγωγή.</p>
      {preview.status === "stale" && <p className="text-sm text-cm-amber">Επίλεξε νεότερο αρχείο από την άλλη συσκευή.</p>}
      {preview.conflict && <label className="flex items-start gap-2 text-sm text-cm-text">
        <input type="checkbox" className="mt-1" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />
        <span>Θέλω να αρχειοθετηθεί η τρέχουσα βιβλιοθήκη και να αντικατασταθεί από αυτό το στιγμιότυπο. Οι διαφορετικές αλλαγές δεν συγχωνεύονται.</span>
      </label>}
      {desktop ? <Button size="sm" disabled={busy || !canApplyExchange(preview, confirmed)} onClick={() => void apply()}>
        {preview.conflict ? "Αντικατάσταση με την εισερχόμενη έκδοση" : "Εφαρμογή και επανεκκίνηση"}
      </Button> : <p className="text-sm text-cm-muted">Η εισαγωγή στη web έκδοση εφαρμόζεται με τη βιβλιοθήκη κλειστή, ώστε να διατηρηθούν και οι δύο βάσεις με συνέπεια.</p>}
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setPreview(null); setConfirmed(false); }}>Ακύρωση εισαγωγής</Button>
      <p className="text-xs text-cm-muted">Η προεπισκόπηση ισχύει για δέκα λεπτά. Αν αλλάξει η βιβλιοθήκη, έλεγξε ξανά το αρχείο.</p>
    </div>}
  </GlassPanel>;
}
