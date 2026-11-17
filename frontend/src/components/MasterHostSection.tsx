import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { isDesktopRuntime } from "../lib/desktopRuntime";
import { unlockPlaybackAudio } from "../lib/playbackAudio";
import { useTwoDeck } from "../lib/player";
import {
  openMasterHostEditor, scanMasterHostPlugins, startMasterHost, stopMasterHost, useMasterHostState, type MasterHostPlugin,
} from "../lib/masterHost";

/** Experimental: the master through a VST3 plugin (desktop, macOS). Hidden unless the native scan answers. */
export function MasterHostSection() {
  const [plugins, setPlugins] = useState<MasterHostPlugin[] | null>(null);
  const [path, setPath] = useState("");
  const host = useMasterHostState();
  const twoDeck = useTwoDeck();

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let live = true;
    scanMasterHostPlugins().then(found => {
      if (!live) return;
      setPlugins(found);
      setPath(current => current || found[0]?.path || "");
    }, () => {});
    return () => { live = false; };
  }, []);

  if (!plugins) return null;
  const running = host.status !== "off";
  const stats = host.status === "on" ? host.stats : null;

  function start() {
    // Unlock in the click itself; the native load comes after.
    void unlockPlaybackAudio().catch(() => {});
    void startMasterHost(path);
  }
  function editor() {
    openMasterHostEditor().catch(error =>
      toast.error(error instanceof TypeError ? "Το παράθυρο του plugin δεν άνοιξε." : (error as Error).message));
  }

  return (
    <div className="mt-4 space-y-3 border-t border-cm-line pt-4">
      <div>
        <span className="block text-xs font-medium text-cm-text">Έξοδος master μέσω plugin (πειραματικό)</span>
        <span className="mt-1 block text-[11px] leading-relaxed text-cm-muted">
          Το master περνά από ένα plugin VST3 και παίζει από την προεπιλεγμένη έξοδο ήχου του Mac. Κλείνει σε κάθε εκκίνηση.
        </span>
      </div>
      {plugins.length === 0 ? (
        <p className="text-[11px] leading-relaxed text-cm-muted">Δεν βρέθηκαν plugins VST3 στους φακέλους VST3 του Mac.</p>
      ) : (
        <>
          <Select value={path} onValueChange={setPath} disabled={running}>
            <SelectTrigger size="sm" className="w-full text-xs" aria-label="Plugin VST3">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {plugins.map(plugin => <SelectItem key={plugin.path} value={plugin.path}>{plugin.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="flex flex-wrap gap-2">
            {running ? (
              <Button variant="outline" size="sm" onClick={() => void stopMasterHost()}>Διακοπή</Button>
            ) : (
              <Button variant="outline" size="sm" disabled={!twoDeck || !path} onClick={start}>Έναρξη</Button>
            )}
            <Button variant="ghost" size="sm" disabled={host.status !== "on"} onClick={editor}>Παράθυρο plugin</Button>
          </div>
          {!twoDeck && !running && <p className="text-[11px] leading-relaxed text-cm-faint">Διαθέσιμο μόνο σε λειτουργία δύο decks.</p>}
          {host.status === "starting" && <p role="status" className="text-[11px] text-cm-muted">Φόρτωση plugin…</p>}
          {host.status === "on" && (
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
              <dt className="text-cm-muted">Εκτιμώμενη πρόσθετη καθυστέρηση</dt>
              <dd className="text-right tabular-nums text-cm-text">{stats ? `${stats.latency_ms.toFixed(1)} ms` : "—"}</dd>
              <dt className="text-cm-muted">Plugin · αναμονή · συσκευή</dt>
              <dd className="text-right tabular-nums text-cm-text">{stats ? [stats.plugin_latency, stats.ring_fill, stats.device_buffer].map(n => (n * 1000 / stats.sample_rate).toFixed(1)).join(" · ") + " ms" : "—"}</dd>
              <dt className="text-cm-muted">Buffer</dt>
              <dd className="text-right tabular-nums text-cm-text">{stats ? `${stats.device_buffer} δείγματα` : "—"}</dd>
              <dt className="text-cm-muted">Underruns · περικοπές · απορρίψεις</dt>
              <dd className="text-right tabular-nums text-cm-text">{stats ? `${stats.underruns} · ${stats.trims} · ${stats.dropped}` : "—"}</dd>
              <dt className="text-cm-muted">Μέγιστο κενό worker (τώρα · συνολικά)</dt>
              <dd className="text-right tabular-nums text-cm-text">{stats ? `${stats.tap_gap_ms.toFixed(1)} · ${stats.tap_gap_session_ms.toFixed(1)} ms` : "—"}</dd>
              <dt className="text-cm-muted">Μέγιστο κενό host (τώρα · συνολικά)</dt>
              <dd className="text-right tabular-nums text-cm-text">{stats ? `${stats.max_gap_ms.toFixed(1)} · ${stats.gap_session_ms.toFixed(1)} ms` : "—"}</dd>
              <dt className="text-cm-muted">Κενά πάνω από 20 ms (worker · host)</dt>
              <dd className="text-right tabular-nums text-cm-text">{stats ? `${stats.tap_late} · ${stats.late}` : "—"}</dd>
              <dt className="text-cm-muted">Πάγωμα διεπαφής (τώρα · συνολικά)</dt>
              <dd className="text-right tabular-nums text-cm-text">{stats ? `${stats.ui_stall_ms} · ${stats.ui_stall_session_ms} ms` : "—"}</dd>
              <dt className="text-cm-muted">Απόθεμα ασφαλείας</dt>
              <dd className="text-right tabular-nums text-cm-text">{stats ? `${stats.cushion_ms.toFixed(1)} ms` : "—"}</dd>
              <dt className="text-cm-muted">Ρυθμός δειγματοληψίας</dt>
              <dd className="text-right tabular-nums text-cm-text">{stats ? `${stats.sample_rate} Hz` : "—"}</dd>
            </dl>
          )}
        </>
      )}
    </div>
  );
}
