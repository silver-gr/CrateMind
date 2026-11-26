import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { apiMessage } from "../../lib/facets";
import type { DJSet } from "../../lib/types";
import { deleteSetAndCleanUp, duplicateSetById } from "../../lib/setActions";
import { SET_EXPORTS, setMenuEntries, type SetExportFormat } from "../../lib/menus/setMenu";
import DeleteSetDialog from "../DeleteSetDialog";
import { ActionContextMenu } from "../ui/context-menu";
import { GlassCard } from "../ui/GlassCard";
import { EmptyState } from "../ui/EmptyState";
import { Button } from "@/components/ui/button";
import { cn } from "../../lib/cn";
import { Calendar, CheckCircle2, Download, ListMusic, Loader2, Music4, Plus } from "../../lib/icons";

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

const EXPORT_FMTS = [
  { fmt: "m3u" as const, label: "M3U" },
  { fmt: "csv" as const, label: "CSV" },
  { fmt: "markdown" as const, label: "MD" },
];

/**
 * The Library «Sets/Playlist» tab: the DJ sets, each with the
 * «Ενεργό» toggle (the same active set the Library tools use), export and «Άνοιγμα στο Set Builder».
 * A right-click on a set adds its copy and delete (with the Set Builder's confirmation); `onSetsChanged` refreshes the list.
 */
export default function LibrarySets({
  sets,
  activeSetId,
  onActiveSetChange,
  onCreateSet,
  onSetsChanged,
}: {
  sets: DJSet[];
  activeSetId: number | null;
  onActiveSetChange: (id: number | null) => void;
  onCreateSet: () => void;
  onSetsChanged: () => void;
}) {
  const navigate = useNavigate();
  // Which set is currently exporting (by id)
  const [exporting, setExporting] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<{ id: number; title: string; trackCount: number } | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [listRef] = useAutoAnimate<HTMLDivElement>();

  async function handleExport(s: DJSet, fmt: SetExportFormat) {
    setExporting(s.id);
    try {
      // A set has its own export file; exporting it again replaces that file.
      const res = await api.exportArtifact(fmt, { set_id: s.id, overwrite: true });
      toast.success(`Εξαγωγή ολοκληρώθηκε → ${res.path}`);
    } catch (e) {
      toast.error(`Αποτυχία εξαγωγής ${SET_EXPORTS.find(x => x.fmt === fmt)?.label ?? fmt}`, { description: apiMessage(e) });
    } finally {
      setExporting(null);
    }
  }

  async function duplicate(s: DJSet) {
    try {
      const copy = await duplicateSetById(s.id, s.title);
      onSetsChanged();
      toast.success(`Δημιουργήθηκε αντίγραφο: ${copy.title}`);
    } catch (e) {
      toast.error("Δεν ήταν δυνατή η δημιουργία αντιγράφου", { description: apiMessage(e) });
    }
  }

  // The confirmation names the track count, so the set is read first.
  async function requestDelete(s: DJSet) {
    try {
      const { tracks } = await api.getSet(s.id);
      setDeleting({ id: s.id, title: s.title, trackCount: tracks.length });
    } catch (e) {
      toast.error("Δεν ήταν δυνατή η φόρτωση του set", { description: apiMessage(e) });
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    const { id, title } = deleting;
    setDeleteBusy(true);
    try {
      await deleteSetAndCleanUp(id);
      setDeleting(null);
      if (activeSetId === id) onActiveSetChange(null);
      onSetsChanged();
      toast.success(`Διαγράφηκε το set «${title}»`);
    } catch (e) {
      toast.error("Δεν ήταν δυνατή η διαγραφή του set", { description: apiMessage(e) });
    } finally {
      setDeleteBusy(false);
    }
  }

  const setMenu = {
    entries: (s: DJSet) => setMenuEntries({
      busy: exporting === s.id,
      open: () => navigate(`/sets?id=${s.id}`),
      active: { checked: activeSetId === s.id, toggle: () => onActiveSetChange(activeSetId === s.id ? null : s.id) },
      exportAs: fmt => void handleExport(s, fmt),
      duplicate: () => void duplicate(s),
      remove: () => void requestDelete(s),
    }),
  };

  return (
    <div className="space-y-3">
      <Button type="button" variant="soft" size="sm" className="w-full" onClick={onCreateSet}>
        <Plus />
        Νέο set
      </Button>
      {sets.length === 0 ? (
        <EmptyState icon={Music4} title="Δεν υπάρχουν DJ sets" className="mt-4">
          Τα DJ sets εμφανίζονται εδώ. Άνοιξε ένα για να το επεξεργαστείς στο
          SetBuilder.
        </EmptyState>
      ) : (
        <ActionContextMenu menu={setMenu} rowSelector="[data-set-id]" pick={row => sets.find(s => s.id === Number(row.dataset.setId))}>
        <div className="space-y-2" ref={listRef}>
          {sets.map((s) => {
            const date = fmtDate(s.date);
            const active = activeSetId === s.id;
            return (
              <GlassCard key={s.id} data-set-id={s.id} className={cn("flex flex-col gap-2.5 p-3", active && "border-cm-violet/40")}>
                <div className="flex items-start gap-2.5">
                  <Music4 className="mt-0.5 h-4 w-4 shrink-0 text-cm-violet" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium leading-snug text-cm-text">{s.title}</p>
                    {date && (
                      <div className="mt-1 flex items-center gap-1.5">
                        <Calendar className="h-3 w-3 text-cm-faint" aria-hidden="true" />
                        <span className="text-xs text-cm-muted">{date}</span>
                      </div>
                    )}
                    {s.notes && (
                      <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-cm-faint">{s.notes}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() => onActiveSetChange(active ? null : s.id)}
                    title={active ? "Ενεργό set — πάτα για αφαίρεση" : "Ορισμός ως ενεργό set"}
                    aria-label={`Ενεργό set: ${s.title}`}
                    className={cn(
                      "relative inline-flex h-7 shrink-0 items-center gap-1 rounded-lg border px-2 text-[11px] font-medium transition-[background-color,border-color,color,scale] duration-150 motion-safe:active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-violet/60 after:absolute after:-inset-1",
                      active
                        ? "border-cm-violet/40 bg-cm-violet/15 text-cm-violet"
                        : "border-cm-contrast/10 bg-cm-contrast/5 text-cm-muted hover:bg-cm-contrast/10 hover:text-cm-text",
                    )}
                  >
                    {active && <CheckCircle2 className="h-3 w-3" aria-hidden="true" />}
                    Ενεργό
                  </button>
                </div>

                <div className="flex items-center gap-1.5 border-t border-cm-contrast/8 pt-2.5">
                  <Download className="mr-0.5 h-3.5 w-3.5 shrink-0 text-cm-faint" aria-label="Export" />
                  {EXPORT_FMTS.map(({ fmt, label }) => (
                    <button
                      key={fmt}
                      type="button"
                      disabled={exporting === s.id}
                      onClick={() => handleExport(s, fmt)}
                      title={`Export ως ${label}`}
                      className="relative flex h-7 min-w-10 items-center justify-center rounded-lg border border-cm-contrast/10 bg-cm-contrast/5 px-1.5 font-mono text-[11px] text-cm-muted transition-[background-color,border-color,color,scale] duration-150 hover:border-cm-violet/30 hover:bg-cm-violet/12 hover:text-cm-violet motion-safe:active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-violet/60 disabled:cursor-not-allowed disabled:opacity-40 after:absolute after:inset-x-0 after:-inset-y-1.5"
                    >
                      {exporting === s.id ? <Loader2 className="h-3 w-3 animate-spin" /> : label}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => navigate(`/sets?id=${s.id}`)}
                    title="Άνοιγμα στο Set Builder"
                    aria-label={`Άνοιγμα στο Set Builder: ${s.title}`}
                    className="relative ml-auto flex size-7 items-center justify-center rounded-lg text-cm-faint transition-[background-color,color,scale] duration-150 hover:bg-cm-contrast/8 hover:text-cm-text motion-safe:active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cm-violet/60 after:absolute after:-inset-1.5"
                  >
                    <ListMusic className="size-4" />
                  </button>
                </div>
              </GlassCard>
            );
          })}
        </div>
        </ActionContextMenu>
      )}
      <DeleteSetDialog target={deleting} busy={deleteBusy} onCancel={() => setDeleting(null)} onConfirm={() => { void confirmDelete(); }} />
    </div>
  );
}
