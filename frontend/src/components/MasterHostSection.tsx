import { memo, useCallback, useEffect, useId, useRef, useState } from "react";
import { AppWindow, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Hint } from "@/components/ui/tooltip";
import { cn } from "../lib/cn";
import { isDesktopRuntime } from "../lib/desktopRuntime";
import { getPref } from "../lib/prefs";
import { unlockPlaybackAudio } from "../lib/playbackAudio";
import { useTwoDeck } from "../lib/player";
import { useRecording } from "../lib/recorder";
import { CHIP } from "../lib/tones";
import {
  HOST_SLOT_LABEL, HOST_SLOTS, bypassHostSlot, faultMessage, openMasterHostEditor, scanMasterHostPlugins, startMasterHost, stopMasterHost,
  useMasterHostState, type HostSlot, type HostSlotStats, type MasterHostPlugin, type MasterHostStats,
} from "../lib/masterHost";

type Paths = Record<HostSlot, string>;

/** The Select's «Κανένα»: Radix needs a non-empty value. */
const NONE = "none";
const EMPTY_PATHS: Paths = { deck_a: NONE, deck_b: NONE, master: NONE };
const PREF_KEY = { deck_a: "hostPluginDeckA", deck_b: "hostPluginDeckB", master: "masterHostPlugin" } as const;
const LABEL_TONE: Record<HostSlot, string> = { deck_a: "text-cm-deck-a", deck_b: "text-cm-deck-b", master: "text-cm-text" };
const FAULT_BADGE = {
  error: { text: "Σφάλμα", tone: CHIP.rose },
  slow: { text: "Αργό", tone: CHIP.amber },
  reload: { text: "Επαναφόρτωση", tone: CHIP.amber },
} as const;
const BADGE = "rounded-md px-1.5 py-0 text-[10px] font-semibold";

const ms = (frames: number, rate: number) => `${(frames * 1000 / rate).toFixed(1)} ms`;
/** Native errors arrive in Greek; a transport failure (TypeError) or anything else gets the fallback. */
const actionError = (error: unknown, fallback: string) => error instanceof Error && !(error instanceof TypeError) ? error.message : fallback;

/** Memoised on its own props, so the twice-a-second readings never re-render a picker. */
const SlotPicker = memo(function SlotPicker({ slot, plugins, value, disabled, onPick }: {
  slot: HostSlot; plugins: MasterHostPlugin[]; value: string; disabled: boolean; onPick: (slot: HostSlot, value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={next => onPick(slot, next)} disabled={disabled}>
      <SelectTrigger size="sm" className="w-full min-w-0 text-xs" aria-label={`Plugin VST3, ${HOST_SLOT_LABEL[slot]}`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>Κανένα</SelectItem>
        {plugins.map(plugin => <SelectItem key={plugin.path} value={plugin.path}>{plugin.name}</SelectItem>)}
      </SelectContent>
    </Select>
  );
});

function SlotBadge({ slot, live, empty }: { slot: HostSlot; live: HostSlotStats | null; empty: boolean }) {
  if (empty) return <Hint text="Το plugin δεν φορτώθηκε· το slot έμεινε άδειο."><Badge variant="outline" className={cn(BADGE, CHIP.muted)}>Άδειο</Badge></Hint>;
  if (live?.fault) {
    const badge = FAULT_BADGE[live.fault];
    return <Badge variant="outline" className={cn(BADGE, badge.tone)} title={faultMessage(slot, live.fault)}>{badge.text}</Badge>;
  }
  if (live?.bypassed) return <Badge variant="outline" className={cn(BADGE, CHIP.muted)}>Bypass</Badge>;
  return null;
}

/** One slot on the parent's grid: label, picker, state and latency, bypass, the plugin's own window. */
function SlotRow({ slot, plugins, path, locked, on, loaded, live, sampleRate, onPick }: {
  slot: HostSlot; plugins: MasterHostPlugin[]; path: string; locked: boolean; on: boolean;
  loaded: boolean; live: HostSlotStats | null; sampleRate: number | null; onPick: (slot: HostSlot, value: string) => void;
}) {
  const label = HOST_SLOT_LABEL[slot];
  // The switch follows the click at once; the stats (every half second) confirm it.
  const [pending, setPending] = useState<boolean | null>(null);
  const settle = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(settle.current), []);
  useEffect(() => { if (!on) setPending(null); }, [on]);
  const bypassed = pending ?? live?.bypassed ?? false;

  function toggle(next: boolean) {
    clearTimeout(settle.current);
    setPending(next);
    bypassHostSlot(slot, next).then(
      () => { settle.current = setTimeout(() => setPending(null), 1500); },
      error => { setPending(null); toast.error(actionError(error, "Το bypass δεν άλλαξε.")); },
    );
  }
  function editor() {
    openMasterHostEditor(slot).catch(error => toast.error(actionError(error, "Το παράθυρο του plugin δεν άνοιξε.")));
  }

  return (
    <div role="group" aria-label={label} className="col-span-full grid grid-cols-subgrid items-center">
      <span className={cn("text-xs font-semibold", LABEL_TONE[slot])}>{label}</span>
      <SlotPicker slot={slot} plugins={plugins} value={path} disabled={locked} onPick={onPick} />
      <span className="flex min-w-[5.5rem] items-center justify-end gap-2">
        <SlotBadge slot={slot} live={live} empty={on && !loaded && path !== NONE} />
        <span className="font-mono text-[11px] tabular-nums text-cm-muted">
          {on && loaded && live && sampleRate ? ms(live.latency, sampleRate) : "—"}
        </span>
      </span>
      <Switch size="sm" checked={on && loaded && bypassed} onCheckedChange={toggle}
        disabled={!on || !loaded || !live || live.fault === "reload"} aria-label={`Bypass plugin, ${label}`} />
      <Button variant="ghost" size="icon-xs" disabled={!on || !loaded} onClick={editor}
        aria-label={`Παράθυρο plugin, ${label}`} title={`Παράθυρο plugin, ${label}`}>
        <AppWindow aria-hidden />
      </Button>
    </div>
  );
}

function readingRows(stats: MasterHostStats): [string, string][] {
  const rate = stats.sample_rate;
  return [
    ["Εκτιμώμενη πρόσθετη καθυστέρηση", `${stats.latency_ms.toFixed(1)} ms`],
    ["Ευθυγράμμιση decks (PDC)", ms(stats.pdc, rate)],
    ["Φόρτος ήχου", `${Math.round(stats.callback_load_pct)}%`],
    ["Plugins · αναμονή · συσκευή", [stats.plugin_latency, stats.ring_fill, stats.device_buffer].map(n => (n * 1000 / rate).toFixed(1)).join(" · ") + " ms"],
    ["Buffer", `${stats.device_buffer} δείγματα`],
    ["Underruns · περικοπές · απορρίψεις", `${stats.underruns} · ${stats.trims} · ${stats.dropped}`],
    ["Μέγιστο κενό worker (τώρα · συνολικά)", `${stats.tap_gap_ms.toFixed(1)} · ${stats.tap_gap_session_ms.toFixed(1)} ms`],
    ["Μέγιστο κενό host (τώρα · συνολικά)", `${stats.max_gap_ms.toFixed(1)} · ${stats.gap_session_ms.toFixed(1)} ms`],
    ["Κενά πάνω από 20 ms (worker · host)", `${stats.tap_late} · ${stats.late}`],
    ["Πάγωμα διεπαφής (τώρα · συνολικά)", `${stats.ui_stall_ms} · ${stats.ui_stall_session_ms} ms`],
    ["Απόθεμα ασφαλείας (στόχος · όριο)", `${stats.cushion_ms.toFixed(1)} · ${stats.cushion_max_ms.toFixed(1)} ms`],
    ["Διαδρομή ήχου", stats.path === "shared" ? "κοινή μνήμη (SharedArrayBuffer)" : "MessagePort (μέσω κύριου νήματος)"],
    ...(stats.path === "shared"
      ? [["Υπερχειλίσεις ring · μέγιστη αναμονή worker", `${stats.ring_overruns} · ${stats.ring_peak_ms.toFixed(1)} ms`] as [string, string]]
      : []),
    ["Ρυθμός δειγματοληψίας", `${rate} Hz`],
  ];
}

/** «Μετρήσεις», collapsed by default; the summary keeps the total delay in sight. */
function Readings({ stats }: { stats: MasterHostStats | null }) {
  return (
    <details className="group/readings min-w-0">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md py-1 text-[11px] font-medium text-cm-muted hover:text-cm-text focus-visible:outline-2 focus-visible:outline-cm-cyan [&::-webkit-details-marker]:hidden">
        <ChevronDown aria-hidden className="size-3.5 shrink-0 -rotate-90 transition-transform group-open/readings:rotate-0 motion-reduce:transition-none" />
        Μετρήσεις
        <span className="ml-auto font-mono tabular-nums text-cm-faint">{stats ? `${stats.latency_ms.toFixed(1)} ms` : "—"}</span>
      </summary>
      {stats && (
        <dl className="mt-1.5 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-[11px]">
          {readingRows(stats).map(([term, value]) => (
            <div key={term} className="contents">
              <dt className="text-cm-muted">{term}</dt>
              <dd className="text-right tabular-nums text-cm-text">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </details>
  );
}

/** Experimental: Deck A, Deck B and the master through their own VST3 plugins (desktop, macOS). Hidden unless the native scan answers. */
export function MasterHostSection() {
  const [plugins, setPlugins] = useState<MasterHostPlugin[] | null>(null);
  const [paths, setPaths] = useState<Paths>(EMPTY_PATHS);
  const host = useMasterHostState();
  const twoDeck = useTwoDeck();
  const recording = useRecording().status !== "off";
  const hintId = useId();

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let live = true;
    scanMasterHostPlugins().then(found => {
      if (!live) return;
      setPlugins(found);
      // Only a saved path the scan found; any other slot starts on «Κανένα».
      const saved = (slot: HostSlot) => {
        const path = getPref(PREF_KEY[slot]);
        return path && found.some(plugin => plugin.path === path) ? path : NONE;
      };
      setPaths({ deck_a: saved("deck_a"), deck_b: saved("deck_b"), master: saved("master") });
    }, () => {});
    return () => { live = false; };
  }, []);

  const pick = useCallback((slot: HostSlot, value: string) => setPaths(current => ({ ...current, [slot]: value })), []);

  if (!plugins) return null;
  const running = host.status !== "off";
  const on = host.status === "on" ? host : null;
  const stats = on?.stats ?? null;
  const chosen = (slot: HostSlot) => paths[slot] === NONE ? null : paths[slot];
  const hint = running ? null
    : !twoDeck ? "Διαθέσιμο μόνο σε λειτουργία δύο decks."
    : recording ? "Σταμάτησε πρώτα την εγγραφή set: η εγγραφή και τα plugins VST3 δεν τρέχουν μαζί."
    : HOST_SLOTS.every(slot => chosen(slot) === null) ? "Διάλεξε τουλάχιστον ένα plugin."
    : null;

  function start() {
    // Unlock in the click itself; the native loads come after.
    void unlockPlaybackAudio().catch(() => {});
    void startMasterHost({ deck_a: chosen("deck_a"), deck_b: chosen("deck_b"), master: chosen("master") });
  }

  return (
    <div className="mt-4 space-y-3 border-t border-cm-line pt-4">
      <div>
        <span className="block text-xs font-medium text-cm-text">Plugins VST3 στα decks και στο master (πειραματικό)</span>
        <span className="mt-1 block text-[11px] leading-relaxed text-cm-muted">
          Κάθε deck και το master περνούν από το δικό τους plugin VST3 και παίζουν από την προεπιλεγμένη έξοδο ήχου του Mac. Κλείνει σε κάθε εκκίνηση.
        </span>
      </div>
      {plugins.length === 0 ? (
        <p className="text-[11px] leading-relaxed text-cm-muted">Δεν βρέθηκαν plugins VST3 στους φακέλους VST3 του Mac.</p>
      ) : (
        <>
          <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto_auto] items-center gap-x-3 gap-y-2">
            <div aria-hidden className="col-span-full grid grid-cols-subgrid text-[10px] font-medium text-cm-faint">
              <span />
              <span>Plugin</span>
              <span className="text-right">Καθυστέρηση</span>
              <span>Bypass</span>
              <span />
            </div>
            {HOST_SLOTS.map(slot => (
              <SlotRow key={slot} slot={slot} plugins={plugins} path={paths[slot]} locked={running} on={on !== null}
                loaded={!!on?.slots[slot]} live={stats?.slots[slot] ?? null} sampleRate={stats?.sample_rate ?? null} onPick={pick} />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {running ? (
              <Button variant="outline" size="sm" onClick={() => void stopMasterHost()}>Διακοπή</Button>
            ) : (
              <Button variant="outline" size="sm" disabled={hint !== null} onClick={start} aria-describedby={hint ? hintId : undefined}>Έναρξη</Button>
            )}
            {host.status === "starting" && <p role="status" className="text-[11px] text-cm-muted">Φόρτωση plugins…</p>}
            {hint && <p id={hintId} className="min-w-0 flex-1 text-[11px] leading-relaxed text-cm-faint">{hint}</p>}
          </div>
          {on && HOST_SLOTS.some(slot => on.slots[slot]?.restored) && (
            <p className="text-[11px] leading-relaxed text-cm-muted">Οι ρυθμίσεις των plugins επανήλθαν από την προηγούμενη χρήση.</p>
          )}
          {on && <Readings stats={stats} />}
        </>
      )}
    </div>
  );
}
