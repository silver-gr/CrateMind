# CrateMind Therapy Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Phase A of the music-therapy roadmap: accent-insensitive and large-library-safe search, a DJ/«Μουσικοθεραπεία» profile switch, user-defined vocabularies (facets) with a valence axis, bulk tagging and a facet-aware triage queue, all working in the Windows desktop sidecar.

**Architecture:** `Tag.category` becomes a facet key; facet values are ordinary `Tag` rows named `key:value`, written only through `services/facets.py`. Search gets one shared query grammar (Python and TypeScript, one JSON fixture), a `fold_text` helper used at index and query time, and `json_each(:ids)` instead of per-track bound variables. The profile is a persisted pref; the app remounts on switch so label helpers can read `getPref`.

**Tech Stack:** FastAPI, SQLModel, SQLite FTS5, pytest (uv) / React 19, TypeScript, Vite, bun test, Tauri sidecar (PyInstaller).

**Spec:** `docs/superpowers/specs/2026-11-02-music-therapy-design.md` (Phase A = A0–A6 plus the Phase-A items of Verification, Global constraints, Risks). Read it with this plan.

## Global Constraints

- Windows desktop sidecar: no SciPy/librosa/network in Phase A; `json_each` and `unicodedata` only (stdlib/SQLite).
- Data safety: nothing is ever written to audio files; facets live only in CrateMind's DB; bulk writes are confirmed with the server's count, run in one transaction and are audited per track as diffs. Tests never touch the live dataset or djay files (hermetic `conftest.py`).
- Large libraries: no query binds one variable per track (`ids_in` / subqueries).
- All user-facing copy is Greek; never show internal keys (facet `key`, `non_straight`-style codes). English only for `beatgrid`, `BPM`, `M3U8`, `tag`, `export`-type words.
- Schema change => regenerate `backend/app/schema_contract.json`; new follow-up routes are GET/POST/DELETE only and each is classified in `scripts/desktop/check_parity_inventory.py` (`FOLLOWUP_ROUTES`, profiles `["web","desktop-core"]`, guard `read_source_cache_only` for GET and `allow_shared` otherwise, an owner and an existing oracle test).
- Commits: imperative intent-style subject (as in git history), stage only the task's files by explicit path, never `git add -A` (the tree holds unrelated deleted root images and an untracked `media-assets/`); executors add the attribution trailers.
- Commands: `cd backend && uv run pytest tests/<file>::<name> -v`; `cd frontend && bun test tests/<file>`; `bun run build` (= `tsc --noEmit && vite build`).

## Review Focus

Failure modes the spec implies but its test list does not pin; each has a test in the task named.

1. Search fed hostile text (`"`, `a"b`, `-`, `*`, `AND`, `(`, `Σ'`, `title:`) never raises or 500s; punctuation-only terms are ignored (Task 2).
2. A database created before this release (user_version 0, unfolded FTS, no `facets` table, no `valence`) backs up, migrates once and then finds accentless text (Tasks 3, 4).
3. A bulk request that cannot complete (unknown tag id, zero matches, both or neither scope, two values for one single-value facet) writes nothing, creates no profile rows and answers in Greek (Task 8).
4. Windows paths: `C:\Music\Relax\` must not match `C:\Music\Relaxation\`, mixed separators and drive-letter case fold the same (Tasks 6, 15).
5. Vocabulary values that confuse the grammar: accent/case duplicates, `:` inside a value, whitespace-only, `"`, and deleting a value that saved searches use (Task 5).

## File Structure

Backend (`backend/app/`): create `services/text_fold.py` (`fold_text`), `services/query_grammar.py` (tokenize/serialize), `services/sql_ids.py` (`ids_in`), `services/facets.py` + `services/facet_presets.py`, `services/bulk_edit.py`, `api/facets.py`. Modify `db.py`, `models.py`, `schemas.py`, `services/{search,audit,backup,exporter_csv,legacy_import}.py`, `api/{tracks,tags}.py`, `app_factory.py`, `library_exchange/operations.py`, `desktop_runtime/bootstrap.py`, `schema_contract.json` (generated), `scripts/desktop/check_parity_inventory.py`, `docs/README.md`.

Frontend (`frontend/src/`): create `lib/{queryGrammar,facets,profileCopy,profileFields,selection,queuePaging}.ts`, `components/{FacetEditor,VocabularySettings,ProfileChooser,BulkTagBar}.tsx`. Modify `lib/{prefs,capabilities,labels,tagKeys,tablePreferences,useTablePreferences,trackSort,queryChips,api,types}.ts`, `app/App.tsx`, `components/{layout/Sidebar,CommandPalette,TrackTable,ProfileEditor,ShortcutsDialog,SetTimeline,RecommendationCard,MiniPlayer}.tsx`, `pages/{Library,TaggingQueue,TagCloud,Settings,Artists}.tsx`.

Tests: `backend/tests/{test_query_grammar,test_search_therapy,test_fts_migration,test_valence,test_facets,test_facet_routes,test_bulk_tagging,test_triage_routes}.py`, `test_backup.py`, `conftest.py`, fixture `backend/tests/fixtures/query_grammar.json`; `frontend/tests/{queryGrammar,profileRoutes,therapyLabels,facetUi,bulkSelection,queuePaging}.test.ts(x)` plus edits to `tagKeys.test.ts`, `tablePreferences.test.ts`.

## Shared Interfaces (defined once; later tasks reuse these exact names)

```
Facet       {id, key, label, multi, sort_order, values: FacetValue[]}      FacetValue {id, value, count}   # id == Tag.id, value == text after "key:"
GET    /api/facets                              -> Facet[]  (order: sort_order, id)
POST   /api/facets {label,multi,key?}           -> Facet   (key omitted = server slug from the label, Task 5)
POST   /api/facets/{id} {label?,multi?,sort_order?} -> Facet
DELETE /api/facets/{id}?force=false             -> {deleted_values, untagged_tracks}
POST   /api/facets/{id}/values {value}          -> FacetValue
POST   /api/facets/values/{id} {value}          -> FacetValue + {rewritten_searches}
DELETE /api/facets/values/{id}?force=false      -> {removed_assignments, broken_searches: string[]}
POST   /api/facets/presets/{name}   (name "therapy") -> {created_facets, created_values, adopted_tags}
GET    /api/facets/counts?q=                    -> {total, counts: {"<value_id>": n}}
GET    /api/tracks?q=&limit=&offset=&after=<track_id> -> rows ordered by (coalesce(artist,''), coalesce(title,''), id); `after` = keyset cursor, 404 if that track is gone (Task 15)
GET    /api/tracks/folders                      -> [{path, count}]   (path uses "/" separators)
POST   /api/tracks/batch-profile {track_ids?, query?, profile?, add_tag_ids?, remove_tag_ids?, dry_run?} -> {updated, matched, replaced, dry_run}
Errors: 404 unknown id, 409 conflict/needs-force (detail = Greek message with counts), 422 invalid.
```

Python: `fold_text(s: str) -> str`; `Token(neg: bool, field: str|None, value: str, quoted: bool)` (frozen dataclass), `tokenize(query) -> list[Token]`, `serialize(tokens) -> str`; `ids_in(column, ids) -> ColumnElement`; `FacetError(ValueError)` with `.code`; `TagDiff(added, removed, replaced: list[int])`; `facets.plan_tag_changes / apply_tag_changes(session, track_id, add_ids, remove_ids, *, commit=True, reindex=True) -> TagDiff` (the plan form never writes; `reindex=False` also skips audit, for bulk callers that own both); `facets.count_text(n, one, many) -> str` («1 κομμάτι», «2 κομμάτια») for every count in Greek messages.

TypeScript (`lib/types.ts`): `Facet`, `FacetValue`, `BatchEditRequest`, `BatchEditResult`, `FolderCount`, `LibraryProfile = "dj"|"therapy"` (in `lib/prefs.ts`). `lib/queryGrammar.ts`: `QueryToken`, `tokenizeQuery`, `serializeTokens`. `lib/api.ts`: `listTracks(q?, limit=300, offset=0, after?: number)`, `listFacets()`, `createFacet(body)`, `updateFacet(id, body)`, `deleteFacet(id, force?)`, `addFacetValue(facetId, value)`, `renameFacetValue(valueId, value)`, `deleteFacetValue(valueId, force?)`, `loadFacetPreset(name)`, `facetCounts(q)`, `listFolders()`, `batchEdit(body: BatchEditRequest)`. `lib/facets.ts`: `tagDisplayName`, `tagQuery`, `groupTags`, `useFacets()`.

---

### Task 1: Accent folding and the shared query grammar (A0)

**Files:**
- Create: `backend/app/services/text_fold.py`, `backend/app/services/query_grammar.py`, `backend/tests/fixtures/query_grammar.json`, `backend/tests/test_query_grammar.py`, `frontend/src/lib/queryGrammar.ts`, `frontend/tests/queryGrammar.test.ts`
- Modify: `backend/app/db.py:35` (register `cratemind_fold` next to `cratemind_key`), `frontend/src/lib/queryChips.ts:27` (replace the regex tokenizer)

**Interfaces:**
- Produces: `fold_text`, `Token`, `tokenize`, `serialize`, SQL function `cratemind_fold(text)` (NULL in, NULL out); TS `QueryToken {neg, field, value, quoted}`, `tokenizeQuery(q)`, `serializeTokens(tokens)`.

- [ ] **Step 1: Write the failing tests.** `test_query_grammar.py`: `fold_text("Μάνος Χατζιδάκις") == "μανοσ χατζιδακισ"`, `fold_text("ΧΑΛΑΡΩΣΗ") == "χαλαρωση"`, `fold_text("ς") == "σ"`, `fold_text("Ο ΚΟΣΜΟΣ") == "ο κοσμοσ"`, `fold_text("ΐ ΰ Ϊ") == "ι υ ι"`; `select cratemind_fold('Μάνος')` is `"μανοσ"` and `select cratemind_fold(NULL)` is `None` (use the `db` fixture); a parametrised test over `query_grammar.json` asserting `[asdict(t) for t in tokenize(c["query"])] == c["tokens"]` and `serialize(tokenize(c["query"])) == c["serialized"]`. `queryGrammar.test.ts` reads the same file with `readFileSync(new URL("../../backend/tests/fixtures/query_grammar.json", import.meta.url))` and asserts the same two equalities against `tokenizeQuery`/`serializeTokens`. Fixture: a JSON array of `{query, tokens:[{neg,field,value,quoted}], serialized}`:

| query | tokens (neg field value quoted) | serialized |
|---|---|---|
| `energy:7-9 -retired` | `F energy 7-9 F`; `T null retired F` | same |
| `Σ' αγαπώ` | `F null Σ' F`; `F null αγαπώ F` | same |
| `purpose:"συναισθηματική έκφραση" -mood:*` | `F purpose συναισθηματική έκφραση T`; `T mood * F` | same |
| `-"two words"` | `T null two words T` | same |
| `"unterminated` | `F null "unterminated F` | same |
| `artist:"O'Brien"` | `F artist O'Brien T` | same |
| `folder:C:\Music\ΧΑΛΑΡΩΣΗ` | `F folder C:\Music\ΧΑΛΑΡΩΣΗ F` | same |
| `title:""` | `F title "" T` | same |
| `  a   b ` | `F null a F`; `F null b F` | `a b` |
| `` (empty) | none | `` |
| `Re:` | `F null Re: F` | same |
| `a b` (NBSP) | `F null a F`; `F null b F` | `a b` |
| `a\u0085b` (NEL) | `F null a F`; `F null b F` | `a b` |
| `﻿energy:5` (BOM) | `F energy 5 F` | `energy:5` |

- [ ] **Step 2: Run to verify FAIL.** `cd backend && uv run pytest tests/test_query_grammar.py -v` (ImportError); `cd frontend && bun test tests/queryGrammar.test.ts` (module missing).
- [ ] **Step 3: Implement.** `fold_text` body: `"".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c)).casefold()`. Grammar (one regex, identical in both languages; only `"` quotes, no escapes). Whitespace is the explicit class `WS = [\t\n\x0b\x0c\r\x1c-\x1f \x85\xa0  -     　﻿]` (the union of Python `str.isspace()` and JS `\s`; never use `\s`/`\S`, which differ between the languages on U+0085 and U+FEFF):
  ```
  TOKEN = (-)?(?:([^WS:"]+):)?(?:"([^"]*)"|([^WS]+))     # groups: neg, field, quoted value, bare value
  serialize: ("-" if neg) + (field + ":" if field) + (quoted if token.quoted or value == "" or value has whitespace else bare), joined by one space
  ```
  Python: `re.finditer`; TS: `matchAll(/…/g)`. Register `dbapi_connection.create_function("cratemind_fold", 1, lambda v: None if v is None else fold_text(v), deterministic=True)` in `db.py`. In `queryChips.ts` replace `tokenize()`/`unquote()` with `tokenizeQuery`; `field`/`value` come straight from the token (bare tokens have `field === null`); keep chip output identical for existing queries.
- [ ] **Step 4: Run to verify PASS.** Both commands from Step 2, plus `cd backend && uv run pytest tests/test_search.py -q` and `cd frontend && bun run build`.
- [ ] **Step 5: Commit.**
  ```bash
  git add backend/app/services/text_fold.py backend/app/services/query_grammar.py backend/app/db.py backend/tests/fixtures/query_grammar.json backend/tests/test_query_grammar.py frontend/src/lib/queryGrammar.ts frontend/src/lib/queryChips.ts frontend/tests/queryGrammar.test.ts
  git commit -m "Add accent folding and one shared query grammar for backend and frontend"
  ```

---

### Task 2: Folded, prefix-aware search that survives any library size (A0)

**Files:**
- Create: `backend/app/services/sql_ids.py`, `backend/tests/test_search_therapy.py`
- Modify: `backend/app/services/search.py` (`_build_query` :251, `_apply_free_text` :224, `_compile_str` :144, `search()` order), `backend/app/db.py` (`reindex_track` :269), `backend/app/api/tracks.py` (`_list_payload` :104-150), `backend/app/desktop_runtime/bootstrap.py` (`self_test`), `backend/tests/conftest.py`

**Interfaces:**
- Consumes: Task 1 `fold_text`, `tokenize`, `cratemind_fold`.
- Produces: `ids_in(column, ids: Iterable[int|str])`; pytest fixture `low_variable_limit` (listen on `dbmod.get_engine()` `connect`, call `dbapi.setlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, 100)`, `engine.dispose()` to force new connections, undo on teardown; request it after `db`/`client`).

- [ ] **Step 1: Write the failing tests** in `test_search_therapy.py` (helper `_mk` as in `test_search.py`; tracks reindexed):
  - `test_greek_accentless_final_sigma_and_prefix`: track artist «Μάνος Χατζιδάκις», title «Χαλάρωση»; `search.search(db, q)` finds it for `μανος χατζιδακις`, `ΜΑΝΟΣ`, `χαλαρωση`, `χατζιδ`, `artist:μάνος`, `artist:ΜΑΝΟΣ`; title «Κόσμος» is found by `ΚΟΣΜΟΣ` and `κοσμος`.
  - `test_exclusion_is_exact_while_inclusion_is_prefix`: titles «Relax One», «Relaxation Two»: `relax` finds both; `-relax` returns only «Relaxation Two».
  - `test_accented_exclusion`: titles «Χαλάρωση Α», «Ύπνος»: `-χαλάρωση`, `-ΧΑΛΑΡΩΣΗ` and `-χαλαρωση` each return only «Ύπνος»; `ύπνος -χαλάρωση` returns «Ύπνος» (inclusion and exclusion in one statement).
  - `test_elision_and_quoted_values`: title «Σ' αγαπώ» is found by `Σ' αγαπώ`; `artist:"Μάνος Χατζιδάκις"` finds the track.
  - `test_hostile_input_never_raises`: for q in `['"', 'a"b', '-', '*', 'AND', 'OR', 'NOT', '(', 'title:', ':', '""', "'"]` both `search.search` and `search.count` return without exception.
  - `test_variable_cap_free_text_listing_and_exclusion(client, low_variable_limit)`: seed 150 tracks titled «Ambient {i}» through `Session(dbmod.get_engine())`; `GET /api/tracks?q=ambient&limit=0` returns 150 rows; `GET /api/tracks?q=untagged&limit=0` returns 150; `GET /api/tracks/count?q=ambient` is 150; `search.search(session, "ambient -ambient")` is empty; `search.search(session, "ambient -title999")` has 150.
  - `test_low_variable_limit_fixture_really_limits`: `select(Track.id).where(Track.id.in_(list(range(150))))` raises `OperationalError` under the fixture.
  - `test_track_search_only_read_for_ids`: scan `backend/app/**/*.py` for `SELECT … FROM track_search`; outside `desktop_runtime/adoption.py` and `desktop_runtime/bootstrap.py` the selected column list must be `rowid`.
  - `test_frozen_self_test_covers_json_each_and_fold`: run the self-test in a subprocess exactly as `test_desktop_bootstrap.py:149` does (the test process itself has `audio_analysis` imported, which the self-test rejects at `bootstrap.py:105`); it exits 0 and its JSON carries `"json_each": 2` and `"fold": "μανοσ"` (new fields, so the test fails first).
- [ ] **Step 2: Run to verify FAIL.** `cd backend && uv run pytest tests/test_search_therapy.py -v`.
- [ ] **Step 3: Implement.**
  - `reindex_track`: write `fold_text(x or "")` for all eight columns (facet value-part comes in Task 5).
  - `ids_in`: `je = func.json_each(json.dumps(sorted(set(ids)))).table_valued("value"); return column.in_(select(je.c.value))`.
  - `_build_query`: iterate `tokenize(query)`; `body` for `_LOCAL_TOKENS`/`collections:` is `f"{field}:{value}"` when `field` else `value`; bare-token lookup uses `value.lower()`; unknown `field:value` still falls to free text with `value`. `local_search_ids(...)` is wrapped by `ids_in(Track.id, …)`.
  - `_apply_free_text`: positive **and excluded** terms are `fold_text`'d (the index is folded, so an accented exclusion would otherwise exclude nothing), terms without any `isalnum()` char dropped, `"` doubled; inclusion expression `' '.join(f'"{t}"*' …)`, criterion `Track.id.in_(fts(expr, "fts_include")) | ids_in(Track.id, search_ids(raw_terms, session=session))` where
    ```python
    def fts(expr, name):  # no bound ids; each MATCH gets its own bind name (two `:q` binds in one statement collide)
        return select(literal_column("rowid")).select_from(table("track_search")).where(text(f"track_search MATCH :{name}").bindparams(**{name: expr}))
    ```
    Exclusions: exact `"t"` phrases joined by ` OR `, `~Track.id.in_(fts(excl, "fts_exclude"))`. `_apply_free_text` no longer returns `None`. Prior art for `json_each`: the overlay code already uses it.
  - `_compile_str` kind `contains`: `func.instr(func.cratemind_fold(col), fold_text(val)) > 0`; the artist/album identity union uses `ids_in`. `search()` adds `Track.id` as the last `order_by`.
  - `_list_payload`: the three `.in_(...)` lists (profiles, SoundCloud, artist names) go through `ids_in`.
  - `bootstrap.self_test`: also run `SELECT count(*) FROM json_each('[1,2]')` and `fold_text("Μάνος")`, fail unless they are 2 and `"μανοσ"`, and print them in its JSON as `"json_each"` and `"fold"`.
- [ ] **Step 4: Run to verify PASS.** `cd backend && uv run pytest tests/test_search_therapy.py tests/test_search.py tests/test_v1_1.py tests/test_desktop_bootstrap.py -q`. If an existing test encoded whole-word matching, update it to prefix semantics and say so in the commit body.
- [ ] **Step 5: Commit.**
  ```bash
  git add backend/app/services/sql_ids.py backend/app/services/search.py backend/app/db.py backend/app/api/tracks.py backend/app/desktop_runtime/bootstrap.py backend/tests/conftest.py backend/tests/test_search_therapy.py
  git commit -m "Make search accent-insensitive, prefix-aware and safe past SQLite's variable cap"
  ```

---

### Task 3: First-launch FTS rebuild in one transaction (A0)

**Files:**
- Modify: `backend/app/db.py` (`STARTUP_MIGRATION_REVISION` :158 -> 2, `reindex_all` :317, new `migrate_fts_index`), `backend/app/app_factory.py:26,74-79`
- Test: `backend/tests/test_fts_migration.py`

**Interfaces:**
- Produces: `db.FTS_INDEX_VERSION = 1`; `db.migrate_fts_index() -> {"rebuilt": bool, "seconds": float, "tracks": int}`; `launch_phase["fts_rebuild"]` (seconds); `reindex_all(session, *, commit: bool = True)` commits at most once.

- [ ] **Step 1: Write the failing tests.**
  - `test_marker_set_and_idempotent(db)`: 3 tracks, raw unfolded rows inserted into `track_search`, `PRAGMA user_version=0`; `migrate_fts_index()["rebuilt"]` is True, `user_version == FTS_INDEX_VERSION`, the FTS `title` for «Μάνος» is `"μανοσ"`; a second call returns `rebuilt False` and does not call `reindex_all` (monkeypatched counter).
  - `test_rebuild_is_one_transaction(db)`: a SQLAlchemy `commit` event counter on the engine reads exactly 1 during a rebuild of 20 tracks (rows and marker together).
  - `test_failed_rebuild_rolls_back_rows_and_marker(db, monkeypatch)`: `reindex_track` raises on the third track; the call raises, `PRAGMA user_version` is still 0 and the FTS rows are the original unfolded ones.
  - `test_revision_bumped`: `STARTUP_MIGRATION_REVISION >= 2`.
  - `test_startup_order(…)` parametrised: dataset mode (model on `test_djay_import.py:687`, profiles `web` and `desktop-core`) records events `["backup","init_db","migrate"]`; non-dataset mode (model on `test_worker.py:285`) records `["init","backup","migrate"]` — wrap `migrate_fts_index` too.
  - `test_old_db_backed_up_before_reindex`: a dataset whose catalog has `user_version 0` and an unfolded FTS row; after `TestClient(create_app())` startup, `launch_phase["backup"]` starts with `new:`, the bundle's `catalog.sqlite` still holds the unfolded row and the live catalog the folded one, and `launch_phase["fts_rebuild"]` exists.
  - `test_rebuild_timing`: bulk-insert `n = int(os.environ.get("CM_FTS_BENCH_TRACKS", "2000"))` tracks with executemany (not a `CRATEMIND_*` name: `conftest.py:27` deletes those), run the migration, assert `result["tracks"] == n`, `print(f"fts_rebuild tracks={n} seconds={s:.1f}")`, assert `s < 300` (the desktop start budget, `native/src-tauri/src/lib.rs:256`).
- [ ] **Step 2: Run to verify FAIL.** `cd backend && uv run pytest tests/test_fts_migration.py -v`.
- [ ] **Step 3: Implement** `reindex_all` (loop `reindex_track(..., commit=False)`, then `session.commit()` only when `commit`), the revision bump, and the migration sequence:
  ```python
  def migrate_fts_index() -> dict:
      engine = get_engine()
      with engine.connect() as c:
          if c.exec_driver_sql("PRAGMA user_version").scalar_one() >= FTS_INDEX_VERSION:
              return {"rebuilt": False, "seconds": 0.0, "tracks": 0}
      started = time.perf_counter()
      with Session(engine) as s:                        # one transaction: rows and marker commit or roll back together
          s.execute(text("DELETE FROM track_search"))
          tracks = reindex_all(s, commit=False)
          s.execute(text(f"PRAGMA user_version = {FTS_INDEX_VERSION}"))   # transactional in SQLite (probed)
          s.commit()
      launch_phase["fts_rebuild"] = seconds = time.perf_counter() - started
      return {"rebuilt": True, "seconds": seconds, "tracks": tracks}
  ```
  Restores and exchange imports never replace the active catalog (`restore_backup` writes only into a new or empty directory, `services/backup.py:384-390`); they become active at the next startup, where this migration runs, so no extra call is needed.
  In `lifespan`: import `migrate_fts_index` with the other db names and call it once, immediately after `if not settings.dataset_root: backup_on_launch()`, so it runs after the backup in both branches (dataset mode: backup, `init_db`, migrate; web mode: `init_db`, backup, migrate). Append `fts_rebuild={launch_phase.get('fts_rebuild', 0.0):.2f}s` to the stderr phase line.
- [ ] **Step 4: Run to verify PASS.** The Step 2 command, `tests/test_worker.py tests/test_djay_import.py tests/test_backup_bundle.py -q`, then once `CM_FTS_BENCH_TRACKS=50000 uv run pytest tests/test_fts_migration.py::test_rebuild_timing -s`; note the printed seconds in the commit body.
- [ ] **Step 5: Commit.**
  ```bash
  git add backend/app/db.py backend/app/app_factory.py backend/tests/test_fts_migration.py
  git commit -m "Rebuild the search index with folded text in one transaction at first launch"
  ```

---

### Task 4: Valence axis and facets table with schema contract (A2/A3)

**Files:**
- Modify: `backend/app/models.py` (`TrackDJProfile.valence`, new `Facet`), `backend/app/db.py` (`_ensure_columns` :63), `backend/app/schemas.py` (`ProfileUpdate`), `backend/app/api/tracks.py` (`_list_payload` :144-150), `backend/app/schema_contract.json` (generated)
- Test: `backend/tests/test_valence.py`

**Interfaces:**
- Produces: `TrackDJProfile.valence: Optional[int]`; `Facet(id, key unique, label, multi: bool = True, sort_order: int = 0)` table `facets`; `_ensure_columns(conn, table: str, columns: dict[str, str])`; `ProfileUpdate.valence: Optional[int] = Field(default=None, ge=1, le=10)`; list rows carry `valence`.

- [ ] **Step 1: Write the failing tests.** `test_ensure_columns_adds_valence_to_pre_valence_database(tmp_path)` (sqlite file with `track_dj_profile(track_id integer primary key, energy integer)`; call twice; `PRAGMA table_info` has `valence`); `test_profile_valence_round_trip(client)` (PATCH `/api/tracks/{id}/profile` `{"valence":7}` returns 200 with 7; `{"valence":11}` is 422; `GET /api/tracks` row has `valence == 7`, a profile-less track has `valence is None`); `test_init_db_creates_facets_table(db)`.
- [ ] **Step 2: Run to verify FAIL.** `cd backend && uv run pytest tests/test_valence.py -v`.
- [ ] **Step 3: Implement.** `init_db` calls `_ensure_columns(conn, "tracks", {"created_time": "FLOAT"})` and `_ensure_columns(conn, "track_dj_profile", {"valence": "INTEGER"})`. Add `row["valence"] = p.valence if p else None`. Regenerate the contract: `backend/.venv/bin/python scripts/desktop/generate_schema_contract.py`.
- [ ] **Step 4: Run to verify PASS.** `uv run pytest tests/test_valence.py tests/test_desktop_schema_contract.py tests/test_desktop_contract_inventory.py tests/test_library_exchange.py tests/test_cues.py -q` and `backend/.venv/bin/python scripts/desktop/generate_schema_contract.py --check` ("Schema contract current").
- [ ] **Step 5: Commit.**
  ```bash
  git add backend/app/models.py backend/app/db.py backend/app/schemas.py backend/app/api/tracks.py backend/app/schema_contract.json backend/tests/test_valence.py
  git commit -m "Add a valence axis and the facets table with their schema contract"
  ```

---

### Task 5: Facets service: vocabularies, single-value rule, presets, safe rename/delete (A2)

**Files:**
- Create: `backend/app/services/facets.py`, `backend/app/services/facet_presets.py`
- Modify: `backend/app/db.py` (`reindex_track` tags column), `backend/app/services/audit.py` (`log(..., *, commit: bool = True)`)
- Test: `backend/tests/test_facets.py`

**Interfaces:**
- Consumes: Tasks 1, 4 (`fold_text`, `tokenize`, `serialize`, `Facet`).
- Produces (all in `services/facets.py`; every writer takes `commit: bool = True`): `FacetError(code, message)` with codes `reserved_key|invalid|duplicate|conflict|needs_force|multi_to_single|single_conflict|not_found`; `reserved_keys() -> frozenset[str]` (= `set(search._FIELD_COMPILERS) | {"collections","folder","tag","valence"}`, computed per call); `get_by_key(session, key)`, `list_facets(session) -> list[dict]` (Shared `Facet` shape with usage counts), `slug_key(session, label) -> str` (fold, transliterate Greek α→a β→v γ→g δ→d ε→e ζ→z η→i θ→th ι→i κ→k λ→l μ→m ν→n ξ→x ο→o π→p ρ→r σ→s τ→t υ→y φ→f χ→ch ψ→ps ω→o, non-`[a-z0-9]` runs → `_`, strip `_`; empty → `facet`; reserved or not starting with a letter → prefix `f_`; trim to 28 chars; a taken key gets `_2`, `_3`…; the result always matches `^[a-z][a-z0-9_]{1,30}$`), `create_facet(session, label, multi, key=None)` (key `None` → `slug_key`), `update_facet(session, facet_id, *, label=None, multi=None, sort_order=None)`, `delete_facet(session, facet_id, *, force=False)`, `add_value(session, facet_id, value) -> Tag`, `rename_value(session, tag_id, value) -> dict`, `delete_value(session, tag_id, *, force=False) -> dict`, `value_ids(session, facet, folded) -> list[int]`, `is_facet_name(session, name) -> bool`, `is_facet_tag(session, tag) -> bool`, `plan_tag_changes` / `apply_tag_changes` (Shared Interfaces), `seed_preset(session, name) -> dict`. `THERAPY_PRESET` in `facet_presets.py` transcribes the spec's draft table verbatim (keys, Greek labels, multi flags, values in order; 8 facets, 47 values).

- [ ] **Step 1: Write the failing tests** (`db` fixture, hand-built tracks):
  - `test_preset_seed_is_idempotent_and_additive`: seed twice; 8 facets, 47 `Tag` rows with `category`; second result is all zeros; a manually added extra value survives a re-seed.
  - `test_seed_adopts_uncategorised_tag_and_errors_on_foreign_category`: pre-existing `Tag(name="purpose:χαλάρωση", category=None)` is adopted (same id, `adopted_tags == 1`); `Tag(name="mood:γαλήνια", category="other")` raises `FacetError` code `conflict` with message «Η τιμή «γαλήνια» του λεξιλογίου «Διάθεση» υπάρχει ήδη ως tag της κατηγορίας «other».» (labels, never the key) and nothing is seeded (0 facets).
  - `test_seed_refuses_adoption_that_breaks_single_value`: uncategorised tags `voice:οργανικό` and `voice:με στίχους` both linked to track 1: seeding raises `conflict` «Η υιοθέτηση θα έδινε σε 1 κομμάτι περισσότερες από μία τιμές στο λεξιλόγιο «Φωνή».»; afterwards 0 facets, both tags still uncategorised, both links and the track's FTS row unchanged.
  - `test_slug_key`: «Θεραπευτικός στόχος» → `therapeytikos_stochos`; «Φωνή» with `foni` taken → `foni_2`; «Energy» → `f_energy` (reserved); «1η φάση» → `f_1i_fasi`; «!!!» → `facet`; a 60-char label stays within the regex; every result matches `^[a-z][a-z0-9_]{1,30}$`.
  - `test_value_validation`: «Χαλάρωση» then «χαλαρωση» is `duplicate` («Υπάρχει ήδη τιμή «χαλαρωση» σε αυτό το λεξιλόγιο.»); `a"b` is `invalid` («Η τιμή δεν επιτρέπεται να περιέχει διπλά εισαγωγικά.»); `"   "` is `invalid` («Η τιμή δεν μπορεί να είναι κενή.»); `*` is `invalid` («Η τιμή «*» δεν επιτρέπεται.», it would collide with `key:*`); `"  νέο  "` is stored as `νέο`; a value containing `:` (`a:b`) is accepted and its tag name is `purpose:a:b`.
  - `test_reserved_and_bad_keys`: `create_facet(key=k)` is `reserved_key` for `energy`, `folder`, `collections`, `tag`, `valence`; `"Bad Key"` is `invalid`; slug rule `^[a-z][a-z0-9_]{1,30}$`; `test_reserved_keys_cover_every_field_compiler`: `set(search._FIELD_COMPILERS) <= reserved_keys()` and every `THERAPY_PRESET` key is outside it.
  - `test_single_value_replace_rule`: single facet `voice` with A, B: adding A then B leaves only B and `TagDiff.replaced == [A.id]`; adding both in one call raises `single_conflict`; a multi facet keeps both.
  - `test_multi_to_single_refused_with_count`: track holds two values; `update_facet(multi=False)` raises `multi_to_single` with message «Κομμάτια με περισσότερες από μία τιμές: 1. Αφαίρεσέ τες πρώτα.»; succeeds after removing one.
  - `test_delete_facet_requires_force_and_cascades`: no force raises `needs_force` («Το λεξιλόγιο «Φωνή» έχει 3 τιμές σε 2 κομμάτια. Επιβεβαίωσε για διαγραφή.»); with force the facet, its tags and `track_tags` are gone and FTS no longer matches.
  - `test_rename_rewrites_saved_searches_keeping_negation_and_quotes`: saved queries `purpose:χαλαρωση -mood:γαλήνια`, `-purpose:"Χαλάρωση"`, `PURPOSE:χαλάρωση`, `energy:7+`; rename «χαλάρωση» -> «ηρεμία»: they become `purpose:ηρεμία -mood:γαλήνια`, `-purpose:"ηρεμία"`, `PURPOSE:ηρεμία` (field matched case-insensitively, as search does), unchanged; `rewritten_searches == 3`; `search("ηρεμία")` finds the tracks and the old word none; renaming onto a fold-duplicate sibling raises `duplicate` and changes nothing.
  - `test_delete_value_reports_tracks_and_broken_searches`: value used by 2 tracks and by saved search «Ήρεμα»; no force raises `needs_force` («Η τιμή «ηρεμία» χρησιμοποιείται σε 2 κομμάτια. Θα επηρεαστούν οι αναζητήσεις: «Ήρεμα». Επιβεβαίωσε για διαγραφή.», the sentence about searches omitted when none); force returns `{"removed_assignments": 2, "broken_searches": ["Ήρεμα"]}` and the saved query text is left exactly as it was (delete reports, only rename rewrites).
  - `test_fts_indexes_only_the_value_part`: `track_search.tags` for a track with `purpose:χαλάρωση` and plain tag «my tag» is `"χαλαρωση my tag"`; free text `purpose` finds nothing.
- [ ] **Step 2: Run to verify FAIL.** `cd backend && uv run pytest tests/test_facets.py -v`.
- [ ] **Step 3: Implement.** Value tag name is `f"{facet.key}:{value}"`, `category = key`; all fold comparisons use `fold_text` on the value part. `reindex_track` SQL: left-join `facets f ON f.key = tg.category AND tg.name LIKE f.key || ':%'` and concatenate `CASE WHEN f.id IS NOT NULL THEN substr(tg.name, length(f.key) + 2) ELSE tg.name END`; fold in Python. Saved-search matching (shared by rename and delete): `tokenize` each query and take tokens whose `field.lower() == key` and `fold_text(value) == fold_text(old)`. Rename replaces those values (leave `neg`/`quoted`/field text) -> `serialize`, reindexes affected tracks with `commit=False` and commits once; delete only reports the matching searches in `broken_searches` and never edits a query. `seed_preset` preflights adoption: for each single-value facet it counts tracks that would hold more than one adopted value, and any such track raises `conflict` before anything is written. `apply_tag_changes` removes other values of a single-value facet from the track and reports them in `replaced`; with `reindex=False` it neither reindexes nor audits; the plan form computes the same `TagDiff` without writing. `reserved_keys()` imports `search` inside the function (search imports facets at module level). `audit.log` gains `commit` (default True, behaviour unchanged). All counts in messages go through `count_text`.
- [ ] **Step 4: Run to verify PASS.** `uv run pytest tests/test_facets.py tests/test_search_therapy.py tests/test_search.py -q`.
- [ ] **Step 5: Commit.**
  ```bash
  git add backend/app/services/facets.py backend/app/services/facet_presets.py backend/app/services/audit.py backend/app/db.py backend/tests/test_facets.py
  git commit -m "Add the facets service: vocabularies, single-value rule, presets, safe rename and delete"
  ```

---

### Task 6: Search by valence, facet tokens and folder (A3)

**Files:**
- Modify: `backend/app/services/search.py` (`_PROFILE_NUM` :23, unknown-field branch :279-283, `_field_compilers` :189), `docs/README.md` (Search syntax)
- Test: `backend/tests/test_search_therapy.py` (append)

**Interfaces:**
- Consumes: Task 5 `get_by_key`, `value_ids`; Task 2 `ids_in`.
- Produces: tokens `valence:6-8`, `<key>:<value>`, `<key>:*`, `folder:<text>` (`folder` is in `_FIELD_COMPILERS`, so it is reserved automatically).

- [ ] **Step 1: Write the failing tests** (preset seeded; tracks tagged through `facets.apply_tag_changes`):
  - `test_facet_token_matches_with_and_without_accents`: `purpose:χαλάρωση`, `purpose:χαλαρωση`, `purpose:ΧΑΛΑΡΩΣΗ`, `purpose:"χαλάρωση"` match the tagged track; `purpose:ενεργοποίηση` does not; `purpose:άγνωστο` matches nothing and `-purpose:άγνωστο` matches every track.
  - `test_facet_multiword_value_needs_quotes`: `purpose:"συναισθηματική έκφραση"` matches; `purpose:συναισθηματική` matches nothing.
  - `test_has_any_and_missing`: `purpose:*` returns tracks with any purpose; `-purpose:*` returns exactly the untouched tracks.
  - `test_missing_facet_falls_through_to_free_text`: with no `purpose` facet defined, `-purpose:*` returns all tracks (documented hazard; A6 builds filters from `GET /facets`).
  - `test_folder_token_windows_paths`: tracks `C:\Music\Relax\a.mp3`, `/Users/x/Music/Relax/b.mp3`, `C:\Music\Relaxation\c.mp3`: `folder:"C:/Music/Relax/"` returns only `a`; `folder:"c:\music\relax\"` returns only `a`; `folder:relax` returns all three.
  - `test_valence_range`: valence 5,6,7,8,9: `valence:6-8` returns 6,7,8; `valence:7+` returns 7,8,9.
- [ ] **Step 2: Run to verify FAIL.** `cd backend && uv run pytest tests/test_search_therapy.py -v`.
- [ ] **Step 3: Implement.** `_compile_folder`: `func.instr(func.cratemind_fold(func.replace(Track.absolute_path, "\\", "/")), fold_text(val.replace("\\", "/"))) > 0`, registered as `table["folder"]`. In the unknown-field branch, `facet = facets.get_by_key(session, field)`; `None` keeps today's free-text fallback, otherwise the criterion is:
  ```python
  def _compile_facet(session, facet, val):
      if val == "*":
          return Track.id.in_(select(TrackTag.track_id).join(Tag, Tag.id == TrackTag.tag_id).where(Tag.category == facet.key))
      ids = facets.value_ids(session, facet, fold_text(val))
      return Track.id.in_(select(TrackTag.track_id).where(TrackTag.tag_id.in_(ids))) if ids else false()
  ```
  Update `docs/README.md#search-syntax`: accent-insensitive prefix free text, exact `-term`, `valence:`, vocabulary tokens (`key:value`, `key:*`, `-key:*`), `folder:`, double-quote-only quoting.
- [ ] **Step 4: Run to verify PASS.** `uv run pytest tests/test_search_therapy.py tests/test_search.py tests/test_facets.py -q`.
- [ ] **Step 5: Commit.**
  ```bash
  git add backend/app/services/search.py backend/tests/test_search_therapy.py docs/README.md
  git commit -m "Search by valence, vocabulary tokens and folder with folded matching"
  ```

---

### Task 7: Facet routes, tag-route guards, legacy import, parity classification (A2)

**Files:**
- Create: `backend/app/api/facets.py`, `backend/tests/test_facet_routes.py`
- Modify: `backend/app/app_factory.py:151,172` (import and add `facets` to the router tuple), `backend/app/api/tags.py:32-48`, `backend/app/services/legacy_import.py:34,96-108`, `scripts/desktop/check_parity_inventory.py` (`FOLLOWUP_ROUTES`)

**Interfaces:**
- Consumes: Task 5 service; produces the routes in Shared Interfaces (no PATCH). `FacetError` maps `reserved_key|invalid|single_conflict` -> 422, `not_found` -> 404, everything else -> 409, `detail = str(error)`. `GET /facets/counts` resolves `q` with `search._build_query(...).with_only_columns(Track.id)` as a subquery over `track_tags` (never a bound id list).

- [ ] **Step 1: Write the failing tests** (`client` fixture):
  - `test_facet_routes_crud_and_counts`: POST `/api/facets` `{"key":"voice","label":"Φωνή","multi":false}` returns it; duplicate key 409, key `energy` 422; add values, rename (response has `rewritten_searches`), `GET /api/facets` shows `count`s and ordering; `GET /api/facets/counts?q=` gives `total` and per-`value_id` counts, and with `q=voice:οργανικό` counts only those tracks; DELETE value and facet answer 409 with the Greek message first, then succeed with `?force=true`; `POST /api/facets/presets/therapy` twice (second returns zeros), unknown preset 404.
  - `test_counts_with_low_variable_limit(client, low_variable_limit)`: 150 tagged tracks: `total == 150` and `counts[str(value_id)] == 150`.
  - `test_tag_routes_cannot_bypass_single_value_rule`: `POST /api/tags` `{"name":"voice:οργανικό"}` and `{"name":"x","category":"voice"}`, `POST /api/tracks/1/tags` with that name and with `{"tag_id": <value id>}` are all 400 «Οι τιμές λεξιλογίων αλλάζουν μόνο από τα Λεξιλόγια ή την ουρά ταξινόμησης.» and the `tags` row count is unchanged after each (no tag created before the refusal); an ordinary tag still assigns; `DELETE /api/tracks/1/tags/{facet tag id}` works, goes through the facets service and the track's FTS row no longer holds the value.
  - `test_legacy_import_restores_facets_through_the_service` (`db` fixture; this is the desktop JSON import, `app_factory.py:166-168`, so skipping facet tags would lose her assignments): version-2 payload with `facets: [{key:"voice",label:"Φωνή",multi:false,sort_order:0}, {key:"energy",label:"x",multi:true,sort_order:1}]`, tags `voice:οργανικό` and `voice:με στίχους` (category `voice`) and `plain`, track 1 linked to all three: the `voice` facet is created, track 1 holds exactly one voice value (the later link replaced the earlier, `replaced_facet_values == 1`) plus `plain`; the reserved `energy` facet is skipped (`skipped_facets == 1`) and its links counted in `skipped_facet_links`; re-importing the same payload changes nothing.
  - Parity: `backend/.venv/bin/python scripts/desktop/check_parity_inventory.py --runtime web` and `--runtime desktop-core` exit 0 (fail before the entries exist).
- [ ] **Step 2: Run to verify FAIL.** `cd backend && uv run pytest tests/test_facet_routes.py tests/test_desktop_contract_inventory.py -v`.
- [ ] **Step 3: Implement.** Router prefix `/facets`, request models in `api/facets.py`. `tags.py`: in `create_tag` and `assign_tag`, check the name (`facets.is_facet_name`) and `req.category` **before** `_get_or_create_tag` can create a row (HTTP 400); then check the resolved tag's `category` with `facets.is_facet_tag` whatever the lookup path (`tag_id` or name). `remove_tag` delegates facet-owned tags to `facets.apply_tag_changes(session, track_id, [], [tag_id])`. `legacy_import`: add `"facets"` to the validated families; create each missing payload facet through `facets.create_facet(..., key=payload_key, commit=False)` (an existing facet with that key is reused; a reserved or invalid key is skipped and counted in `skipped_facets`); facet values through `facets.add_value(..., commit=False)` (existing values reused); facet links through `facets.apply_tag_changes(session, track_id, [value_id], [], commit=False, reindex=False)` one link at a time, so the single-value rule holds and replacements are counted in `replaced_facet_values`; links of a skipped facet are counted in `skipped_facet_links`; reindex each touched track once at the end, inside the import's existing transaction. `FOLLOWUP_ROUTES`: nine entries for the Shared-Interfaces facet routes (paths `/api/facets…`, GET guard `read_source_cache_only`, others `allow_shared`, `verification_owner: "facets"`, oracle `backend/tests/test_facet_routes.py::test_facet_routes_crud_and_counts`).
- [ ] **Step 4: Run to verify PASS.** The Step 2 command plus both parity commands and `uv run pytest tests/test_legacy_metadata_import.py tests/test_desktop_profile.py -q`.
- [ ] **Step 5: Commit.**
  ```bash
  git add backend/app/api/facets.py backend/app/app_factory.py backend/app/api/tags.py backend/app/services/legacy_import.py scripts/desktop/check_parity_inventory.py backend/tests/test_facet_routes.py
  git commit -m "Add facet routes, guard tag routes and legacy import, classify routes for desktop parity"
  ```

---

### Task 8: Transactional bulk edit with tags, query scope and diff audit (A2)

**Files:**
- Create: `backend/app/services/bulk_edit.py`, `backend/tests/test_bulk_tagging.py`
- Modify: `backend/app/schemas.py:95-97` (`BatchProfileUpdate`), `backend/app/api/tracks.py:512-565` (`_apply_profile`, `batch_profile`)

**Interfaces:**
- Consumes: Task 5 `plan_tag_changes`/`apply_tag_changes`, `audit.log(commit=False)`, `reindex_track(commit=False)`, Task 2 `ids_in`.
- Produces: `BatchProfileUpdate(track_ids: list[int] = [], query: str | None = None, profile: ProfileUpdate | None = None, add_tag_ids: list[int] = [], remove_tag_ids: list[int] = [], dry_run: bool = False)`; `bulk_edit.run_batch(session, req) -> {"updated","matched","replaced","dry_run"}`; `_apply_profile(session, track_id, update, *, bulk: bool = False)` — with `bulk=True` it only applies fields and returns `{"before": {...}, "after": {...}}` for the changed fields (or `None` when nothing changed): no commit, no audit, no reindex, and no profile row is created when the update sets nothing. `run_batch` owns the rest: exactly one combined `AuditLog` row and one `reindex_track(commit=False)` per changed track, tags via `apply_tag_changes(..., commit=False, reindex=False)`. Scope: `track_ids` non-empty xor `query is not None`; `query == ""` means the whole library.

- [ ] **Step 1: Write the failing tests** (`client`; `reindex` through the service):
  - `test_tag_only_bulk_creates_no_profiles`: 3 profile-less tracks, `add_tag_ids=[purpose value]`: `updated == 3`, `track_dj_profile` has 0 rows, `search("untagged")` still returns 3, and `search("χαλαρωση")` finds them.
  - `test_one_commit_and_diff_audit_rows`: an engine `commit` listener counts exactly 1 during the POST; tracks with `energy 5`, request `{"profile":{"energy":8},"add_tag_ids":[X]}` yields per-track `AuditLog` rows (`action "batch_update"`) with `before_json == {"energy":5}` and `after_json == {"energy":8,"tags_added":[X]}` and `len(...) < 200`; a replaced single-value tag appears as `before_json["tags_removed"]`.
  - `test_single_value_replace_count_and_dry_run`: `voice` single; track 1 has A, track 2 none, track 3 has B: dry run adding A to all three returns `{"updated":0,"matched":3,"replaced":1,"dry_run":true}` and writes nothing (`track_tags` unchanged, no audit rows); the real call returns `replaced == 1`, `updated == 3` and track 3 holds only A.
  - `test_query_scope_resolved_by_subquery(client, low_variable_limit)`: 150 tracks «Ambient {i}», `{"query":"ambient","add_tag_ids":[X]}` returns `matched == 150`.
  - `test_unresolvable_requests_write_nothing`: `add_tag_ids=[999999]` 404 «Άγνωστο tag.»; both `track_ids` and `query` 422 «Δώσε είτε κομμάτια είτε αναζήτηση.»; neither 422; nothing to change 422 «Δεν ζητήθηκε καμία αλλαγή.»; two values of one single facet 422; `query` matching zero tracks returns 200 with `updated 0`; after each, no profile/audit/track_tags rows were added.
  - `test_one_audit_row_and_one_reindex_per_track`: 3 tracks, profile + tag change: a `reindex_track` spy records exactly 3 calls and there are exactly 3 `AuditLog` rows.
  - `test_failure_mid_batch_rolls_back_everything`: `facets.apply_tag_changes` raises on the second track; the request fails and `track_tags`, `track_dj_profile` and `audit_log` are exactly as before (first track included).
  - `test_empty_query_scope_is_whole_library`: `{"query":"","add_tag_ids":[X],"dry_run":true}` returns `matched` equal to the total track count.
  - `test_bulk_never_touches_audio_files`: write WAVs with `make_wav`; hash and mtime are identical after a bulk request.
  - `test_legacy_clients_unchanged`: `{"track_ids":[1,2],"profile":{"energy":6}}` returns 200 with `updated == 2`; existing suites calling `batch-profile` still pass.
- [ ] **Step 2: Run to verify FAIL.** `cd backend && uv run pytest tests/test_bulk_tagging.py -v`.
- [ ] **Step 3: Implement** `run_batch`: validate scope and tag ids first (404/422 before any write); resolve ids (`track_ids` via `ids_in` existence check; `query` via `search._build_query(session, q)` -> `stmt.with_only_columns(Track.id)` rows, never re-bound); loop per track calling `_apply_profile(..., bulk=True)` when `profile.model_dump(exclude_unset=True)` is non-empty and `facets.apply_tag_changes(..., commit=False, reindex=False)`; for each changed track one `reindex_track(commit=False)` and one `audit.log(commit=False)` row combining the profile diff and the tag diff (shape above); `session.commit()` once; `session.rollback()` and re-raise on any exception; `dry_run` uses `plan_tag_changes` only. `batch_profile` delegates to `run_batch`.
- [ ] **Step 4: Run to verify PASS.** `uv run pytest tests/test_bulk_tagging.py tests/test_facets.py tests/test_v1_1.py tests/test_stabilization.py -q`.
- [ ] **Step 5: Commit.**
  ```bash
  git add backend/app/services/bulk_edit.py backend/app/schemas.py backend/app/api/tracks.py backend/tests/test_bulk_tagging.py
  git commit -m "Make batch-profile transactional with tag edits, query scope and diff audit"
  ```

---

### Task 9: Facets in JSON backup, exchange summary and CSV (A2)

**Files:**
- Modify: `backend/app/services/backup.py:40-52`, `backend/app/library_exchange/operations.py:443-457` (`_change_summary` labels), `backend/app/services/exporter_csv.py`
- Test: `backend/tests/test_backup.py` (append)

**Interfaces:**
- Produces: `payload["facets"]` in the v2 JSON export; label `"facets": "Λεξιλόγια"`; CSV columns `valence` (after `darkness`) and one column per facet in `(sort_order, id)` order; header `facet.label`, a repeated label gets « (2)», « (3)»; the `DictWriter` keys are `facet:<id>` internally so equal labels never collide; values joined by `"; "` in tag-id order.

- [ ] **Step 1: Write the failing tests.** `test_json_backup_includes_facets_and_valence`: with a `voice` facet, a tagged track and valence 7, `export_json` payload has `facets[0]["key"] == "voice"`, `profiles[0]["valence"] == 7`, and `tags` carries the facet tag with its category. `test_bundle_round_trip_keeps_facets`: `create_backup` then `restore_backup`; the restored `catalog.sqlite` has `select key from facets` == `voice`. `test_csv_has_valence_and_one_column_per_facet`: header contains `valence` and «Θεραπευτικός στόχος»; a track holding two purpose values has cell `"χαλάρωση; ύπνος"`; two facets both labelled «Φωνή» give headers «Φωνή» and «Φωνή (2)» with their own values. `test_change_summary_labels_facets`: two backups (before/after adding a facet) give a summary row `{"table":"facets","label":"Λεξιλόγια"}`.
- [ ] **Step 2: Run to verify FAIL.** `cd backend && uv run pytest tests/test_backup.py -v`.
- [ ] **Step 3: Implement.** Add `"facets": _dump(session.exec(select(Facet)).all())` and import `Facet`; extend `_COLUMNS`; build the facet cells from one `select(TrackTag.track_id, Tag.category, Tag.name).join(Tag).where(Tag.category.in_(keys))` read (no per-track binding), value part only.
- [ ] **Step 4: Run to verify PASS.** `uv run pytest tests/test_backup.py tests/test_backup_bundle.py tests/test_export_m3u.py tests/test_library_exchange.py -q`.
- [ ] **Step 5: Commit.**
  ```bash
  git add backend/app/services/backup.py backend/app/library_exchange/operations.py backend/app/services/exporter_csv.py backend/tests/test_backup.py
  git commit -m "Carry facets and valence through JSON backup, exchange summaries and CSV export"
  ```

---

### Task 10: Facet UI: API client, FacetEditor, TagCloud, Λεξιλόγια settings (A4)

**Files:**
- Create: `frontend/src/lib/facets.ts`, `frontend/src/components/FacetEditor.tsx`, `frontend/src/components/VocabularySettings.tsx`, `frontend/tests/facetUi.test.tsx`
- Modify: `frontend/src/lib/types.ts`, `frontend/src/lib/api.ts`, `frontend/src/lib/queryChips.ts`, `frontend/src/pages/TagCloud.tsx:121,139`, `frontend/src/pages/Settings.tsx`, `frontend/src/pages/Library.tsx` and `frontend/src/pages/Crates.tsx:198,314,358` (pass facets to chips; saved searches render there), `frontend/src/components/ProfileEditor.tsx` (Tags panel shows `tagDisplayName`)

**Interfaces:**
- Consumes: Shared Interfaces routes. Produces the TS names listed there; `FacetEditor` props `{facets: Facet[]; selected: ReadonlySet<number>; onToggle(facet, value, next: boolean): void; disabled?: boolean}` (single-value facets render `role="radiogroup"` with `role="radio"` chips and `aria-checked`; multi facets render `aria-pressed` buttons; label = `facet.label`); `parseQueryChips(query, facets?)`.

- [ ] **Step 1: Write the failing tests** (`facetUi.test.tsx`, bun):
  - `tagDisplayName({name:"purpose:χαλάρωση",category:"purpose"}) === "χαλάρωση"`; `({name:"my tag",category:null}) === "my tag"`; `({name:"a:b",category:"x"}) === "a:b"`.
  - `tagQuery` returns `purpose:"χαλάρωση"` for the facet tag, `voice:"φωνή χωρίς λόγια"` for a multi-word value, `"my tag"` (quoted) for a plain tag with a space and `ambient` for a plain single word.
  - `groupTags(tags, facets)`: first group `{key:"purpose", label:"Θεραπευτικός στόχος", facet:true}`, a non-facet category keeps its raw category as label, uncategorised last with label «Χωρίς κατηγορία».
  - `renderToString(<FacetEditor …/>)`: single facet has `role="radiogroup"`, selected chip `aria-checked="true"`; multi chips carry `aria-pressed`; the html contains the Greek labels and not the key `purpose`.
  - `parseQueryChips('purpose:"χαλάρωση" -mood:*', facets)` labels are `["Θεραπευτικός στόχος: χαλάρωση", "όχι Διάθεση: οποιαδήποτε τιμή"]`.
  - `apiMessage("409: μήνυμα") === "μήνυμα"` (exported from `facets.ts`).
  - Source contract: every `parseQueryChips(` call in `Library.tsx` and `Crates.tsx` passes a second argument.
- [ ] **Step 2: Run to verify FAIL.** `cd frontend && bun test tests/facetUi.test.tsx`.
- [ ] **Step 3: Implement.** `useFacets()` caches `api.listFacets()` and refetches on a `cratemind:facets-changed` window event dispatched by every vocabulary write. `TagCloud` loads facets with the tags, groups with `groupTags`, links with `/library?q=${encodeURIComponent(tagQuery(tag))}` and shows `tagDisplayName`. `VocabularySettings` (section «Λεξιλόγια», rendered in `Settings.tsx`): per facet an editable label, switch «Πολλαπλή επιλογή» (refusal shown as a toast with `apiMessage`), values with usage «{n} κομμάτια», «Μετονομασία», «Διαγραφή» (first call without `force`; the 409 message opens a confirm dialog, «Επιβεβαίωση» repeats with `force=true`), input «Νέα τιμή…» + «Προσθήκη τιμής», «Νέο λεξιλόγιο» (posts `{label, multi}` without a key; the server builds a readable slug, Task 5) and «Φόρτωση προτεινόμενου λεξιλογίου (μουσικοθεραπεία)». Add `valence` to `queryChips` `NUMERIC`.
- [ ] **Step 4: Run to verify PASS.** `bun test tests/facetUi.test.tsx tests/queryGrammar.test.ts && bun run build`.
- [ ] **Step 5: Commit.**
  ```bash
  git add frontend/src/lib/facets.ts frontend/src/lib/types.ts frontend/src/lib/api.ts frontend/src/lib/queryChips.ts frontend/src/components/FacetEditor.tsx frontend/src/components/VocabularySettings.tsx frontend/src/components/ProfileEditor.tsx frontend/src/pages/TagCloud.tsx frontend/src/pages/Settings.tsx frontend/src/pages/Library.tsx frontend/src/pages/Crates.tsx frontend/tests/facetUi.test.tsx
  git commit -m "Add the facet editor, vocabulary settings and Greek facet labels across tags"
  ```

---

### Task 11: Profile switch, route policy and first-launch chooser (A1)

**Files:**
- Create: `frontend/src/lib/profileCopy.ts`, `frontend/src/components/ProfileChooser.tsx`, `frontend/tests/profileRoutes.test.tsx` (`.tsx`: it renders JSX)
- Modify: `frontend/src/lib/prefs.ts`, `frontend/src/lib/capabilities.tsx:45`, `frontend/src/app/App.tsx:28-71`, `frontend/src/components/layout/Sidebar.tsx:314-315` (and group heading), `frontend/src/components/CommandPalette.tsx:26,49-52` (export `NAV`), `frontend/src/pages/Settings.tsx:462`, `frontend/src/pages/Artists.tsx:170-185`, `frontend/src/pages/Library.tsx:268`

**Interfaces:**
- Produces: `Prefs.libraryProfile: LibraryProfile` (default `"dj"`), `Prefs.profileChosen: boolean` (default `false`); `canAccessRoute(capabilities, path, profile: LibraryProfile = "dj")`; `filterRoutes<T extends {to: string}>(items: T[], capabilities, profile): T[]`; `visibleNavGroups<G extends {items: {to: string; subItems?: {to: string}[]}[]}>(groups: G[], capabilities, profile): G[]` (filters items and sub-items, drops empty groups; Sidebar calls it); `resolveProfilePrefs(stored: Partial<Prefs> | null) -> {libraryProfile, profileChosen}` (stored prefs that exist but lack `libraryProfile` mean an existing install: `{"dj", true}`, so the DJ never sees the chooser after upgrading); `THERAPY_HIDDEN_ROUTES = ["/flow","/key-harmony","/phrase-finder","/smart-folders"]`; `profileCopy.ts`: `libraryPlaceholder(profile)`, `quickPresets(profile)`, `toolsHeading(profile)`.

- [ ] **Step 1: Write the failing tests** (`profileRoutes.test.tsx`):
  - therapy: `canAccessRoute(caps, p, "therapy")` is false for the four hidden routes and any subpath, true for every other route in `NAV` plus `/settings`, `/tag`, `/tag-cloud`; identity routes stay capability-gated in both profiles; the two-argument call behaves as `"dj"` (existing `capabilities.test.ts` unchanged and green).
  - `filterRoutes(NAV, caps, "dj")` equals `NAV`; `filterRoutes(NAV, caps, "therapy")` drops exactly the two present in `NAV` (`/flow`, `/key-harmony`).
  - `visibleNavGroups` on synthetic groups: therapy drops `/flow` and `/key-harmony` items and a hidden sub-item, removes a group left empty, and keeps order; `"dj"` returns the groups unchanged.
  - `resolveProfilePrefs(null)` and `({})` are `{libraryProfile:"dj", profileChosen:false}` (fresh install shows the chooser); `({density:"compact"})` is `{"dj", true}` (existing install); `({libraryProfile:"therapy", profileChosen:true})` is unchanged.
  - Wiring only (Sidebar/App cannot be imported under bun): `Sidebar.tsx` calls `visibleNavGroups(`, `App.tsx` and `CommandPalette.tsx` call `canAccessRoute(`/`filterRoutes(` with a profile argument.
  - Copy: `libraryPlaceholder("therapy") === "Αναζήτηση τίτλου, καλλιτέχνη ή σκοπού — π.χ. χαλάρωση Χατζιδάκις"`; `quickPresets("therapy")` is `[{q:"approved",label:"Εγκεκριμένα"},{q:"untagged",label:"Αταξινόμητα"},{q:"never_played",label:"Δεν παίχτηκαν ακόμη"},{q:"not_recent:30",label:"Χωρίς play 30η"}]`, none containing `weapons` or `role:bridge`; `quickPresets("dj")` is the current four.
  - `renderToString(<ProfileChooser />)` contains «Πώς θα χρησιμοποιήσεις το CrateMind;» (informal, like the rest of the app), «DJ» and «Μουσικοθεραπεία».
- [ ] **Step 2: Run to verify FAIL.** `cd frontend && bun test tests/profileRoutes.test.tsx`.
- [ ] **Step 3: Implement.** `App.tsx`: `const [profile] = usePref("libraryProfile")`; key **only** `<Sidebar>`, `<CommandPalette>` and the routed subtree (`PageTransition`/`Routes`) with the profile. Never key `CapabilitiesProvider`, `AppShell` or anything that contains `DeckDock`/`MiniPlayer`: MiniPlayer owns the `<audio>` element (`MiniPlayer.tsx:693`) and unloads it on unmount (`:240`), so a switch must not stop playback; MiniPlayer shows no axis labels and reads the profile per keypress. Prefs hydration applies `resolveProfilePrefs` to the stored snapshot. Show `ProfileChooser` instead of the routes while `!profileChosen` (choosing sets both prefs); blocked route renders «Αυτή η σελίδα δεν είναι διαθέσιμη σε αυτό το προφίλ ή σε αυτή την εγκατάσταση.» with a «Άνοιγμα βιβλιοθήκης» link to `/library`. Sidebar and CommandPalette filter their lists (and Sidebar sub-items) with `filterRoutes`; heading «Εργαλεία DJ» becomes «Εργαλεία» in therapy. Settings: «Προφίλ χρήσης» select («DJ» / «Μουσικοθεραπεία»), `DjayBeatgridCard` rendered only for `"dj"`. Artists: in therapy hide «Έρευνα ειδών» and the Luna caption and pass `disabled` to result cards. Library placeholder and CommandPalette presets come from `profileCopy`.
- [ ] **Step 4: Run to verify PASS.** `bun test tests && bun run build`.
- [ ] **Step 5: Commit.**
  ```bash
  git add frontend/src/lib/prefs.ts frontend/src/lib/capabilities.tsx frontend/src/lib/profileCopy.ts frontend/src/components/ProfileChooser.tsx frontend/src/app/App.tsx frontend/src/components/layout/Sidebar.tsx frontend/src/components/CommandPalette.tsx frontend/src/pages/Settings.tsx frontend/src/pages/Artists.tsx frontend/src/pages/Library.tsx frontend/tests/profileRoutes.test.tsx
  git commit -m "Add the DJ/therapy profile switch with route policy and a first-launch chooser"
  ```

---

### Task 12: Arousal/valence labels, profile-aware keys, columns and the one MiniPlayer guard (A1)

**Files:**
- Create: `frontend/tests/therapyLabels.test.ts`
- Modify: `frontend/src/lib/{labels,tagKeys,tablePreferences,useTablePreferences,trackSort,types}.ts`, `frontend/src/components/TrackTable.tsx`, `frontend/src/components/{ShortcutsDialog,SetTimeline,RecommendationCard}.tsx`, `frontend/src/components/MiniPlayer.tsx:605`, `frontend/src/pages/TaggingQueue.tsx` (SHORTCUTS :110-113 and key handler), `frontend/tests/tagKeys.test.ts`, `frontend/tests/tablePreferences.test.ts`

**Interfaces:**
- Produces: `axisLabel(axis: "energy"|"darkness"|"valence", profile = getPref("libraryProfile"))` (DJ «Ενέργεια»/«Σκοτεινότητα»/«Σθένος»; therapy «Διέγερση»/«Σκοτεινότητα»/«Συναισθηματικό σθένος»); `statusLabel` therapy map `unknown «Αταξινόμητο», testing «Υπό δοκιμή», approved «Εγκεκριμένο», retired «Αποσυρμένο», avoid «Αποφυγή»`, `weapon` shown as «Εγκεκριμένο»; `statusValues(profile?)` (therapy omits `weapon`); `fieldLabel` lower-cases the axis label; `tagKeyAction(key, shiftKey, profile?)`, `tagBankAction(pad, profile?)`, `statusBankAction(pad, profile?)`, `isCueJumpKey(key, shiftKey, playbackOwned, profile?)`, `cuePadKeysEnabled(profile?)`, `digitFromEvent(e: {key: string; code?: string}) -> string | null` (`Digit0-9`/`Numpad0-9` from `e.code`, else `e.key` when it is a digit; with Shift held, `e.key` is `"#"` on US and Greek layouts, so today's Shift+digit never reaches `tagKeyAction`), `queueShortcuts(profile?)` (same shape as today's `SHORTCUTS`); `readTablePreferences(raw, legacyRaw, profile?)`, `createTablePreferenceStore(storage, profile = () => "dj")` — column visibility is stored per profile (`visibility: {dj: {...}, therapy: {...}}`); a legacy flat `visibility` migrates to `dj`; `migrate()` writes only the active profile's map; therapy starts from its own defaults; `Track.valence`, `Profile.valence`, `SortKey "valence"`. `profile?` always defaults to `getPref("libraryProfile")`.

- [ ] **Step 1: Write the failing tests.**
  - `tagKeys.test.ts` (therapy): `tagKeyAction("3", false, "therapy")` is `{patch:{energy:3}, label:"διέγερση 3", optimistic:false}`; `("3", true, "therapy")` is `{patch:{valence:3}, label:"συναισθηματικό σθένος 3", optimistic:false}`; `"0"` -> 10; `b`,`p`,`r`,`w` are `null`; `a`,`x`,`m` unchanged; `tagBankAction(8, "therapy")?.patch` is `{valence:1}`; `statusBankAction(3, "therapy")` (b) is `null`; `isCueJumpKey("3", false, true, "therapy") === false` and `("3", false, true, "dj") === true`; `cuePadKeysEnabled("therapy") === false`, `("dj") === true`. A DJ-profile run of the existing assertions stays green.
  - `digitFromEvent({key:"#", code:"Digit3"}) === "3"`; `({key:"3", code:"Numpad3"}) === "3"`; `({key:"3"}) === "3"`; `({key:"γ", code:"KeyG"}) === null`.
  - `queueShortcuts("therapy")`: no «Ρόλος» section, no row mentioning «cue pads», Βαθμολογία rows labelled «διέγερση 1–10» and «συναισθηματικό σθένος 1–10», Κατάσταση rows only `A` and `X`; `queueShortcuts("dj")` equals today's table.
  - `therapyLabels.test.ts`: `axisLabel` values above; `statusLabel("approved")` per profile; `statusValues("therapy")` is `["unknown","testing","approved","retired","avoid"]`; `fieldLabel("energy")` is `"διέγερση"` in therapy.
  - `tablePreferences.test.ts`: DJ hidden-by-default list becomes `["valence","genre","last","created"]` (column order in `LIBRARY_COLUMNS`, valence placed after darkness; update the existing assertion deliberately); legacy stored prefs with darkness visible and valence hidden: the therapy snapshot hides `darkness` and shows `valence`, the DJ snapshot keeps the stored visibility, toggling a column in therapy leaves DJ unchanged, and `migrate()` called under therapy does not rewrite the DJ map; widths object still has one key per column.
  - Source contract: `MiniPlayer.tsx` contains the exact line `if (padIndex !== null && !e.shiftKey && cuePadKeysEnabled()) {` and imports `cuePadKeysEnabled`; `ShortcutsDialog.tsx` builds its tagging rows from `queueShortcuts(`.
- [ ] **Step 2: Run to verify FAIL.** `cd frontend && bun test tests/tagKeys.test.ts tests/therapyLabels.test.ts tests/tablePreferences.test.ts`.
- [ ] **Step 3: Implement.** MiniPlayer's change is exactly this condition at `:605` plus its import: `if (padIndex !== null && !e.shiftKey && cuePadKeysEnabled())` — with the guard false the event falls through unhandled (no `stopPropagation`), so `TaggingQueue`'s window listener sees the digit; no other MiniPlayer edits. `TaggingQueue`'s handler passes `digitFromEvent(e) ?? e.key` to both `isCueJumpKey` and `tagKeyAction` (this also fixes Shift+digit darkness from the keyboard in DJ). The `LIBRARY_COLUMNS` valence entry is `{id:"valence", label:"Συναισθηματικό σθένος", width:136, minWidth:96, sortKey:"valence"}`; default visibility is a function of `(column, profile)` and applies until the user toggles a column in that profile. `TrackTable` header text goes through `axisLabel` for energy/darkness/valence ids and `MetricValue` accepts `"valence"` (gradient blue->chartreuse). `SetTimeline:220` and `RecommendationCard:61` use `axisLabel("energy")`; `ShortcutsDialog` renders its whole tagging block from `queueShortcuts()` (no darkness, role or weapon rows in therapy); TaggingQueue uses `queueShortcuts()`.
- [ ] **Step 4: Run to verify PASS.** `bun test tests && bun run build`.
- [ ] **Step 5: Commit.**
  ```bash
  git add frontend/src/lib/labels.ts frontend/src/lib/tagKeys.ts frontend/src/lib/tablePreferences.ts frontend/src/lib/useTablePreferences.ts frontend/src/lib/trackSort.ts frontend/src/lib/types.ts frontend/src/components/TrackTable.tsx frontend/src/components/ShortcutsDialog.tsx frontend/src/components/SetTimeline.tsx frontend/src/components/RecommendationCard.tsx frontend/src/components/MiniPlayer.tsx frontend/src/pages/TaggingQueue.tsx frontend/tests/tagKeys.test.ts frontend/tests/therapyLabels.test.ts frontend/tests/tablePreferences.test.ts
  git commit -m "Relabel energy as arousal, add valence, and make keys and columns profile-aware"
  ```

---

### Task 13: Therapy editors: arousal, valence and vocabularies (A1)

**Files:**
- Create: `frontend/src/lib/profileFields.ts`
- Modify: `frontend/src/components/ProfileEditor.tsx` (NUM_FIELDS :47, status chips :283, transition panel :383-418, Tags :472), `frontend/src/pages/TaggingQueue.tsx` (ACTIONS :150, rating panels :622-685, transition panel :691-700, tags :702-709), `frontend/tests/therapyLabels.test.ts` (append)

**Interfaces:**
- Consumes: Tasks 10, 12 (`FacetEditor`, `useFacets`, `api.batchEdit`, `axisLabel`, `statusValues`).
- Produces: `numFields(profile?) -> {key: keyof Profile; label: string; max: number}[]` — DJ: the current eight in the current order; therapy: `energy` (label «Διέγερση»), `valence` («Συναισθηματικό σθένος»), then intensity, melody, weirdness, chaos_level, mixability, confidence (no `darkness`).

- [ ] **Step 1: Write the failing tests** (append to `therapyLabels.test.ts`): `numFields("dj").map(f => f.key)` equals `["energy","intensity","darkness","melody","weirdness","chaos_level","mixability","confidence"]`; `numFields("therapy").map(f => f.key)` equals `["energy","valence","intensity","melody","weirdness","chaos_level","mixability","confidence"]` with labels[0] «Διέγερση» and labels[1] «Συναισθηματικό σθένος»; every `max` is 10 except `mixability`/`confidence` (5).
- [ ] **Step 2: Run to verify FAIL.** `cd frontend && bun test tests/therapyLabels.test.ts`.
- [ ] **Step 3: Implement.** `ProfileEditor` and `TaggingQueue` read `numFields()` instead of the exported `NUM_FIELDS` constant. In therapy both hide psy substyle, set role, breakdown, tolerance, the cut/dramatic switches and the darkness panel; the Κατάσταση chips/select use `statusValues()` and `statusLabel`; TaggingQueue's action grid keeps Δοκιμή, Εγκεκριμένο, Απόφυγε (labels via `statusLabel`) and drops Όπλο, the roles, Δραματικό and Μεγάλο blend; the valence panel uses `Segmented tone="cyan"`. Both add a «Λεξιλόγια» panel with `<FacetEditor facets={facets} selected={new Set(trackTags.map(t => t.id))} onToggle=…/>`; a toggle calls `api.batchEdit({track_ids:[id], add_tag_ids:[value.id]})` or `remove_tag_ids`, then re-reads `api.getTrack(id)` (stale-track guard as in TaggingQueue today). The plain Tags panel lists only non-facet tags, rendered with `tagDisplayName`. DJ profile output is unchanged.
- [ ] **Step 4: Run to verify PASS.** `bun test tests && bun run build`; then manual check in `bun run dev` with a throwaway dataset: switch to «Μουσικοθεραπεία», tag a track in `/tag`, confirm no DJ-only control shows.
- [ ] **Step 5: Commit.**
  ```bash
  git add frontend/src/lib/profileFields.ts frontend/src/components/ProfileEditor.tsx frontend/src/pages/TaggingQueue.tsx frontend/tests/therapyLabels.test.ts
  git commit -m "Show arousal, valence and vocabularies in the therapy editors"
  ```

---

### Task 14: Multi-select and bulk tagging in the Library (A5)

**Files:**
- Create: `frontend/src/lib/selection.ts`, `frontend/src/components/BulkTagBar.tsx`, `frontend/tests/bulkSelection.test.tsx`
- Modify: `frontend/src/components/TrackTable.tsx`, `frontend/src/pages/Library.tsx`

**Interfaces:**
- Consumes: `api.batchEdit`, `api.trackCount`, `FacetEditor`, `useFacets` (Task 10), `axisLabel`.
- Produces: `rangeSelect(ids: readonly number[], selected: ReadonlySet<number>, anchor: number | null, index: number, shift: boolean) -> {selected: Set<number>; anchor: number}` (no shift toggles `ids[index]`; shift sets every row between `anchor` and `index` to `!selected.has(ids[index])`); `buildBatchRequest({scope: "selected"|"all", selectedIds, query, mode: "add"|"remove", tagIds, profile, dryRun}) -> BatchEditRequest` (selected scope sends `track_ids`, all scope sends `query`, never both); `confirmText({matched, replaced}) -> string`; `withDryRun(req: BatchEditRequest, dryRun: boolean) -> BatchEditRequest`; `TrackTable` optional props `selectedIds?: ReadonlySet<number>`, `onSelectionChange?: (ids: Set<number>) => void`.

- [ ] **Step 1: Write the failing tests.** `rangeSelect([10,11,12,13,14], new Set(), null, 1, false)` -> `{selected:{11}, anchor:1}`; then `rangeSelect(…, anchor 1, index 3, shift)` -> `{11,12,13}`; shifting back onto a selected end unselects the range. `buildBatchRequest` for `selected` with ids `{3,1}` has `track_ids` `[1,3]` and no `query`; for `all` has `query "ambient"` and no `track_ids`; `dryRun` is carried; `mode "remove"` fills `remove_tag_ids`. `confirmText({matched:120, replaced:7}) === "Θα αλλάξουν 120 κομμάτια. Θα αντικατασταθούν 7 τιμές μονής επιλογής."` and with `replaced: 0` only the first sentence. `withDryRun(req, false)` keeps every other field (`track_ids`, `query`, tag ids, profile) identical and sets `dry_run:false`. SSR `TrackTable` (reuse the virtualizer stub of `trackTable.test.tsx:23` so rows render) with `selectedIds={new Set([1])}` and `onSelectionChange`: two checkboxes with `aria-label="Επιλογή κομματιού"`, the first row's `checked`, first grid column `32px`; without the props the html has no checkbox and the existing `trackTable.test.tsx` grid assertions still pass.
- [ ] **Step 2: Run to verify FAIL.** `cd frontend && bun test tests/bulkSelection.test.tsx`.
- [ ] **Step 3: Implement.** `TrackTable` full variant: when `onSelectionChange` is given prepend a 32px `select` column (header and rows move together in `FULL_COLS`), checkbox `onClick` calls `rangeSelect` with `event.shiftKey` and stops propagation (row click still selects the track for the inspector). `Library`: `selectedIds` state reset in the effect that already reacts to `params`; render `BulkTagBar` above the table with scopes «Επιλεγμένα (N)» (disabled at 0) and «Όλα τα αποτελέσματα (N)» (N from `api.trackCount(applied)`, where `applied = params.get("q") ?? ""` is the submitted query that drives the shown rows, never the draft input text at `Library.tsx:57`), a segmented «Προσθήκη τιμών» / «Αφαίρεση τιμών», a `FacetEditor` for the pending values, optional axis setters (arousal plus valence in therapy, energy plus darkness in DJ) and «Εφαρμογή». «Εφαρμογή» snapshots the request built from `applied`, calls `batchEdit` with it (`dry_run: true`), opens a dialog «Επιβεβαίωση μαζικής αλλαγής» showing `confirmText`, and only «Επιβεβαίωση» sends `withDryRun(snapshot, false)`, the exact request that was previewed (success toast «Ενημερώθηκαν {updated} κομμάτια», then reload and clear the selection); every button is disabled while a request is in flight (blocks double submission).
- [ ] **Step 4: Run to verify PASS.** `bun test tests && bun run build`; manual: bulk add via «Όλα τα αποτελέσματα» on a throwaway dataset and confirm the dialog count matches `GET /api/tracks/count`.
- [ ] **Step 5: Commit.**
  ```bash
  git add frontend/src/lib/selection.ts frontend/src/components/BulkTagBar.tsx frontend/src/components/TrackTable.tsx frontend/src/pages/Library.tsx frontend/tests/bulkSelection.test.tsx
  git commit -m "Add multi-select and confirmed bulk tagging to the Library"
  ```

---

### Task 15: Paged triage queue with vocabulary-built filters and folder picker (A6)

**Files:**
- Create: `frontend/src/lib/queuePaging.ts`, `frontend/tests/queuePaging.test.ts`, `backend/tests/test_triage_routes.py`
- Modify: `backend/app/services/search.py` (`QUEUE_ORDER`, `after`), `backend/app/api/tracks.py` (`list_tracks` :161-171, new `GET /tracks/folders` declared next to `/count`, before `/{track_id}`), `scripts/desktop/check_parity_inventory.py`, `frontend/src/lib/api.ts`, `frontend/src/pages/TaggingQueue.tsx` (FILTERS :72, `load` :241)

**Interfaces:**
- Produces: `QUEUE_PAGE = 500`; `queueFilters(facets, profile?) -> {label, q}[]`; `queueQuery(filterQ, folder) -> string`; `appendPage(loaded: Track[], page: Track[]) -> Track[]` (order kept, ids deduped); `hasMorePages(page: Track[], pageSize = QUEUE_PAGE) -> boolean` (a short page means the queue is exhausted); `progressLine(done, total) -> string`. Backend: `search.QUEUE_ORDER = (coalesce(artist,''), coalesce(title,''), id)` used by `search.search()` and the no-`q` branch of `list_tracks`; `search.search(session, q, limit, offset, after: tuple[str, str, int] | None = None)`; `list_tracks(..., after: int | None = None)`.

- [ ] **Step 1: Write the failing tests.**
  - `test_triage_routes.py`: `test_list_tracks_limit_zero_returns_everything` (3 tracks, no `q`: `GET /api/tracks?limit=0` returns 3; also with `q=untagged`); `test_folders_route_groups_normalised_parents`: tracks `C:\Music\A\1.mp3`, `C:\Music\A\2.mp3`, `/home/u/B/3.mp3` -> `[{"path":"/home/u/B","count":1},{"path":"C:/Music/A","count":2}]`, status 200 (not captured by `/{track_id}`); `test_keyset_traversal_stable`: 1,234 tracks, about a tenth with `artist` NULL and several duplicate (artist, title) pairs, walked in pages of 500 with `after=<last id>`: the concatenated ids equal one `limit=0` listing, with no duplicates, and the last page is short; `test_keyset_traversal_shrinking`: preset seeded, queue `-purpose:*`, load page 1, then tag away 100 tracks of page 1 and 50 not yet loaded, then continue from page 1's last id: the remaining pages hold exactly the still-untagged tracks after the cursor, in order, none skipped; `test_keyset_unknown_cursor`: `after=999999` is 404 «Το σημείο συνέχειας δεν βρέθηκε. Φόρτωσε ξανά την ουρά.».
  - `queuePaging.test.ts`: `queueFilters([purpose, mood], "therapy")` is `Όλα`, `Χωρίς tags`, `Υπό δοκιμή` (`testing`), `Για έλεγχο` (`status:unknown`), `Χωρίς Θεραπευτικός στόχος` (`-purpose:*`), `Χωρίς Διάθεση` (`-mood:*`); the `"dj"` list additionally has `Υποψήφιες γέφυρες` (`role:bridge`) and `Μεγάλο blend` (`tolerance:huge`) and labels `Δοκιμή`; `queueQuery("-purpose:*", "C:/Music/A") === '-purpose:* folder:"C:/Music/A/"'`, `queueQuery("", "") === ""`; `appendPage` of ids [1,2,3] and [3,4] is [1,2,3,4]; `hasMorePages` is true for a full page of 500 and false for 499; `progressLine(1240, 6800) === "Ταξινομημένα 1.240 / 6.800"`.
- [ ] **Step 2: Run to verify FAIL.** `cd backend && uv run pytest tests/test_triage_routes.py -v`; `cd frontend && bun test tests/queuePaging.test.ts`.
- [ ] **Step 3: Implement.** `list_tracks`: apply `.limit(limit)` only when `limit > 0` on the no-`q` branch; both branches order by `QUEUE_ORDER`; with `after`, look up that track's `(coalesce(artist,''), coalesce(title,''))` (404 above if it is gone) and add `tuple_(*QUEUE_ORDER) > tuple_(a, t, after)` (SQLite row values; the cursor is a position, so it works even if that track no longer matches the query). `GET /tracks/folders`: group `Track.absolute_path` by `rsplit("/", 1)[0]` after `\` -> `/`, return `[{"path", "count"}]` sorted by `path`; add `FOLLOWUP_ROUTES` entry (GET, owner `triage`, oracle `backend/tests/test_triage_routes.py::test_folders_route_groups_normalised_parents`). `listTracks(q, limit, offset, after)` gains the `offset` and `after` query params; `listFolders()` added. `TaggingQueue`: first page `listTracks(queueQuery(q, folder), QUEUE_PAGE)`; when `idx >= tracks.length - 25`, `hasMorePages(lastPage)` and no page request is in flight (one `useRef` guard), fetch `listTracks(query, QUEUE_PAGE, 0, tracks.at(-1).id)` and `appendPage`; no 10,000 cap, and every request is at most 500 rows. A 404 cursor reloads the queue from the start with that toast. Shuffle mode loads every page first (loop until a short page) and then shuffles the whole queue once, so the DJ's whole-queue shuffle is unchanged (about 10 requests at 5,000 tracks). Filters come from `queueFilters(facets)`; a «Από φάκελο…» select (first option «Όλοι οι φάκελοι») lists `listFolders()` as `path (count)`. Progress line `progressLine(total − remaining, total)` is shown for `untagged` and `-key:*` queues (`total` = `trackCount(queueQuery("", folder))`, the folder-scoped library, not the whole library; `remaining` = `trackCount(queueQuery(q, folder))`). In therapy with zero facets the empty state reads «Δεν υπάρχει λεξιλόγιο ακόμη. Φόρτωσε το προτεινόμενο λεξιλόγιο μουσικοθεραπείας για να ξεκινήσεις.» with button «Φόρτωση προτεινόμενου λεξιλογίου» calling `api.loadFacetPreset("therapy")`.
- [ ] **Step 4: Run to verify PASS.** `uv run pytest tests/test_triage_routes.py tests/test_desktop_contract_inventory.py -q`, parity `--runtime web` and `--runtime desktop-core`, `bun test tests && bun run build`.
- [ ] **Step 5: Commit.**
  ```bash
  git add backend/app/services/search.py backend/app/api/tracks.py backend/tests/test_triage_routes.py scripts/desktop/check_parity_inventory.py frontend/src/lib/queuePaging.ts frontend/src/lib/api.ts frontend/src/pages/TaggingQueue.tsx frontend/tests/queuePaging.test.ts
  git commit -m "Page the tagging queue and build triage filters and a folder picker from vocabularies"
  ```

---

### Task 16: Desktop verification for Phase A

**Files:** none expected; commit only regenerated tracked artifacts if a check reports drift.

- [ ] **Step 1: Full suites.** `cd backend && uv run pytest` and `cd frontend && bun test tests && bun run build`. Expected: all PASS.
- [ ] **Step 2: Contract and parity.** `backend/.venv/bin/python scripts/desktop/generate_schema_contract.py --check` ("Schema contract current"); `backend/.venv/bin/python scripts/desktop/check_parity_inventory.py --runtime web` and `--runtime desktop-core` (exit 0, new routes under `followup_present`).
- [ ] **Step 3: Desktop build and frozen-import check** (per `docs/TAURI_DESKTOP_OPERATIONS.md`): `cd backend && UV_PROJECT_ENVIRONMENT=.venv-desktop uv sync --locked --python 3.13.18 --no-default-groups --group desktop`; `cd ../frontend && bun install --frozen-lockfile && bun run build:desktop`; `cd .. && python3 scripts/desktop/build_backend.py --self-test`. Expected: JSON with `"forbidden_imports": []` and no `json_each`/fold failure.
- [ ] **Step 4: Migration timing.** Run `CM_FTS_BENCH_TRACKS=50000 uv run pytest tests/test_fts_migration.py::test_rebuild_timing -s` on this machine; the figure goes in the report and must be re-measured on Windows (budget 300 s).
- [ ] **Step 5: Commit** only drift fixes: `git add backend/app/schema_contract.json` + `git commit -m "Refresh the schema contract for Phase A"` (skip if clean). Version bump (0.2.1 → 0.3.0), tag and installer are not part of this plan (`scripts/version.py set`, tag only with the user's OK).

**Manual Windows offline smoke (for the user, installed build, network off):**
- [ ] First launch chooser appears; picking «Μουσικοθεραπεία» hides Flow, Key & Harmony, Phrase Finder and Έξυπνοι φάκελοι, and relabels «Διέγερση» / «Συναισθηματικό σθένος».
- [ ] Settings > Λεξιλόγια > «Φόρτωση προτεινόμενου λεξιλογίου» creates 8 vocabularies; load the preset twice (second adds nothing).
- [ ] Bulk via query: search a word, choose «Όλα τα αποτελέσματα», add a «Θεραπευτικός στόχος» value, check the confirmation count equals the Library count, apply.
- [ ] Accentless search: «χαλαρωση» finds «Χαλάρωση»; «μανος χατζιδακις» finds «Μάνος Χατζιδάκις»; a partial word finds tracks.
- [ ] Tagging while a track plays on a deck: digits set Διέγερση, Shift+digit sets σθένος, no cue jump; in DJ profile digits 1-8 still jump to cues.
- [ ] First-launch migration time on her real library copy (read the stderr phase line `fts_rebuild=`), and that the pre-upgrade backup bundle exists.
- [ ] Before shipping A: show her the preset and the triage flow on a copy of a slice of her library (spec "Real use"); everything stays editable.

---

## Self-Review

**Spec coverage.** A0 fold/grammar/prefix/limit/migration/track_search check -> Tasks 1, 2, 3. A1 pref, route policy (App, Sidebar, CommandPalette), therapy copy, labels, columns, editors, keys, MiniPlayer guard -> Tasks 11, 12, 13. A2 table, services, bypass guards, rename/delete, routes, parity, bulk, backup/exchange/CSV -> Tasks 4, 5, 7, 8, 9. A3 valence, facet tokens, `*`, folder, README -> Tasks 4, 6. A4 FacetEditor, Λεξιλόγια, `tagDisplayName`, TagCloud -> Task 10. A5 -> Task 14. A6 (facet-built filters, folder list route, paging, LIMIT 0 fix, progress) -> Task 15. Verification items: grammar fixture (1), limit 100 (2, 7, 8), migration/backup/timing (3), folding and token cases (2, 6), facets rules (5, 7), bulk (8), backup/CSV (9), data safety (8), frontend route policy (11), Digit3 (12), TagCloud (10), tagKeys (12), desktop (16). Risks (reindex time, MiniPlayer single guard) -> Tasks 3, 12, 16.

**Step scan.** Every step names files, signatures or exact assertions; bodies appear only for `fold_text`, the shared regex/serializer, `ids_in`/`fts`, the FTS migration sequence and its placement, facet-token resolution; the single-value replace rule is specified by `TagDiff` tests rather than a body.

**Type consistency.** Names match the Shared Interfaces block throughout: `ids_in`, `FacetError`, `TagDiff`, `plan_tag_changes`/`apply_tag_changes`, `batchEdit`/`BatchEditRequest`, `useFacets`, `tagQuery`, `numFields`, `queueFilters`. `migrate_fts_index` and `FTS_INDEX_VERSION` are used only in Task 3 and the Task 16 timing step.

**Review Focus.** All five lines have a named owning test (Tasks 2, 3/4, 8, 6/15, 5).

**Proportion.** About 1.0k lines for 315 spec lines, mostly test assertions and pinned Greek copy; algorithm bodies are limited to the five the brief names.

**Deviations from the spec text, flagged for the user.** (1) `parseQueryChips` gets an optional `facets` argument in Task 10 so Greek facet labels (spec B1) appear in A and no internal key is ever shown. (2) Task 2 also routes `local_search_ids` (collections/remote tokens) through `ids_in`: it binds one variable per track and the spec's global constraint forbids that. (3) The JSON import (`legacy_import`, the only JSON import and desktop-only) restores facets and their links **through the facets service** instead of skipping them as the spec text says; skipping would lose her assignments on a JSON restore, while the service keeps the single-value rule the spec's skip was protecting (Task 7). (4) Spec line citations `api/tracks.py:522` (`_apply_profile`) and `operations.py:446` (`_change_summary`) are at `:512` and `:443` in ff076f6. (5) "Pages of 500" is implemented as keyset paging on `(artist, title, id)`; shuffle loads every page first so the DJ's whole-queue shuffle is unchanged (Task 15). (6) `digitFromEvent` also fixes Shift+digit darkness from the keyboard in the DJ profile, which is broken today (Task 12). (7) The chooser copy is informal («Πώς θα χρησιμοποιήσεις»), matching the app's register (about 55 informal imperatives against 8 formal ones). (8) Facet keys for new vocabularies are readable slugs built by the server from the Greek label (Task 5), because keys appear in the search box through TagCloud links. (9) Library column visibility is stored per profile (Task 12).

## Plan review (2-pass)

- **Pass 1: `plan-reviewer` run by the OMC critic, Opus 5.5, effort high.** Verdict REVISE: 1 blocker, 7 should-fix items, 8 suggestions. It probed the grammar fixture, `fold_text`, `ids_in` under a 100-variable limit and the startup ordering, and all of those held. **All applied:**
  - **Blocker:** Shift+digit arrives as `"#"`, so valence was unreachable from the keyboard; fixed with `digitFromEvent`.
  - **Should-fix:** the migration fired 2 commits; the MiniPlayer regex pointed at the wrong line; a profile switch stopped playback; queue paging stalled at 10,000 and re-read up to 105k rows; column visibility ignored profile defaults; Crates chips leaked keys; the JSON import dropped facet assignments; bulk audit ownership and the empty-query scope were ambiguous.
  - **Suggestions:** reject the value `*`; readable keys; existing installs skip the chooser; an explicit whitespace class; a lazy import to avoid a cycle; correct singular/plural in Greek counts; a pure `visibleNavGroups` test; a self-test test that fails first.
- **Pass 2: Codex gpt-6.1-sol, `model_reasoning_effort=xhigh`, read-only, its own plan-reviewer.** Verdict not ready: 5 blockers, 9 should-fix items, 2 suggestions. **All applied:**
  - **Blockers:** the two FTS `:q` binds collided; the migration committed twice; preset adoption bypassed the single-value rule; paging could not traverse a shrinking queue; two tests could not turn green (JSX in `.ts`, the MiniPlayer line).
  - **Should-fix:**
    - the self-test needs a subprocess; the benchmark variable was wiped by `conftest`;
    - delete must not rewrite saved searches, and fields must be compared case-insensitively;
    - tag-route guard ordering and service removal;
    - bulk transaction ownership and failure tests; bulk must use the applied query;
    - playback preserved across the remount; the shortcuts dialog follows the profile; CSV column order and repeated labels.
  - **Suggestions:** the virtualizer stub for SSR rows; no raw keys in error messages.
- **Also applied, from my own read:**
  - Exclusion terms are folded, so `-χαλάρωση` excludes.
  - Restores and exchange imports activate only at startup, where the migration runs, so no extra call is needed.
- **Context since the first draft:** you said her library is about 5,000 tracks and that she tags while listening. That makes the Task 12 key fix essential and the variable-cap work preventive. Release 0.2.1 landed (`4dd3ba9`, a version-only change), so Phase A ships as 0.3.0.
