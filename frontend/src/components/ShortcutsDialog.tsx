import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { KeyboardHint } from "./ui/KeyboardHint";
import { queueShortcuts } from "../lib/tagKeys";

/** The rating, status and role sections of the /tag key table (listening and navigation are shown above). */
const TAGGING_SECTIONS = new Set(["Βαθμολογία", "Κατάσταση", "Ρόλος"]);

function typingInField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el?.tagName) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
}

/** App-wide keyboard shortcuts sheet, toggled with ? (Shift + /) anywhere outside a text field. */
export default function ShortcutsDialog() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "?" || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || typingInField(e.target)) return;
      e.preventDefault();
      setOpen((o) => !o);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="glass border-white/10 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Συντομεύσεις Πληκτρολογίου</DialogTitle>
          <DialogDescription>Άνοιγμα και κλείσιμο με ? (Shift + /).</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-3">
          <div>
            <p className="mb-2 text-[10px] uppercase tracking-wider text-cm-faint">Αναζήτηση & πλοήγηση</p>
            <KeyboardHint keys={["⌘", "K"]} label="Παλέτα εντολών" />
            <KeyboardHint keys={["J"]} label="Επόμενο κομμάτι" />
            <KeyboardHint keys={["K"]} label="Προηγούμενο κομμάτι" />
            <KeyboardHint keys={["Esc"]} label="Κλείσιμο διαλόγου" />
            <KeyboardHint keys={["?"]} label="Συντομεύσεις" />
          </div>
          <div>
            <p className="mb-2 text-[10px] uppercase tracking-wider text-cm-faint">Αναπαραγωγή</p>
            <KeyboardHint keys={["Space"]} label="Αναπαραγωγή / Παύση" />
            <KeyboardHint keys={["←", "→"]} label="Seek ∓5 δευτ." />
            <KeyboardHint keys={["Shift", "←/→"]} label="Seek ∓30 δευτ." />
          </div>
          <div>
            <p className="mb-2 text-[10px] uppercase tracking-wider text-cm-faint">Tagging (στην ουρά)</p>
            {queueShortcuts().filter(group => TAGGING_SECTIONS.has(group.section)).flatMap(group => group.rows).map(row => (
              <KeyboardHint key={row.label} keys={row.keys} label={row.label} />
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
