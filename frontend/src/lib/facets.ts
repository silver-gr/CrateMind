import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { serializeTokens } from "./queryGrammar";
import type { Facet, Tag } from "./types";

/** Dispatched on `window` after every vocabulary write, so each `useFacets()` refetches. */
export const FACETS_CHANGED = "cratemind:facets-changed";

/** The value part of a facet tag (`purpose:χαλάρωση` -> `χαλάρωση`); other tags keep their name. */
export function tagDisplayName(tag: Pick<Tag, "name" | "category">): string {
  const prefix = tag.category ? `${tag.category}:` : null;
  return prefix && tag.name.startsWith(prefix) ? tag.name.slice(prefix.length) : tag.name;
}

/** A search token for one tag: `key:"value"` for a facet tag, else free text (quoted when needed). */
export function tagQuery(tag: Pick<Tag, "name" | "category">): string {
  const value = tagDisplayName(tag);
  if (value !== tag.name) return serializeTokens([{ neg: false, field: tag.category!, value, quoted: true }]);
  const quoted = tag.name.includes(":") || tag.name.startsWith("-");
  return serializeTokens([{ neg: false, field: null, value: tag.name, quoted }]);
}

export interface TagGroup {
  key: string;
  label: string;
  facet: boolean;
  tags: Tag[];
}

/** Facets first (in the given order) under their Greek label, then other categories, then uncategorised. */
export function groupTags(tags: readonly Tag[], facets: readonly Facet[]): TagGroup[] {
  const byKey = new Map<string, Tag[]>();
  for (const tag of tags) {
    const key = tag.category ?? "";
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(tag);
  }
  const groups: TagGroup[] = [];
  for (const facet of facets) {
    const list = byKey.get(facet.key);
    if (!list) continue;
    groups.push({ key: facet.key, label: facet.label, facet: true, tags: list });
    byKey.delete(facet.key);
  }
  const rest = [...byKey.keys()].filter(key => key !== "").sort((a, b) => a.localeCompare(b, "el"));
  for (const key of rest) groups.push({ key, label: key, facet: false, tags: byKey.get(key)! });
  const loose = byKey.get("");
  if (loose) groups.push({ key: "", label: "Χωρίς κατηγορία", facet: false, tags: loose });
  return groups;
}

/** The server's Greek message without the `409: ` status prefix that `req` adds. */
export function apiMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^\d{3}: /, "");
}

export function notifyFacetsChanged(): void {
  cache = null;
  window.dispatchEvent(new Event(FACETS_CHANGED));
}

let cache: Facet[] | null = null;
let inflight: Promise<Facet[]> | null = null;

function fetchFacets(force: boolean): Promise<Facet[]> {
  if (cache && !force) return Promise.resolve(cache);
  inflight ??= api.listFacets()
    .then(facets => (cache = facets))
    .finally(() => { inflight = null; });
  return inflight;
}

/** The vocabularies, cached across components and refetched after each vocabulary write. */
export function useFacets(): { facets: Facet[]; loaded: boolean; reload: () => void } {
  const [facets, setFacets] = useState<Facet[]>(cache ?? []);
  const [loaded, setLoaded] = useState(cache !== null);

  const load = useCallback((force: boolean) => {
    fetchFacets(force)
      .then(next => { setFacets(next); setLoaded(true); })
      .catch(() => { /* keep the last list; `loaded` stays false until a fetch succeeds */ });
  }, []);

  useEffect(() => {
    load(false);
    const onChange = () => load(true);
    window.addEventListener(FACETS_CHANGED, onChange);
    return () => window.removeEventListener(FACETS_CHANGED, onChange);
  }, [load]);

  return { facets, loaded, reload: useCallback(() => load(true), [load]) };
}
