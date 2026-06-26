import type { Track } from "../lib/types";

function fmtDur(s?: number | null) {
  if (!s) return "--:--";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

interface Props {
  tracks: Track[];
  selectedId?: number;
  onSelect: (id: number) => void;
  onAdd?: (id: number) => void;
}

export default function TrackTable({ tracks, selectedId, onSelect, onAdd }: Props) {
  return (
    <div className="h-full overflow-auto">
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 bg-neutral-900 text-left text-xs uppercase text-neutral-500">
          <tr>
            <th className="px-3 py-2 font-medium">Artist</th>
            <th className="px-3 py-2 font-medium">Title</th>
            <th className="px-3 py-2 font-medium">BPM</th>
            <th className="px-3 py-2 font-medium">Key</th>
            <th className="px-3 py-2 font-medium">Len</th>
            <th className="px-3 py-2 font-medium">Type</th>
            {onAdd && <th className="px-3 py-2" />}
          </tr>
        </thead>
        <tbody>
          {tracks.map((t) => (
            <tr
              key={t.id}
              onClick={() => onSelect(t.id)}
              className={`cursor-pointer border-b border-neutral-800/60 ${
                t.id === selectedId ? "bg-emerald-900/30" : "hover:bg-neutral-800/40"
              } ${t.missing ? "opacity-40" : ""}`}
            >
              <td className="px-3 py-1.5 text-neutral-300">{t.artist || "—"}</td>
              <td className="px-3 py-1.5">
                {t.title || t.file_name}
                {t.missing && <span className="ml-2 text-xs text-red-400">(missing)</span>}
              </td>
              <td className="px-3 py-1.5 tabular-nums text-neutral-400">
                {t.bpm ? t.bpm.toFixed(0) : "—"}
              </td>
              <td className="px-3 py-1.5 text-neutral-400">{t.key_text || "—"}</td>
              <td className="px-3 py-1.5 tabular-nums text-neutral-500">{fmtDur(t.duration)}</td>
              <td className="px-3 py-1.5 text-neutral-600">{t.extension}</td>
              {onAdd && (
                <td className="px-3 py-1.5">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onAdd(t.id);
                    }}
                    className="rounded bg-emerald-700 px-2 py-0.5 text-xs hover:bg-emerald-600"
                  >
                    + add
                  </button>
                </td>
              )}
            </tr>
          ))}
          {tracks.length === 0 && (
            <tr>
              <td colSpan={7} className="px-3 py-8 text-center text-neutral-600">
                No tracks. Run a scan from Settings, or adjust your filter.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
