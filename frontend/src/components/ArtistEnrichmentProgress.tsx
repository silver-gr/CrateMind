import { useEffect, useState } from "react";
import type { Job } from "../lib/types";
import type { JobConnection } from "../lib/jobPolling";
import { artistEnrichmentProgress } from "../lib/artistEnrichmentProgress";

export function ArtistEnrichmentProgress({ job, connection }: { job: Job; connection: JobConnection }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (job.status !== "running") return;
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, [job.id, job.status]);
  const progress = artistEnrichmentProgress(job, now);
  const retrying = connection === "retrying";
  const parts: string[] = [];
  if (progress.percent !== null) parts.push(`${progress.percent}%`);
  if (progress.total !== null) parts.push(`${progress.processed}/${progress.total} επεξεργασμένοι`);
  if (job.status === "done") parts.push("Η έρευνα ολοκληρώθηκε");
  else if (job.status === "error") parts.push(progress.percent === 100 ? "Ολοκληρώθηκε με σφάλματα" : "Η έρευνα διακόπηκε");
  else if (retrying) parts.push("Επανασύνδεση…");
  else if (job.status === "pending" || progress.total === null) parts.push("Προετοιμασία έρευνας…");
  else {
    if (progress.artist) parts.push(`Τώρα: «${progress.artist}»`);
    if (progress.remainingMinutes !== null) parts.push(`Απομένουν ≈${progress.remainingMinutes} ${progress.remainingMinutes === 1 ? "λεπτό" : "λεπτά"}`);
    else if (progress.processed >= progress.total) parts.push("Ολοκλήρωση έρευνας…");
    else parts.push("Υπολογισμός χρόνου…");
  }
  const description = parts.join(" · ");
  return (
    <div className="min-w-0 w-full max-w-xl space-y-1.5 sm:w-auto sm:flex-1">
      <p role="status" aria-live="polite" aria-atomic="true" className="break-words text-xs tabular-nums text-cm-muted">{description}</p>
      <div
        role="progressbar"
        aria-label="Πρόοδος έρευνας ειδών"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percent ?? undefined}
        aria-valuetext={description}
        className="h-1 overflow-hidden rounded-full bg-white/10"
      >
        <div className="h-full rounded-full bg-cm-cyan" style={{ width: `${progress.percent ?? 0}%` }} />
      </div>
    </div>
  );
}
