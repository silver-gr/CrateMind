import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import type { DuplicateGroup, Job } from "../lib/types";

function fmtDur(s?: number | null) {
  if (!s) return "--:--";
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
}

export default function Duplicates() {
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [scanning, setScanning] = useState(false);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    setGroups(await api.listDuplicates());
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function runScan() {
    setScanning(true);
    setMsg("Scanning for duplicates…");
    const job = await api.startDuplicateScan();
    let st: Job | null = job;
    for (let i = 0; i < 120 && st && st.status !== "done" && st.status !== "error"; i++) {
      await new Promise((r) => setTimeout(r, 500));
      st = await api.scanStatus(job.id);
    }
    setMsg(st?.message || st?.error || "done");
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
        <h2 className="text-lg font-semibold">Duplicate Review</h2>
        <button
          onClick={runScan}
          disabled={scanning}
          className="rounded bg-emerald-700 px-3 py-1.5 text-sm hover:bg-emerald-600 disabled:opacity-50"
        >
          {scanning ? "Scanning…" : "Run detection"}
        </button>
        <span className="text-xs text-neutral-500">{msg}</span>
        <span className="ml-auto text-xs text-neutral-500">{groups.length} groups to review</span>
      </div>

      <p className="mb-4 text-xs text-neutral-600">
        Files are never deleted or moved. You pick a master copy and mark the group resolved —
        CrateMind only records the decision.
      </p>

      <div className="space-y-4">
        {groups.map((g) => (
          <div key={g.id} className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <div className="mb-2 text-xs uppercase tracking-wide text-neutral-500">{g.reason}</div>
            <table className="w-full text-sm">
              <tbody>
                {g.tracks.map((t) => (
                  <tr key={t.track_id} className="border-b border-neutral-800/50">
                    <td className="py-1.5 pr-3">
                      {t.artist} — {t.title}
                    </td>
                    <td className="py-1.5 pr-3 tabular-nums text-neutral-400">{fmtDur(t.duration)}</td>
                    <td className="py-1.5 pr-3 text-neutral-400">{t.bpm ? `${t.bpm.toFixed(0)} BPM` : ""}</td>
                    <td className="py-1.5 pr-3 text-neutral-600">{t.extension}</td>
                    <td className="max-w-xs truncate py-1.5 pr-3 text-xs text-neutral-700" title={t.absolute_path}>
                      {t.absolute_path}
                    </td>
                    <td className="py-1.5 text-right">
                      <button
                        onClick={() => resolve(g, t.track_id, "resolved")}
                        className="rounded bg-emerald-800 px-2 py-0.5 text-xs hover:bg-emerald-700"
                      >
                        master + resolve
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => resolve(g, null, "ignored")}
                className="rounded bg-neutral-800 px-2 py-1 text-xs hover:bg-neutral-700"
              >
                Not a duplicate (ignore)
              </button>
            </div>
          </div>
        ))}
        {groups.length === 0 && (
          <div className="text-sm text-neutral-600">
            No duplicate groups pending. Run detection to scan the library.
          </div>
        )}
      </div>
    </div>
  );
}
