import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { translateDuplicateReason } from "../lib/labels";
import type { DuplicateGroup, Job } from "../lib/types";
import { GlassPanel } from "../components/ui/GlassPanel";
import { SectionHeader } from "../components/ui/SectionHeader";
import { EmptyState } from "../components/ui/EmptyState";
import { Boxes, CheckCircle2, Ban, Loader2, Crosshair } from "../lib/icons";

function fmtDur(s?: number | null) {
  if (!s) return "--:--";
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
}

export default function Duplicates() {
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [scanning, setScanning] = useState(false);

  const load = useCallback(async () => {
    setGroups(await api.listDuplicates());
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function runScan() {
    setScanning(true);
    toast.info("Scan για διπλότυπα…");
    const job = await api.startDuplicateScan();
    let st: Job | null = job;
    for (let i = 0; i < 120 && st && st.status !== "done" && st.status !== "error"; i++) {
      await new Promise((r) => setTimeout(r, 500));
      st = await api.scanStatus(job.id);
    }
    if (st?.status === "error") toast.error(st?.error || "Το scan διπλοτύπων απέτυχε");
    else toast.success(st?.message || "Το scan διπλοτύπων ολοκληρώθηκε");
    setScanning(false);
    load();
  }

  async function resolve(g: DuplicateGroup, masterId: number | null, status: string) {
    await api.resolveDuplicate(g.id, {
      status,
      master_track_id: masterId ?? undefined,
    });
    load();
  }

  return (
    <div className="h-full overflow-auto p-5">
      <div className="mb-4 flex items-center gap-3">
        <h2 className="text-lg font-semibold text-cm-text">Έλεγχος διπλοτύπων</h2>
        <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-xs tabular-nums text-cm-muted">
          {groups.length} ομάδες
        </span>
        <button
          onClick={runScan}
          disabled={scanning}
          className="ml-auto inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-cm-cyan/25 bg-cm-cyan/12 px-3 py-1.5 text-sm font-medium text-cm-cyan transition hover:bg-cm-cyan/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {scanning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Crosshair className="h-3.5 w-3.5" />}
          {scanning ? "Scan…" : "Εντοπισμός"}
        </button>
      </div>

      <p className="mb-4 max-w-2xl text-xs leading-relaxed text-cm-faint">
        Τα αρχεία δεν διαγράφονται ούτε μετακινούνται. Διάλεξε master copy και σημείωσε την ομάδα ως λυμένη —
        το CrateMind καταγράφει μόνο την απόφαση.
      </p>

      {groups.length === 0 ? (
        <EmptyState icon={Boxes} title="Δεν υπάρχουν ομάδες διπλοτύπων">
          Τρέξε εντοπισμό για scan της βιβλιοθήκης.
        </EmptyState>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => (
            <GlassPanel key={g.id} className="p-4">
              <SectionHeader>{g.reason ? translateDuplicateReason(g.reason) : "Πιθανό διπλότυπο"}</SectionHeader>
              <div className="space-y-1.5">
                {g.tracks.map((t) => (
                  <div
                    key={t.track_id}
                    className="grid grid-cols-[1fr_auto] items-center gap-x-4 rounded-xl border border-white/8 bg-white/[0.02] px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                        <span className="truncate text-sm text-cm-text">
                          <span className="text-cm-muted">{t.artist}</span>
                          {t.artist && t.title ? " — " : ""}
                          {t.title}
                        </span>
                        <span className="font-mono text-xs tabular-nums text-cm-muted">{fmtDur(t.duration)}</span>
                        {t.bpm ? (
                          <span className="font-mono text-xs tabular-nums text-cm-cyan">{t.bpm.toFixed(0)} BPM</span>
                        ) : null}
                        <span className="font-mono text-[11px] uppercase tracking-wide text-cm-faint">{t.extension}</span>
                      </div>
                      <div className="truncate font-mono text-[11px] text-cm-faint" title={t.absolute_path}>
                        {t.absolute_path}
                      </div>
                    </div>
                    <button
                      onClick={() => resolve(g, t.track_id, "resolved")}
                      className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-cm-chartreuse/25 bg-cm-chartreuse/12 px-2.5 py-1 text-xs font-medium text-cm-chartreuse transition hover:bg-cm-chartreuse/20"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      master + επίλυση
                    </button>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex">
                <button
                  onClick={() => resolve(g, null, "ignored")}
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-medium text-cm-muted transition hover:bg-white/10"
                >
                  <Ban className="h-3.5 w-3.5" />
                  Δεν είναι διπλότυπο (αγνόηση)
                </button>
              </div>
            </GlassPanel>
          ))}
        </div>
      )}
    </div>
  );
}
