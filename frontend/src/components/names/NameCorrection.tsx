import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { correctionInput } from "../../lib/names";
import { Loader2, Save } from "../../lib/icons";

/** «Διόρθωση»: the owner's own artist and title for one track, inline. The artist field takes the focus;
 *  Enter saves, Escape closes (the host then puts the focus back on the button that opened it). */
export function NameCorrection({ artist, title, busy, onSave, onCancel, artistLabel = "Καλλιτέχνης" }: {
  artist: string;
  title: string;
  busy: boolean;
  onSave: (artist: string, title: string) => void;
  onCancel: () => void;
  artistLabel?: string;
}) {
  const [a, setA] = useState(artist);
  const [t, setT] = useState(title);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  const value = correctionInput(a, t);

  return (
    <form
      className="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
      onSubmit={event => {
        event.preventDefault();
        if (value && !busy) onSave(value.artist, value.title);
      }}
      onKeyDown={event => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <label className="grid gap-1 text-[11px] text-cm-muted">
        {artistLabel}
        <Input ref={first} value={a} onChange={e => setA(e.target.value)} maxLength={500} className="h-8" />
      </label>
      <label className="grid gap-1 text-[11px] text-cm-muted">
        Τίτλος
        <Input value={t} onChange={e => setT(e.target.value)} maxLength={500} className="h-8" />
      </label>
      <div className="flex gap-1.5">
        <Button type="submit" size="sm" variant="soft" disabled={!value || busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Save />}
          Αποθήκευση
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>Άκυρο</Button>
      </div>
    </form>
  );
}
