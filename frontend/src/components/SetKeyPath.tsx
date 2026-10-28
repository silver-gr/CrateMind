import { useState } from "react";
import { setKeyRuns } from "../lib/setStats";
import type { SetTrackRow } from "../lib/types";
import { KeyBadge } from "./ui/KeyBadge";

export default function SetKeyPath({ rows, onJump, disabled = false }: {
  rows: SetTrackRow[];
  onJump: (position: number) => void;
  disabled?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const runs = setKeyRuns(rows.map(row => row.track));
  const known = runs.reduce((sum, run) => sum + (run.code ? run.end - run.start + 1 : 0), 0);
  if (!rows.length) return null;
  const visible = expanded ? runs : runs.slice(0, 6);
  return (
    <section aria-label="Διαδρομή key" className="mt-4 border-t border-cm-border pt-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-cm-text">Διαδρομή key</h3>
        <span className="text-[10px] tabular-nums text-cm-muted">{known}/{rows.length} tracks με key</span>
      </div>
      <p className="mb-2 mt-1 text-[11px] leading-relaxed text-cm-faint">
        Ίδια διαδοχικά keys ενώνονται. Πάτησε για μετάβαση στο track.
      </p>
      <ol className="grid max-h-64 grid-cols-2 gap-1.5 overflow-y-auto p-0.5">
        {visible.map(run => {
          const range = run.start === run.end ? `${run.start + 1}` : `${run.start + 1}–${run.end + 1}`;
          const track = rows[run.start].track;
          return (
            <li key={rows[run.start].position}>
              <button type="button" disabled={disabled} onClick={() => onJump(rows[run.start].position)}
                aria-label={`Μετάβαση στο track ${run.start + 1}: ${run.code ?? "χωρίς key"}`}
                title={`${track.title || track.file_name}${run.end > run.start ? ` · ${run.end - run.start + 1} tracks στο ίδιο key` : ""}`}
                className="flex w-full items-center justify-between gap-2 rounded-lg border border-cm-border bg-cm-panel/50 px-2 py-2 text-left transition-colors hover:border-cm-cyan/40 hover:bg-cm-cyan/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-cyan disabled:opacity-40">
                <span className="font-mono text-[10px] tabular-nums text-cm-muted">#{range}</span>
                <KeyBadge keyText={run.code} className="min-w-9" />
              </button>
            </li>
          );
        })}
      </ol>
      {runs.length > 6 && (
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}
          className="mt-2 w-full rounded-md border border-cm-border bg-black/5 py-1.5 text-xs text-cm-cyan transition-colors hover:border-cm-cyan/35 hover:bg-cm-cyan/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-cyan dark:bg-white/5 dark:hover:bg-cm-cyan/15">
          {expanded ? "Σύμπτυξη" : `Όλη η διαδρομή · ${runs.length} ομάδες`}
        </button>
      )}
    </section>
  );
}
