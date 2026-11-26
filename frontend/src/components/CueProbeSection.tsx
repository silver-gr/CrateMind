import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { APP_COMMIT, APP_VERSION } from "../lib/appInfo";
import { createCueProbe, cueProbeSupported, PROBE_FAILURE_TEXT, probeReport, probeVerdict } from "../lib/cueProbe";
import { isDesktopRuntime } from "../lib/desktopRuntime";
import { masterHostActive } from "../lib/masterHost";
import { existingPlaybackContext, playbackContext } from "../lib/playbackAudio";
import { SettingsCard } from "./settings/SettingRow";

const probe = createCueProbe({
  context: playbackContext,
  hostActive: masterHostActive,
  now: () => performance.now(),
  about: `CrateMind ${APP_VERSION} ${APP_COMMIT} · ${globalThis.navigator?.userAgent ?? ""}`,
});

const STEPS = [
  "Σύνδεσε το Mixtrack με το USB και βάλε τα ακουστικά στην υποδοχή του. Στο Mac άνοιξε Ρυθμίσεις συστήματος → Ήχος → Έξοδος και διάλεξε το Mixtrack.",
  "Στο CrateMind, με δύο decks ανοιχτά, βάλε ένα κομμάτι να παίζει. Κράτα χαμηλά την ένταση στα ηχεία και στα ακουστικά.",
  "Πάτησε «Έναρξη δοκιμής». Στα ακουστικά πρέπει να ακούς ένα μπιπ κάθε δευτερόλεπτο. Στα ηχεία η μουσική πρέπει να συνεχίζει ακριβώς όπως πριν, χωρίς μπιπ.",
  "Όσο παίζει το μπιπ, άλλαξε στο Mac την έξοδο ήχου σε «Ηχεία MacBook». Άκου αν βγαίνει μπιπ από τα ηχεία του laptop και περίμενε 10 δευτερόλεπτα.",
  "Γύρνα την έξοδο ξανά στο Mixtrack, περίμενε 10 δευτερόλεπτα και μετά βγάλε το καλώδιο USB. Άκου πάλι αν βγαίνει μπιπ από τα ηχεία του laptop και περίμενε 10 δευτερόλεπτα.",
  "Πάτησε «Διακοπή» και μετά «Αντιγραφή αποτελεσμάτων». Στείλε μας το κείμενο, μαζί με τις απαντήσεις στις τρεις ερωτήσεις που έχει στο τέλος.",
];

/** How many channels the Mac's output gives now; null until the shared context has run. */
function useOutputChannels(): number | null {
  const [channels, setChannels] = useState<number | null>(null);
  useEffect(() => {
    const read = () => {
      const ctx = existingPlaybackContext();
      setChannels(ctx?.state === "running" ? ctx.destination.maxChannelCount : null);
    };
    read();
    const id = setInterval(read, 1000);
    return () => clearInterval(id);
  }, []);
  return channels;
}

/** «Έλεγχος εξόδου ακουστικών»: the one-time hardware check of `lib/cueProbe.ts`. macOS desktop app only. */
export function CueProbeSection() {
  if (!cueProbeSupported(isDesktopRuntime(), document.documentElement.dataset.nativeHost)) return null;
  return <CueProbeCard />;
}

function CueProbeCard() {
  const state = useSyncExternalStore(probe.subscribe, probe.snapshot);
  const channels = useOutputChannels();
  const log = useRef<HTMLTextAreaElement>(null);
  useEffect(() => () => { void probe.stop("left"); }, []);

  const idle = state.status === "idle";
  const running = state.status === "running";
  const report = idle && state.lines.length > 0 ? probeReport(state) : "";
  const verdict = probeVerdict(state);

  async function copy() {
    try {
      await navigator.clipboard.writeText(report);
    } catch {
      log.current?.select();
      if (!document.execCommand("copy")) {
        toast.error("Δεν έγινε αντιγραφή. Το κείμενο είναι επιλεγμένο: πάτησε ⌘C.");
        return;
      }
    }
    toast.success("Τα αποτελέσματα αντιγράφηκαν.");
  }

  return (
    <SettingsCard title="Έλεγχος εξόδου ακουστικών · Διαγνωστικό">
      <div className="space-y-3 px-4 pb-4 pt-2 text-xs leading-relaxed text-cm-muted">
        <p className="max-w-prose">
          Μια δοκιμή που γίνεται μία φορά, με το Mixtrack συνδεδεμένο. Δείχνει αν το CrateMind μπορεί να στείλει ήχο μόνο στα
          ακουστικά του Mixtrack, ενώ η μουσική συνεχίζει κανονικά στα ηχεία. Δεν αλλάζει καμία ρύθμιση: όταν σταματήσει, ο ήχος
          είναι όπως πριν. Σταματά μόνη της αν φύγεις από τη σελίδα ή μετά από 10 λεπτά.
        </p>
        <p role="status" className="text-cm-text">
          {channels === null
            ? "Δεν έχει μετρηθεί ακόμη· πάτησε αναπαραγωγή μία φορά."
            : channels >= 4
              ? `Η έξοδος ήχου του συστήματος δίνει ${channels} κανάλια.`
              : `Η έξοδος ήχου του συστήματος δίνει ${channels} κανάλια: τα 3–4 δεν είναι διαθέσιμα.`}
        </p>
        <ol className="max-w-prose list-decimal space-y-1 pl-5">
          {STEPS.map(step => <li key={step}>{step}</li>)}
        </ol>
        <div className="flex flex-wrap items-center gap-2">
          {running
            ? <Button variant="outline" size="sm" onClick={() => void probe.stop("user")}>Διακοπή</Button>
            : <Button variant="outline" size="sm" disabled={!idle} onClick={() => void probe.start()}>Έναρξη δοκιμής</Button>}
          <Button variant="outline" size="sm" disabled={!report} onClick={() => void copy()}>Αντιγραφή αποτελεσμάτων</Button>
          {running && (
            <span role="status" className="text-cm-cyan">
              Το μπιπ παίζει στα κανάλια 3–4 · {state.lines.length.toLocaleString("el-GR")} γραμμές καταγραφής
            </span>
          )}
        </div>
        {idle && state.failure && <p role="alert" className="max-w-prose text-cm-amber">{PROBE_FAILURE_TEXT[state.failure]}</p>}
        {verdict && <p className="max-w-prose text-cm-text">{verdict}</p>}
        {report && (
          <textarea
            ref={log}
            readOnly
            rows={8}
            value={report}
            aria-label="Αποτελέσματα ελέγχου"
            className="w-full resize-y rounded-md border surface-field p-2 font-mono text-[11px] leading-snug text-cm-text"
          />
        )}
      </div>
    </SettingsCard>
  );
}
