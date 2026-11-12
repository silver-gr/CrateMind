import type { Track } from "../lib/types";
import { SectionHeader } from "./ui/SectionHeader";
import { Textarea } from "./ui/textarea";

export function TrackNotes({ track, notes, onChange }: {
  track: Pick<Track, "comment" | "metadata_comments">;
  notes: string;
  onChange: (notes: string) => void;
}) {
  const sourceComments = track.metadata_comments ?? [];
  return (
    <section className="space-y-3 border-t border-cm-line/20 pt-3">
      <div>
        <SectionHeader>Προσωπικές σημειώσεις</SectionHeader>
        <Textarea
          aria-label="Προσωπικές σημειώσεις"
          value={notes}
          onChange={(event) => onChange(event.target.value)}
          rows={3}
          placeholder="Ιδέες για το set, cue points, σημεία προσοχής…"
          className="resize-none text-sm leading-relaxed text-cm-text placeholder:text-cm-faint focus-visible:border-cm-cyan/40 focus-visible:ring-cm-cyan/20"
        />
      </div>
      {(track.comment || sourceComments.length > 0) && (
        <div className="space-y-2 rounded-lg bg-cm-contrast/5 px-3 py-2.5 text-xs text-cm-muted">
          <p className="font-semibold text-cm-text">Σχόλια πηγών</p>
          {track.comment && (
            <div>
              <p className="text-cm-faint">Σχόλιο αρχείου</p>
              <p className="whitespace-pre-wrap wrap-anywhere">{track.comment}</p>
            </div>
          )}
          {sourceComments.length > 0 && (
            <div>
              <p className="text-cm-faint">Τεχνικές παρατηρήσεις από τα στοιχεία πηγής</p>
              <ul className="list-disc space-y-1 wrap-anywhere pl-4">
                {sourceComments.map(({ kind, text, source_id }) => (
                  <li key={JSON.stringify([kind, text, source_id])}>{text}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
