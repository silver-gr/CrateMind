import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import type { DJSet } from "../../lib/types";
import { GlassCard } from "../ui/GlassCard";
import { EmptyState } from "../ui/EmptyState";
import { Button } from "@/components/ui/button";
import { cn } from "../../lib/cn";
import { Calendar, CheckCircle2, Download, ListMusic, Loader2, Music4, Plus } from "../../lib/icons";

/** Hidden system set used by the Flow Finder — never shown to the user. */
export const SYSTEM_SET_TITLE = "Flow scratch";

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
 * The Library «Sets/Playlist» tab: the DJ sets (Flow scratch filtered out by the Library), each with the
 * «Ενεργό» toggle (the same active set the Library tools use), export and «Άνοιγμα στο Set Builder».
 */
export default function LibrarySets({
  sets,
  activeSetId,
  onActiveSetChange,
  onCreateSet,
}: {
  sets: DJSet[];
  activeSetId: number | null;
  onActiveSetChange: (id: number | null) => void;
  onCreateSet: () => void;
}) {
  const navigate = useNavigate();
  // Which set is currently exporting (by id)
  const [exporting, setExporting] = useState<number | null>(null);
  const [listRef] = useAutoAnimate<HTMLDivElement>();

  async function handleExport(s: DJSet, fmt: "m3u" | "csv" | "markdown") {
    setExporting(s.id);
    try {
      const res = await api.exportArtifact(fmt, { set_id: s.id });
      toast.success(`Έγινε export → ${res.path}`);
    } catch {
      toast.error(`Αποτυχία export (${fmt.toUpperCase()})`);
    } finally {
      setExporting(null);
    }
  }

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
        <div className="space-y-2" ref={listRef}>
          {sets.map((s) => {
            const date = fmtDate(s.date);
            const active = activeSetId === s.id;
            return (
              <GlassCard key={s.id} className={cn("flex flex-col gap-2.5 p-3", active && "border-cm-violet/40")}>
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
      )}
    </div>
  );
}
