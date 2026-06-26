import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { usePlayer } from "../lib/player";
import type { Profile, Track } from "../lib/types";

const QUEUES: { label: string; q: string }[] = [
  { label: "Untagged", q: "untagged" },
  { label: "Testing", q: "testing" },
  { label: "All", q: "" },
];

const HELP = [
  ["1–9 / 0", "energy 1–10"],
  ["Shift+1–0", "darkness 1–10"],
  ["M", "melodic"],
  ["B / P / R", "bridge / peak / reset"],
  ["W / A / X", "weapon / approved / avoid"],
  ["J / K", "next / prev"],
];

export default function TaggingQueue() {
  const [queue, setQueue] = useState("untagged");
  const [tracks, setTracks] = useState<Track[]>([]);
  const [idx, setIdx] = useState(0);
  const [flash, setFlash] = useState<string>("");
  const { play } = usePlayer();

  const load = useCallback(async (q: string) => {
    const t = await api.listTracks(q);
    setTracks(t);
    setIdx(0);
  }, []);

  useEffect(() => {
    load(queue);
  }, [queue, load]);

  const current = tracks[idx];

  const apply = useCallback(
    async (patch: Partial<Profile>, label: string) => {
      if (!current) return;
      await api.updateProfile(current.id, patch);
      setFlash(`${current.title || current.file_name}: ${label}`);
    },
    [current],
  );

  const move = useCallback(
    (delta: number) => {
      setIdx((i) => Math.min(Math.max(i + delta, 0), Math.max(tracks.length - 1, 0)));
    },
    [tracks.length],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (!current) return;
      const k = e.key;

      if (/^[0-9]$/.test(k)) {
        const val = k === "0" ? 10 : Number(k);
        if (e.shiftKey) apply({ darkness: val }, `darkness ${val}`);
        else apply({ energy: val }, `energy ${val}`);
        e.preventDefault();
        return;
      }
      switch (k.toLowerCase()) {
        case "m": apply({ melody: 8 }, "melodic"); break;
        case "b": apply({ set_role: "bridge" }, "role bridge"); break;
        case "p": apply({ set_role: "peak" }, "role peak"); break;
        case "r": apply({ set_role: "reset" }, "role reset"); break;
        case "w": apply({ personal_status: "weapon" }, "WEAPON"); break;
        case "a": apply({ personal_status: "approved" }, "approved"); break;
        case "x": apply({ personal_status: "avoid" }, "avoid"); break;
        case "j": move(1); break;
        case "k": move(-1); break;
        default: return;
      }
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, apply, move]);

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col items-center justify-center p-8">
        <div className="mb-4 flex gap-1">
          {QUEUES.map((qd) => (
            <button
              key={qd.label}
              onClick={() => setQueue(qd.q)}
              className={`rounded px-3 py-1 text-sm ${
                queue === qd.q ? "bg-emerald-600" : "bg-neutral-800 hover:bg-neutral-700"
              }`}
            >
              {qd.label}
            </button>
          ))}
        </div>

        {current ? (
          <div className="w-full max-w-xl rounded-lg border border-neutral-800 bg-neutral-900 p-6 text-center">
            <div className="text-xs text-neutral-500">
              {idx + 1} / {tracks.length}
            </div>
            <div className="mt-2 text-2xl font-semibold">
              {current.title || current.file_name}
            </div>
            <div className="text-lg text-neutral-400">{current.artist || "Unknown artist"}</div>
            <div className="mt-2 text-sm text-neutral-500">
              {current.bpm ? `${current.bpm.toFixed(0)} BPM` : "no BPM"} ·{" "}
              {current.key_text || "no key"} · {current.genre || "no genre"} · {current.extension}
            </div>
            <div className="mt-3 truncate text-xs text-neutral-700" title={current.absolute_path}>
              {current.absolute_path}
            </div>
            <div className="mt-4 flex justify-center gap-2">
              <button onClick={() => move(-1)} className="rounded bg-neutral-800 px-4 py-1.5 text-sm">
                ◀ K
              </button>
              <button
                onClick={() => play(current)}
                className="rounded bg-emerald-700 px-4 py-1.5 text-sm hover:bg-emerald-600"
                title="Audition (then Space to play/pause)"
              >
                ▶ Audition
              </button>
              <button onClick={() => move(1)} className="rounded bg-neutral-800 px-4 py-1.5 text-sm">
                J ▶
              </button>
            </div>
            {flash && <div className="mt-4 text-sm text-emerald-400">{flash}</div>}
          </div>
        ) : (
          <div className="text-neutral-600">Queue empty. Nice — nothing left to tag here.</div>
        )}
      </div>

      <aside className="w-64 shrink-0 border-l border-neutral-800 bg-neutral-950 p-4">
        <div className="mb-3 text-sm font-semibold text-neutral-300">Keyboard</div>
        <table className="w-full text-xs">
          <tbody>
            {HELP.map(([k, v]) => (
              <tr key={k}>
                <td className="py-1 pr-2 font-mono text-emerald-400">{k}</td>
                <td className="py-1 text-neutral-400">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-4 text-xs text-neutral-600">
          Each key writes immediately. No dropdown bureaucracy.
        </p>
      </aside>
    </div>
  );
}
