import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { toast } from "sonner";
import { api } from "../lib/api";
import type { SavedSearch } from "../lib/types";
import { parseQueryChips } from "../lib/queryChips";
import { useFacets } from "../lib/facets";
import { useCapabilities } from "../lib/capabilities";
import { AnalyzeBpmDialog } from "../components/AnalyzeBpmDialog";
import { GlassCard } from "../components/ui/GlassCard";
import { SectionHeader } from "../components/ui/SectionHeader";
import { EmptyState } from "../components/ui/EmptyState";
import { SmartChip } from "../components/ui/SmartChip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Archive, AudioWaveform, Pin, Trash2, Plus, Loader2, Wrench } from "../lib/icons";

function sortSearches(list: SavedSearch[]): SavedSearch[] {
  return [...list].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return a.sort_order - b.sort_order;
  });
}

export default function Crates() {
  const navigate = useNavigate();
  const canAnalyze = useCapabilities().analysis;
  const [searches, setSearches] = useState<SavedSearch[]>([]);
  const { facets } = useFacets();
  const [loading, setLoading] = useState(true);

  // Inline create form
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newQuery, setNewQuery] = useState("");
  const [saving, setSaving] = useState(false);

  // Edit dialog
  const [editTarget, setEditTarget] = useState<SavedSearch | null>(null);
  const [editName, setEditName] = useState("");
  const [editQuery, setEditQuery] = useState("");

  // «Ανάλυση BPM» on one crate
  const [analyzeTarget, setAnalyzeTarget] = useState<SavedSearch | null>(null);

  // Separate refs so each section animates its own items
  const [pinnedRef] = useAutoAnimate<HTMLDivElement>();
  const [unpinnedRef] = useAutoAnimate<HTMLDivElement>();

  const load = useCallback(async () => {
    try {
      const data = await api.listSearches();
      setSearches(sortSearches(data));
    } catch {
      toast.error("Αποτυχία φόρτωσης crates");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCreate() {
    if (!newName.trim() || !newQuery.trim()) return;
    setSaving(true);
    try {
      const s = await api.createSearch(newName.trim(), newQuery.trim());
      setSearches((prev) => sortSearches([...prev, s]));
      setNewName("");
      setNewQuery("");
      setCreating(false);
      toast.success(`Crate "${s.name}" δημιουργήθηκε`);
    } catch {
      toast.error("Αποτυχία δημιουργίας crate");
    } finally {
      setSaving(false);
    }
  }

  async function handlePin(s: SavedSearch) {
    try {
      const updated = await api.updateSearch(s.id, { pinned: !s.pinned });
      setSearches((prev) => sortSearches(prev.map((x) => (x.id === s.id ? updated : x))));
    } catch {
      toast.error("Αποτυχία αλλαγής pin");
    }
  }

  async function handleDelete(s: SavedSearch) {
    try {
      await api.deleteSearch(s.id);
      setSearches((prev) => prev.filter((x) => x.id !== s.id));
      toast.success(`Crate "${s.name}" διαγράφηκε`);
    } catch {
      toast.error("Αποτυχία διαγραφής");
    }
  }

  function openEdit(s: SavedSearch) {
    setEditTarget(s);
    setEditName(s.name);
    setEditQuery(s.query);
  }

  async function handleSaveEdit() {
    if (!editTarget) return;
    try {
      const updated = await api.updateSearch(editTarget.id, {
        name: editName,
        query: editQuery,
      });
      setSearches((prev) => sortSearches(prev.map((x) => (x.id === editTarget.id ? updated : x))));
      setEditTarget(null);
      toast.success("Crate αποθηκεύτηκε");
    } catch {
      toast.error("Αποτυχία αποθήκευσης");
    }
  }

  const pinned = searches.filter((s) => s.pinned);
  const unpinned = searches.filter((s) => !s.pinned);

  return (
    <div className="h-full overflow-auto p-5 scroll-fade-y">
      {/* Page header */}
      <div className="mb-5 flex items-center gap-3">
        <Archive className="h-5 w-5 text-cm-cyan" />
        <h1 className="text-lg font-semibold text-cm-text">Crates</h1>
        <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-xs tabular-nums text-cm-muted">
          {searches.length}
        </span>
        <Button
          onClick={() => setCreating((v) => !v)}
          variant="outline"
          size="sm"
          className="ml-auto gap-1.5 border-cm-cyan/25 bg-cm-cyan/12 font-medium text-cm-cyan hover:bg-cm-cyan/20 hover:text-cm-cyan"
        >
          <Plus className="h-3.5 w-3.5" />
          Νέο Crate
        </Button>
      </div>

      {/* Inline create form */}
      {creating && (
        <div className="mb-5 rounded-2xl border border-cm-cyan/20 bg-cm-cyan/5 p-4">
          <SectionHeader>Νέο crate</SectionHeader>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              autoFocus
              placeholder="Όνομα crate…"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
                if (e.key === "Escape") setCreating(false);
              }}
              wrapperClassName="flex-1"
              className="text-cm-text placeholder:text-cm-faint"
            />
            <Input
              placeholder="Query (π.χ. energy:7-9 status:approved)…"
              value={newQuery}
              onChange={(e) => setNewQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
                if (e.key === "Escape") setCreating(false);
              }}
              wrapperClassName="flex-[2]"
              className="text-cm-text placeholder:text-cm-faint"
            />
            <Button
              onClick={handleCreate}
              disabled={saving || !newName.trim() || !newQuery.trim()}
              variant="outline"
              size="sm"
              className="gap-1.5 border-cm-cyan/25 bg-cm-cyan/12 font-medium text-cm-cyan hover:bg-cm-cyan/20 hover:text-cm-cyan disabled:opacity-40"
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              Αποθήκευση
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
          {newQuery.trim() && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {parseQueryChips(newQuery, facets).map((c, i) => (
                <SmartChip key={i} tone={c.tone} className="text-[11px]">
                  {c.label}
                </SmartChip>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-cm-faint" />
        </div>
      ) : searches.length === 0 ? (
        <EmptyState
          icon={Archive}
          title="Δεν υπάρχουν crates"
          action={
            <Button
              onClick={() => setCreating(true)}
              variant="outline"
              size="sm"
              className="gap-1.5 border-cm-cyan/25 bg-cm-cyan/12 font-medium text-cm-cyan hover:bg-cm-cyan/20 hover:text-cm-cyan"
            >
              <Plus className="h-3.5 w-3.5" />
              Δημιούργησε το πρώτο crate
            </Button>
          }
        >
          Αποθήκευσε αναζητήσεις ως ζωντανά crates που ενημερώνονται αυτόματα.
        </EmptyState>
      ) : (
        <div className="space-y-6">
          {pinned.length > 0 && (
            <section>
              <SectionHeader
                right={
                  <span className="font-mono text-[10px] tabular-nums text-cm-faint">
                    {pinned.length}
                  </span>
                }
              >
                Καρφιτσωμένα
              </SectionHeader>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" ref={pinnedRef}>
                {pinned.map((s) => (
                  <CrateCard
                    key={s.id}
                    s={s}
                    onOpen={() => navigate(`/library?q=${encodeURIComponent(s.query)}`)}
                    onPin={() => handlePin(s)}
                    onEdit={() => openEdit(s)}
                    onAnalyze={canAnalyze ? () => setAnalyzeTarget(s) : undefined}
                    onDelete={() => handleDelete(s)}
                  />
                ))}
              </div>
            </section>
          )}
          {unpinned.length > 0 && (
            <section>
              {pinned.length > 0 && (
                <SectionHeader
                  right={
                    <span className="font-mono text-[10px] tabular-nums text-cm-faint">
                      {unpinned.length}
                    </span>
                  }
                >
                  Υπόλοιπα
                </SectionHeader>
              )}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" ref={unpinnedRef}>
                {unpinned.map((s) => (
                  <CrateCard
                    key={s.id}
                    s={s}
                    onOpen={() => navigate(`/library?q=${encodeURIComponent(s.query)}`)}
                    onPin={() => handlePin(s)}
                    onEdit={() => openEdit(s)}
                    onAnalyze={canAnalyze ? () => setAnalyzeTarget(s) : undefined}
                    onDelete={() => handleDelete(s)}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {analyzeTarget && (
        <AnalyzeBpmDialog
          scope={{ query: analyzeTarget.query }}
          open
          onOpenChange={(open) => {
            if (!open) setAnalyzeTarget(null);
          }}
          onDone={load}
        />
      )}

      {/* Edit dialog */}
      <Dialog
        open={!!editTarget}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null);
        }}
      >
        <DialogContent className="glass border-white/10">
          <DialogHeader>
            <DialogTitle className="text-cm-text">Επεξεργασία crate</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Input
              placeholder="Όνομα…"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              className="text-cm-text placeholder:text-cm-faint"
            />
            <Input
              placeholder="Query…"
              value={editQuery}
              onChange={(e) => setEditQuery(e.target.value)}
              className="text-cm-text placeholder:text-cm-faint"
            />
            {editQuery.trim() && (
              <div className="flex flex-wrap gap-1.5">
                {parseQueryChips(editQuery, facets).map((c, i) => (
                  <SmartChip key={i} tone={c.tone} className="text-[11px]">
                    {c.label}
                  </SmartChip>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditTarget(null)}
              className="border-white/10 bg-white/5 text-cm-muted hover:bg-white/10"
            >
              Ακύρωση
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleSaveEdit}
              disabled={!editName.trim() || !editQuery.trim()}
              className="gap-1.5 border-cm-cyan/25 bg-cm-cyan/12 font-medium text-cm-cyan hover:bg-cm-cyan/20 hover:text-cm-cyan disabled:opacity-40"
            >
              Αποθήκευση
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── CrateCard ────────────────────────────────────────────────────────────────

interface CrateCardProps {
  s: SavedSearch;
  onOpen: () => void;
  onPin: () => void;
  onEdit: () => void;
  /** Present only when the runtime can analyse audio. */
  onAnalyze?: () => void;
  onDelete: () => void;
}

function CrateCard({ s, onOpen, onPin, onEdit, onAnalyze, onDelete }: CrateCardProps) {
  const { facets } = useFacets();
  const chips = parseQueryChips(s.query, facets);

  return (
    <GlassCard
      interactive
      spotlight
      className="flex flex-col gap-3 p-4"
      onClick={onOpen}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      aria-label={`Crate ${s.name} — ${s.count} tracks`}
    >
      {/* Title row */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {s.pinned && (
            <Pin
              className="h-3.5 w-3.5 shrink-0 text-cm-amber"
              aria-label="Καρφιτσωμένο"
            />
          )}
          <span className="truncate font-medium text-cm-text">{s.name}</span>
        </div>
        <span className="shrink-0 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-xs tabular-nums text-cm-muted">
          {s.count}
        </span>
      </div>

      {/* Query chips — click won't bubble to card */}
      {chips.length > 0 && (
        <div
          className="flex flex-wrap gap-1"
          onClick={(e) => e.stopPropagation()}
        >
          {chips.slice(0, 5).map((c, i) => (
            <SmartChip key={i} tone={c.tone} className="text-[11px]">
              {c.label}
            </SmartChip>
          ))}
          {chips.length > 5 && (
            <SmartChip tone="muted" className="text-[11px]">
              +{chips.length - 5}
            </SmartChip>
          )}
        </div>
      )}

      {/* Action strip */}
      <div
        className="mt-auto flex items-center gap-1.5 border-t border-white/8 pt-3"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onPin}
          title={s.pinned ? "Αφαίρεση pin" : "Καρφίτσωμα"}
          aria-pressed={s.pinned}
          className={`flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cm-cyan/60 ${
            s.pinned
              ? "border-cm-amber/25 bg-cm-amber/10 text-cm-amber hover:bg-cm-amber/20"
              : "border-white/10 bg-white/5 text-cm-faint hover:bg-white/10 hover:text-cm-text"
          }`}
        >
          <Pin className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onEdit}
          title="Επεξεργασία"
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border border-white/10 bg-white/5 text-cm-faint transition hover:bg-white/10 hover:text-cm-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cm-cyan/60"
        >
          <Wrench className="h-3.5 w-3.5" />
        </button>
        {onAnalyze && (
          <button
            type="button"
            onClick={onAnalyze}
            title="Ανάλυση BPM"
            aria-label={`Ανάλυση BPM για ${s.name}`}
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border border-white/10 bg-white/5 text-cm-faint transition hover:bg-white/10 hover:text-cm-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cm-cyan/60"
          >
            <AudioWaveform className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={onDelete}
          title="Διαγραφή"
          className="ml-auto flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border border-white/10 bg-white/5 text-cm-faint transition hover:border-cm-rose/25 hover:bg-cm-rose/10 hover:text-cm-rose focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cm-rose/60"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </GlassCard>
  );
}
