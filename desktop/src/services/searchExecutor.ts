// Track search executor — runs a CompiledQuery (see searchParser.ts) against
// the DB: resolves free/exclude FTS terms to rowid lists, assembles the final
// WHERE clause, and runs the list/count queries. Exact port of search.py's
// `search()` / `count()` (the ORDER BY, offset-always/limit-if-positive, and
// "free terms given but zero FTS hits -> empty result" semantics).

import type { DatabaseSync } from "node:sqlite";
import { compileQuery } from "./searchParser.ts";
import type { CompiledQuery } from "./searchParser.ts";
import type { Track } from "../types/models.ts";

export { compileQuery };
export type { CompiledQuery };

const BASE_FROM = `FROM tracks t
  LEFT JOIN track_dj_profile p ON p.track_id = t.id
  LEFT JOIN artist_profiles ap ON ap.normalized_name = t.artist_normalized`;

/** Runs a quoted-phrase MATCH query against track_search and returns the
 * matching rowids. `sep` is " " for AND (free terms) or " OR " (exclude
 * terms), mirroring search.py's `" ".join`/`" OR ".join`. */
function ftsIds(db: DatabaseSync, terms: string[], sep: string): number[] {
  if (terms.length === 0) return [];
  const matchExpr = terms.map((t) => `"${t}"`).join(sep);
  const rows = db
    .prepare(`SELECT rowid FROM track_search WHERE track_search MATCH ?`)
    .all(matchExpr) as { rowid: number }[];
  return rows.map((r) => r.rowid);
}

/** Resolves a CompiledQuery's free/exclude FTS terms into extra WHERE
 * conditions. Returns `null` when free terms were given but matched zero
 * rows — mirrors `_build_query` returning `None`, which short-circuits both
 * `search()` (-> []) and `count()` (-> 0) without running the main query. */
function resolve(
  db: DatabaseSync,
  compiled: CompiledQuery,
): { whereSql: string; params: (string | number)[] } | null {
  const conditions = [...compiled.conditions];
  const params = [...compiled.params];

  if (compiled.freeTerms.length > 0) {
    const ids = ftsIds(db, compiled.freeTerms, " ");
    if (ids.length === 0) return null;
    conditions.push(`t.id IN (${ids.map(() => "?").join(",")})`);
    params.push(...ids);
  }

  if (compiled.excludeTerms.length > 0) {
    const bad = ftsIds(db, compiled.excludeTerms, " OR ");
    if (bad.length > 0) {
      conditions.push(`t.id NOT IN (${bad.map(() => "?").join(",")})`);
      params.push(...bad);
    }
  }

  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return { whereSql, params };
}

/** Runs the search query, returning matching Track rows ordered by
 * (artist, title). `limit <= 0` means unbounded (mirrors search.py's
 * `if limit and limit > 0`); `offset` is always applied. */
export function searchTracks(
  db: DatabaseSync,
  query: string,
  limit = 500,
  offset = 0,
): Track[] {
  const resolved = resolve(db, compileQuery(query));
  if (resolved === null) return [];

  const { whereSql, params } = resolved;
  const limitSql = limit > 0 ? "LIMIT ? OFFSET ?" : "LIMIT -1 OFFSET ?";
  const limitParams = limit > 0 ? [limit, offset] : [offset];

  const sql = `SELECT t.* ${BASE_FROM} ${whereSql} ORDER BY t.artist, t.title ${limitSql}`;
  return db.prepare(sql).all(...params, ...limitParams) as unknown as Track[];
}

/** Counts matches without materializing rows (dashboard/Memory Crate badges). */
export function countTracks(db: DatabaseSync, query: string): number {
  const resolved = resolve(db, compileQuery(query));
  if (resolved === null) return 0;

  const { whereSql, params } = resolved;
  const sql = `SELECT COUNT(*) as cnt FROM (SELECT t.id ${BASE_FROM} ${whereSql}) sub`;
  const row = db.prepare(sql).get(...params) as { cnt: number };
  return row.cnt;
}
