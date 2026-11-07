import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../lib/api";
import type { Facet, Tag } from "../lib/types";
import { groupTags, tagDisplayName, tagQuery } from "../lib/facets";
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
  const [facets, setFacets] = useState<Facet[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [nextTags, nextFacets] = await Promise.all([api.listTags(), api.listFacets()]);
      setTags(nextTags);
      setFacets(nextFacets);
    } catch {
      toast.error("Αποτυχία φόρτωσης tags");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Vocabularies first under their Greek label, other categories, then uncategorised last
  const groups = groupTags(tags, facets);
  const allUncategorised = groups.length === 1 && groups[0].key === "";
  const openTag = (t: Tag) => navigate(`/library?q=${encodeURIComponent(tagQuery(t))}`);

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
        <span className="rounded-full border border-cm-contrast/10 bg-cm-contrast/5 px-2 py-0.5 font-mono text-xs tabular-nums text-cm-muted">
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
                onClick={() => openTag(t)}
              >
                {tagDisplayName(t)}
              </SmartChip>
            ))}
          </div>
        </GlassPanel>
      ) : (
        // Grouped display
        <div className="space-y-4">
          {groups.map(({ key: cat, label, tags: catTags }, idx) => {
            const tone = cat ? categoryTone(idx) : "muted";
            return (
              <GlassPanel key={cat || "__none__"} className="p-4">
                <SectionHeader
                  right={
                    <span className="rounded-full border border-cm-contrast/10 bg-cm-contrast/5 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-cm-faint">
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
                      onClick={() => openTag(t)}
                    >
                      {tagDisplayName(t)}
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
