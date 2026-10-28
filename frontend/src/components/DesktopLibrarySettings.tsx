import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { nativeAction, stopMediaPlayback, type DesktopConfig, type LibraryRoot } from "../lib/desktopRuntime";
import { preferenceStorage } from "../lib/preferenceStorage";
import { Button } from "./ui/button";
import { GlassPanel } from "./ui/GlassPanel";

export function DesktopLibrarySettings({ connectedRoots }: { connectedRoots: string[] }) {
  const [config, setConfig] = useState<DesktopConfig | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    let active = true;
    api.desktopConfig().then(value => { if (active) setConfig(value); })
      .catch(reason => { if (active) setError((reason as Error).message); });
    return () => { active = false; };
  }, []);

  async function save(roots: LibraryRoot[]) {
    await preferenceStorage.flush();
    stopMediaPlayback();
    await api.patchDesktopConfig(roots);
    setRestarting(true);
  }
  async function choose(root?: LibraryRoot) {
    if (!config) return;
    setBusy(true); setError("");
    try {
      const selected = await nativeAction<string[]>("pick_library_roots");
      if (selected.canceled || !selected.value?.length) return;
      if (root && selected.value.length !== 1) throw new Error("Για την αντιστοίχιση επίλεξε έναν φάκελο.");
      const roots = root ? config.library_roots.map(item => item.root_key === root.root_key
        ? { ...item, local_prefix: selected.value![0], enabled: true } : item)
        : [...config.library_roots, ...selected.value.map((path): LibraryRoot => ({
          root_key: crypto.randomUUID(), logical_prefix: path,
          logical_flavor: /^[a-z]:[\\/]|^\\\\/i.test(path) ? "windows" : "posix",
          local_prefix: path, enabled: true,
        }))];
      await save(roots);
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }
  async function toggle(root: LibraryRoot) {
    if (!config) return;
    setBusy(true); setError("");
    try { await save(config.library_roots.map(item => item.root_key === root.root_key ? { ...item, enabled: !item.enabled } : item)); }
    catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }

  return <GlassPanel className="mb-4 space-y-3 p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="font-semibold text-cm-text">Φάκελοι μουσικής σε αυτή τη συσκευή</h2>
      <Button variant="outline" size="sm" disabled={!config || busy || restarting} onClick={() => void choose()}>Προσθήκη φακέλου</Button>
    </div>
    <p className="text-xs text-cm-muted">Η αντιστοίχιση δείχνει πού βρίσκονται τα ίδια αρχεία σε αυτή τη συσκευή. Οι αλλαγές εφαρμόζονται με επανεκκίνηση της εφαρμογής.</p>
    {error && <p role="alert" className="text-sm text-cm-rose">{error}</p>}
    {restarting && <p role="status" className="text-sm text-cm-cyan">Η εφαρμογή επανεκκινείται με τους νέους φακέλους…</p>}
    {!config && !error && <p role="status" className="text-sm text-cm-muted">Φόρτωση φακέλων…</p>}
    {config?.library_roots.length === 0 && <p className="text-sm text-cm-muted">Πρόσθεσε τον φάκελο με τη μουσική σου. Τα αρχεία παραμένουν στη θέση τους.</p>}
    <ul className="divide-y divide-cm-line/20">
      {config?.library_roots.map(root => {
        const status = !root.enabled ? "Ανενεργός" : !root.local_prefix ? "Χωρίς αντιστοίχιση"
          : connectedRoots.some(path => path === root.local_prefix || path.replace(/\\/g, "/").startsWith(root.local_prefix!.replace(/\\/g, "/").replace(/\/$/, "") + "/")) ? "Συνδεδεμένος" : "Μη συνδεδεμένος";
        return <li key={root.root_key} className="flex flex-wrap items-center gap-3 py-3">
          <div className="min-w-0 flex-1">
            <p className="break-all font-mono text-xs text-cm-text">{root.logical_prefix}</p>
            <p className="mt-1 break-all text-xs text-cm-muted">{status}{root.local_prefix ? ` · ${root.local_prefix}` : ""}</p>
          </div>
          <Button variant="outline" size="sm" disabled={busy || restarting} onClick={() => void choose(root)}>Αντιστοίχιση φακέλου</Button>
          <Button variant="ghost" size="sm" disabled={busy || restarting} onClick={() => void toggle(root)}>{root.enabled ? "Απενεργοποίηση" : "Ενεργοποίηση"}</Button>
        </li>;
      })}
    </ul>
  </GlassPanel>;
}
