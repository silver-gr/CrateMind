import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import type { Tag } from "../lib/types";
import { groupTags, tagDisplayName, tagQuery, useFacets } from "../lib/facets";
import type { ChipTone } from "../lib/queryChips";
import { TEXT } from "../lib/tones";
import { GlassPanel } from "./ui/GlassPanel";
import { SectionHeader } from "./ui/SectionHeader";
import { EmptyState } from "./ui/EmptyState";
import { SmartChip } from "./ui/SmartChip";
import { Loader2, Tags } from "../lib/icons";

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

/** The tag list, loaded once per mount (the Tag Cloud page and the Library «Ετικέτες» drawer). */
export function useTagList(): { tags: Tag[]; loading: boolean } {
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    api.listTags()
      .then(next => { if (active) setTags(next); })
      .catch(() => { if (active) toast.error("Αποτυχία φόρτωσης tags"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  return { tags, loading };
}

/**
 * The grouped tag chips. `onPick` gets the tag's Library query; the chip whose query equals
 * `activeQuery` shows as active. `bare` drops the glass panels (inside a glass drawer).
 */
export function TagCloudBody({
  tags,
  loading,
  onPick,
  activeQuery,
  bare = false,
}: {
  tags: Tag[];
  loading: boolean;
  onPick: (query: string) => void;
  activeQuery?: string;
  bare?: boolean;
}) {
  const { facets } = useFacets();

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-cm-faint" />
      </div>
    );
  }

  if (tags.length === 0) {
    return (
      <EmptyState icon={Tags} title="Δεν υπάρχουν tags">
        Πρόσθεσε tags στα tracks σου μέσα από τη βιβλιοθήκη ή την ουρά
        ετικετοποίησης.
      </EmptyState>
    );
  }

  // Vocabularies first under their Greek label, other categories, then uncategorised last
  const groups = groupTags(tags, facets);
  const allUncategorised = groups.length === 1 && groups[0].key === "";
  const Group = bare ? "section" : GlassPanel;
  const groupClass = bare ? "" : "p-4";
  const chip = (t: Tag, tone: ChipTone) => {
    const q = tagQuery(t);
    return (
      <SmartChip key={t.id} tone={tone} active={activeQuery === q} onClick={() => onPick(q)}>
        {tagDisplayName(t)}
      </SmartChip>
    );
  };

  if (allUncategorised) {
    // Flat display when nothing has a category
    return (
      <Group className={groupClass}>
        <div className="flex flex-wrap gap-2">{tags.map(t => chip(t, "muted"))}</div>
      </Group>
    );
  }

  return (
    <div className={bare ? "space-y-5" : "space-y-4"}>
      {groups.map(({ key: cat, label, tags: catTags }, idx) => {
        const tone = cat ? categoryTone(idx) : "muted";
        return (
          <Group key={cat || "__none__"} className={groupClass}>
            <SectionHeader
              right={
                <span className="rounded-full border border-cm-contrast/10 bg-cm-contrast/5 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-cm-faint">
                  {catTags.length}
                </span>
              }
            >
              <span className={TEXT[tone]}>{label}</span>
            </SectionHeader>
            <div className="flex flex-wrap gap-2">{catTags.map(t => chip(t, tone))}</div>
          </Group>
        );
      })}
    </div>
  );
}
