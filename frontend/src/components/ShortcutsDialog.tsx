import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { KeyboardHint } from "./ui/KeyboardHint";

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
            <KeyboardHint keys={["1–9", "0"]} label="Ένταση 1–10" />
            <KeyboardHint keys={["Shift", "1–0"]} label="Σκοτεινότητα" />
            <KeyboardHint keys={["M"]} label="Μελωδικό" />
            <KeyboardHint keys={["B", "P", "R"]} label="Γέφυρα / Κορύφωση / Reset" />
            <KeyboardHint keys={["W", "A", "X"]} label="Όπλο / Εγκεκρ. / Απόφυγε" />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
