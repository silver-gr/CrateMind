import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import type { SavedSearch } from "../lib/types";

interface Queue {
  label: string;
  query: string;
  to: string;
  hint: string;
}

// Built-in review queues (the dashboard cards from the v1.1 spec).
const QUEUES: Queue[] = [
  {
    label: "Forgotten Approved",
    query: "status:approved not_recent:90",
    to: "/library?q=" + encodeURIComponent("status:approved not_recent:90"),
    hint: "approved, not played in 90 days",
  },
  {
    label: "Approved Never Played",
    query: "status:approved never_played",
    to: "/library?q=" + encodeURIComponent("status:approved never_played"),
    hint: "approved but never aired",
  },
  {
    label: "New Untagged",
    query: "untagged",
    to: "/tag",
    hint: "needs classification",
  },
  {
    label: "Long Break Candidates",
    query: "break:long",
    to: "/library?q=" + encodeURIComponent("break:long"),
    hint: "long melodic breakdowns",
  },
  {
    label: "Weapons",
    query: "weapons",
    to: "/library?q=weapons",
    hint: "proven, high-confidence",
  },
];

export default function Dashboard() {
  const nav = useNavigate();
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [dupes, setDupes] = useState(0);
  const [crates, setCrates] = useState<SavedSearch[]>([]);

  const load = useCallback(async () => {
    const entries = await Promise.all(
      QUEUES.map(async (q) => [q.label, (await api.trackCount(q.query)).count] as const),
    );
    setCounts(Object.fromEntries(entries));
    setDupes((await api.listDuplicates()).length);
    setCrates(await api.listSearches());
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="h-full overflow-auto p-6">
      <h2 className="mb-1 text-lg font-semibold">Dashboard</h2>
      <p className="mb-5 text-xs text-neutral-500">
        Review queues + Memory Crates. Counts are live over your tags.
      </p>

      <div className="mb-3 text-xs uppercase tracking-wide text-neutral-500">Review queues</div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {QUEUES.map((q) => (
          <button
            key={q.label}
            onClick={() => nav(q.to)}
            className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 text-left hover:border-emerald-700"
          >
            <div className="text-3xl font-bold tabular-nums text-emerald-400">
              {counts[q.label] ?? "…"}
            </div>
            <div className="mt-1 text-sm font-medium text-neutral-200">{q.label}</div>
            <div className="text-xs text-neutral-500">{q.hint}</div>
          </button>
        ))}
        <button
          onClick={() => nav("/duplicates")}
          className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 text-left hover:border-amber-700"
        >
          <div className="text-3xl font-bold tabular-nums text-amber-400">{dupes}</div>
          <div className="mt-1 text-sm font-medium text-neutral-200">Duplicate Suspects</div>
          <div className="text-xs text-neutral-500">groups to review</div>
        </button>
      </div>

      <div className="mt-7 mb-3 flex items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-neutral-500">Memory Crates</span>
        <span className="text-xs text-neutral-600">— saved searches, save one from the Library</span>
      </div>
      {crates.length === 0 ? (
        <div className="text-sm text-neutral-600">
          No crates yet. In the Library, build a search and hit <b>Save as crate</b>.
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {crates.map((c) => (
            <div
              key={c.id}
              className="group rounded-lg border border-neutral-800 bg-neutral-900 p-4"
            >
              <button
                onClick={() => nav("/library?q=" + encodeURIComponent(c.query))}
                className="block w-full text-left"
              >
                <div className="text-3xl font-bold tabular-nums text-emerald-400">{c.count}</div>
                <div className="mt-1 text-sm font-medium text-neutral-200">
                  {c.pinned ? "📌 " : ""}{c.name}
                </div>
                <div className="truncate text-xs text-neutral-600" title={c.query}>{c.query}</div>
              </button>
              <button
                onClick={async () => {
                  await api.deleteSearch(c.id);
                  load();
                }}
                className="mt-2 text-xs text-neutral-600 opacity-0 group-hover:opacity-100 hover:text-red-400"
              >
                delete crate
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
