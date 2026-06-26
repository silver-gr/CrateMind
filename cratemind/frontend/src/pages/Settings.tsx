import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Job } from "../lib/types";

export default function Settings() {
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    setSettings(await api.settings());
    setJob(await api.scanStatus());
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function poll(jobId: number) {
    let st: Job | null = null;
    for (let i = 0; i < 600; i++) {
      st = await api.scanStatus(jobId);
      setJob(st);
      if (st && (st.status === "done" || st.status === "error")) break;
      await new Promise((r) => setTimeout(r, 700));
    }
    setBusy(false);
  }

  async function runScan() {
    setBusy(true);
    setMsg("");
    try {
      const j = await api.startScan();
      poll(j.id);
    } catch (e) {
      setMsg((e as Error).message);
      setBusy(false);
    }
  }

  async function runFingerprint() {
    setBusy(true);
    try {
      const j = await api.startFingerprint();
      poll(j.id);
    } catch (e) {
      setMsg((e as Error).message);
      setBusy(false);
    }
  }

  async function backup() {
    const r = await api.exportArtifact("json-backup", { overwrite: true });
    setMsg(`Backup written → ${r.path}`);
  }

  const roots = (settings?.library_roots as string[]) ?? [];

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6 text-sm">
      <h2 className="text-lg font-semibold">Settings</h2>

      <section className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
        <div className="mb-2 text-xs uppercase text-neutral-500">Library</div>
        {roots.length ? (
          <ul className="space-y-1">
            {roots.map((r) => (
              <li key={r} className="font-mono text-neutral-300">{r}</li>
            ))}
          </ul>
        ) : (
          <div className="text-amber-400">
            No library roots configured. Set <code>CRATEMIND_LIBRARY_ROOTS</code> in{" "}
            <code>backend/.env</code> and restart the backend.
          </div>
        )}
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-neutral-400">
          <div>ffprobe: {settings?.ffprobe ? <span className="text-emerald-400">found</span> : <span className="text-red-400">missing</span>}</div>
          <div>fpcalc: {settings?.fpcalc ? <span className="text-emerald-400">found</span> : <span className="text-neutral-500">none (optional)</span>}</div>
          <div className="col-span-2">DB: <span className="font-mono">{String(settings?.db_path ?? "")}</span></div>
          <div className="col-span-2">Output: <span className="font-mono">{String(settings?.output_dir ?? "")}</span></div>
        </div>
      </section>

      <section className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
        <div className="mb-3 text-xs uppercase text-neutral-500">Actions</div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={runScan}
            disabled={busy || roots.length === 0}
            className="rounded bg-emerald-700 px-3 py-1.5 hover:bg-emerald-600 disabled:opacity-40"
          >
            {busy ? "Working…" : "Scan library"}
          </button>
          <button
            onClick={runFingerprint}
            disabled={busy || !settings?.fpcalc}
            className="rounded bg-neutral-800 px-3 py-1.5 hover:bg-neutral-700 disabled:opacity-40"
          >
            Fingerprint (fpcalc)
          </button>
          <button onClick={backup} className="rounded bg-neutral-800 px-3 py-1.5 hover:bg-neutral-700">
            JSON backup
          </button>
        </div>
        {job && (
          <div className="mt-3 text-xs">
            <span className="text-neutral-500">last job:</span> {job.kind} —{" "}
            <span
              className={
                job.status === "done"
                  ? "text-emerald-400"
                  : job.status === "error"
                  ? "text-red-400"
                  : "text-amber-400"
              }
            >
              {job.status}
            </span>{" "}
            {job.message && <span className="text-neutral-400">({job.message})</span>}
            {job.error && <span className="text-red-400">({job.error})</span>}
            {job.status === "running" && job.processed > 0 && (
              <span className="text-neutral-500"> · {job.processed} files</span>
            )}
          </div>
        )}
        {msg && <div className="mt-2 text-xs text-neutral-400">{msg}</div>}
      </section>
    </div>
  );
}
