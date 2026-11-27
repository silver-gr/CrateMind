/** The Library's `names:` quick filters («Ονόματα για ματιά», …), beside its other ready filters and drawn the same
 *  way. They show only while «Καθαρά ονόματα» is on; the switch is read once when the Library mounts (pages fetch on
 *  mount, so leaving Settings shows the change). Lists: lib/nameWhy.ts `namesQuickFilters`. */
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { namesQuickFilters, type NamesQuickFilter } from "../lib/nameWhy";
import { SmartChip } from "./ui/SmartChip";

export function NamesQuickFilterChips({ filters, query, onApply }: {
  filters: readonly NamesQuickFilter[];
  query: string;
  onApply: (q: string) => void;
}) {
  return (
    <>
      {filters.map(filter => (
        <SmartChip key={filter.q} tone="muted" active={query.trim() === filter.q} onClick={() => onApply(filter.q)}>
          {filter.label}
        </SmartChip>
      ))}
    </>
  );
}

export function NamesQuickFilters({ query, onApply }: { query: string; onApply: (q: string) => void }) {
  const [filters, setFilters] = useState<NamesQuickFilter[]>([]);
  useEffect(() => {
    let live = true;
    api.namesStatus().then(status => { if (live) setFilters(namesQuickFilters(status)); }, () => {});
    return () => { live = false; };
  }, []);
  return <NamesQuickFilterChips filters={filters} query={query} onApply={onApply} />;
}
