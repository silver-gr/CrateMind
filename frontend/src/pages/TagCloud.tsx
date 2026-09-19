import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../lib/api";
import type { Tag } from "../lib/types";
import type { ChipTone } from "../lib/queryChips";
import { TEXT } from "../lib/tones";
import { GlassPanel } from "../components/ui/GlassPanel";
import { SectionHeader } from "../components/ui/SectionHeader";
import { EmptyState } from "../components/ui/EmptyState";
import { SmartChip } from "../components/ui/SmartChip";
import { Loader2, Hash, Tags } from "../lib/icons";

/**
 * Tone palette used for category colour assignment — cosmetic only.
 * All chips are UNIFORM SIZE; colour communicates category, never frequency.
 */
const PALETTE: ChipTone[] = [
  "cyan",
  "violet",
  "chartreuse",
  "amber",
  "magenta",
  "blue",
  "muted",
];

function categoryTone(index: number): ChipTone {
  return PALETTE[index % PALETTE.length];
}

export default function TagCloud() {
  const navigate = useNavigate();
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setTags(await api.listTags());
    } catch {
      toast.error("Αποτυχία φόρτωσης tags");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Group by category; tags without a category go under key ""
  const groups = tags.reduce<Map<string, Tag[]>>((acc, t) => {
    const key = t.category ?? "";
    if (!acc.has(key)) acc.set(key, []);
    acc.get(key)!.push(t);
    return acc;
  }, new Map());

  // Named categories first (sorted), then uncategorised last
  const sortedEntries = [...groups.entries()].sort(([a], [b]) => {
    if (a === "" && b !== "") return 1;
    if (a !== "" && b === "") return -1;
    return a.localeCompare(b, "el");
  });

  const allUncategorised =
    sortedEntries.length === 1 && sortedEntries[0][0] === "";

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-cm-faint" />
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-5">
      {/* Page header */}
      <div className="mb-4 flex items-center gap-3">
        <Hash className="h-5 w-5 text-cm-chartreuse" />
        <h1 className="text-lg font-semibold text-cm-text">Tag Cloud</h1>
        <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-xs tabular-nums text-cm-muted">
          {tags.length}
        </span>
      </div>

      <p className="mb-5 max-w-xl text-xs leading-relaxed text-cm-faint">
        Κάνε κλικ σε ένα tag για να δεις τα tracks του στη βιβλιοθήκη. Τα chips
        έχουν ομοιόμορφο μέγεθος — το χρώμα δείχνει κατηγορία (αισθητική
        μόνο).
      </p>

      {tags.length === 0 ? (
        <EmptyState icon={Tags} title="Δεν υπάρχουν tags">
          Πρόσθεσε tags στα tracks σου μέσα από τη βιβλιοθήκη ή την ουρά
          ετικετοποίησης.
        </EmptyState>
      ) : allUncategorised ? (
        // Flat display when nothing has a category
        <GlassPanel className="p-4">
          <div className="flex flex-wrap gap-2">
            {tags.map((t) => (
              <SmartChip
                key={t.id}
                tone="muted"
                onClick={() =>
                  navigate(`/library?q=${encodeURIComponent(t.name)}`)
                }
              >
                {t.name}
              </SmartChip>
            ))}
          </div>
        </GlassPanel>
      ) : (
        // Grouped display
        <div className="space-y-4">
          {sortedEntries.map(([cat, catTags], idx) => {
            const tone = cat ? categoryTone(idx) : "muted";
            const label = cat || "Χωρίς κατηγορία";
            return (
              <GlassPanel key={cat || "__none__"} className="p-4">
                <SectionHeader
                  right={
                    <span className="rounded-full border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-cm-faint">
                      {catTags.length}
                    </span>
                  }
                >
                  <span className={TEXT[tone]}>{label}</span>
                </SectionHeader>
                <div className="flex flex-wrap gap-2">
                  {catTags.map((t) => (
                    <SmartChip
                      key={t.id}
                      tone={tone}
                      onClick={() =>
                        navigate(`/library?q=${encodeURIComponent(t.name)}`)
                      }
                    >
                      {t.name}
                    </SmartChip>
                  ))}
                </div>
              </GlassPanel>
            );
          })}
        </div>
      )}
    </div>
  );
}
