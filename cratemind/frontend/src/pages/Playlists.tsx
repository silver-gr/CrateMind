import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { toast } from "sonner";
import { api } from "../lib/api";
import type { DJSet } from "../lib/types";
import { GlassCard } from "../components/ui/GlassCard";
import { SectionHeader } from "../components/ui/SectionHeader";
import { EmptyState } from "../components/ui/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Music4, Plus, Loader2, Download, Calendar } from "../lib/icons";

/** Hidden system set used by the Flow Finder — never shown to the user. */
const SYSTEM_TITLE = "Flow scratch";

function fmtDate(d?: string | null): string | null {
  if (!d) return null;
  try {
    return new Date(d).toLocaleDateString("el-GR", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return d;
  }
}

export default function Playlists() {
  const navigate = useNavigate();
  const [sets, setSets] = useState<DJSet[]>([]);
  const [loading, setLoading] = useState(true);

  // Inline create
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [saving, setSaving] = useState(false);

  // Which set is currently exporting (by id)
  const [exporting, setExporting] = useState<number | null>(null);

  const [gridRef] = useAutoAnimate<HTMLDivElement>();

  const load = useCallback(async () => {
    try {
      const data = await api.listSets();
      // Hide the system scratch set used by Flow Finder
      setSets(data.filter((s) => s.title !== SYSTEM_TITLE));
    } catch {
      toast.error("Αποτυχία φόρτωσης sets");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCreate() {
    if (!newTitle.trim()) return;
    setSaving(true);
    try {
      const s = await api.createSet(newTitle.trim());
      setSets((prev) => [s, ...prev]);
      setNewTitle("");
      setCreating(false);
      toast.success(`Set "${s.title}" δημιουργήθηκε`);
    } catch {
      toast.error("Αποτυχία δημιουργίας set");
    } finally {
      setSaving(false);
    }
  }

  async function handleExport(s: DJSet, fmt: "m3u" | "csv" | "markdown") {
    setExporting(s.id);
    try {
      const res = await api.exportArtifact(fmt, { set_id: s.id });
      toast.success(`Export OK → ${res.path}`);
    } catch {
      toast.error(`Αποτυχία export (${fmt.toUpperCase()})`);
    } finally {
      setExporting(null);
    }
  }

  return (
    <div className="h-full overflow-auto p-5">
      {/* Page header */}
      <div className="mb-5 flex items-center gap-3">
        <Music4 className="h-5 w-5 text-cm-violet" />
        <h1 className="text-lg font-semibold text-cm-text">DJ Sets</h1>
        <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-xs tabular-nums text-cm-muted">
          {sets.length}
        </span>
        <Button
          onClick={() => setCreating((v) => !v)}
          variant="outline"
          size="sm"
          className="ml-auto gap-1.5 border-cm-violet/25 bg-cm-violet/12 font-medium text-cm-violet hover:bg-cm-violet/20 hover:text-cm-violet"
        >
          <Plus className="h-3.5 w-3.5" />
          Νέο Set
        </Button>
      </div>

      {/* Inline create form */}
      {creating && (
        <div className="mb-5 rounded-2xl border border-cm-violet/20 bg-cm-violet/5 p-4">
          <SectionHeader>Νέο DJ Set</SectionHeader>
          <div className="flex gap-2">
            <Input
              autoFocus
              placeholder="Τίτλος set…"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
                if (e.key === "Escape") setCreating(false);
              }}
              className="flex-1 border-white/10 bg-white/5 text-cm-text placeholder:text-cm-faint"
            />
            <Button
              onClick={handleCreate}
              disabled={saving || !newTitle.trim()}
              variant="outline"
              size="sm"
              className="gap-1.5 border-cm-violet/25 bg-cm-violet/12 font-medium text-cm-violet hover:bg-cm-violet/20 hover:text-cm-violet disabled:opacity-40"
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              Δημιουργία
            </Button>
            <Button
              onClick={() => setCreating(false)}
              variant="outline"
              size="sm"
              className="border-white/10 bg-white/5 text-cm-muted hover:bg-white/10"
            >
              Ακύρωση
            </Button>
          </div>
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-cm-faint" />
        </div>
      ) : sets.length === 0 ? (
        <EmptyState
          icon={Music4}
          title="Δεν υπάρχουν DJ sets"
          action={
            <Button
              onClick={() => setCreating(true)}
              variant="outline"
              size="sm"
              className="gap-1.5 border-cm-violet/25 bg-cm-violet/12 font-medium text-cm-violet hover:bg-cm-violet/20 hover:text-cm-violet"
            >
              <Plus className="h-3.5 w-3.5" />
              Δημιούργησε το πρώτο set
            </Button>
          }
        >
          Τα DJ sets εμφανίζονται εδώ. Άνοιξε ένα για να το επεξεργαστείς στο
          SetBuilder.
        </EmptyState>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" ref={gridRef}>
          {sets.map((s) => (
            <SetCard
              key={s.id}
              s={s}
              exporting={exporting === s.id}
              onOpen={() => navigate(`/sets?id=${s.id}`)}
              onExport={(fmt) => handleExport(s, fmt)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── SetCard ──────────────────────────────────────────────────────────────────

interface SetCardProps {
  s: DJSet;
  exporting: boolean;
  onOpen: () => void;
  onExport: (fmt: "m3u" | "csv" | "markdown") => void;
}

const EXPORT_FMTS = [
  { fmt: "m3u" as const, label: "M3U" },
  { fmt: "csv" as const, label: "CSV" },
  { fmt: "markdown" as const, label: "MD" },
];

function SetCard({ s, exporting, onOpen, onExport }: SetCardProps) {
  const date = fmtDate(s.date);

  return (
    <GlassCard
      interactive
      className="flex flex-col gap-3 p-4"
      onClick={onOpen}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      aria-label={`DJ Set ${s.title}${date ? `, ${date}` : ""}`}
    >
      {/* Title + meta */}
      <div className="flex items-start gap-2.5">
        <Music4 className="mt-0.5 h-4 w-4 shrink-0 text-cm-violet" />
        <div className="min-w-0 flex-1">
          <p className="font-medium leading-snug text-cm-text">{s.title}</p>
          {date && (
            <div className="mt-1 flex items-center gap-1.5">
              <Calendar className="h-3 w-3 text-cm-faint" />
              <span className="text-xs text-cm-muted">{date}</span>
            </div>
          )}
          {s.notes && (
            <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-cm-faint">
              {s.notes}
            </p>
          )}
        </div>
      </div>

      {/* Export strip — stopPropagation so clicks don't open SetBuilder */}
      <div
        className="mt-auto flex items-center gap-1.5 border-t border-white/8 pt-3"
        onClick={(e) => e.stopPropagation()}
      >
        <Download className="h-3.5 w-3.5 shrink-0 text-cm-faint" />
        <span className="mr-1 text-[10px] uppercase tracking-wider text-cm-faint">
          Export
        </span>
        {EXPORT_FMTS.map(({ fmt, label }) => (
          <button
            key={fmt}
            type="button"
            disabled={exporting}
            onClick={() => onExport(fmt)}
            title={`Export ως ${label}`}
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border border-white/10 bg-white/5 font-mono text-[11px] text-cm-muted transition hover:border-cm-violet/25 hover:bg-cm-violet/10 hover:text-cm-violet focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cm-violet/60 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {exporting ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              label
            )}
          </button>
        ))}
      </div>
    </GlassCard>
  );
}
