# CrateMind for music therapy: purpose-first library management

## Context

A friend who practises music therapy as a science (sound/frequency therapy later) has collected music since childhood. It sits in countless lists, local files and online playlists, saved "so as not to lose them" and never sorted. Her words: *I have it, I searched for it, I saved it, and when I need it in the moment I can't find it.*

The problem is **retrieval by purpose**, not storage. CrateMind already scans, searches, tags, sequences and exports, but every axis is DJ-shaped: energy/darkness/set role/psy substyle/"weapon". This plan generalises the library-management core so a therapist can:
1. tag by *therapeutic purpose* in her own vocabulary, fast and in bulk;
2. find the right track in seconds during a session;
3. sequence sessions by the **iso principle**: meet the client's current state, then move gradually toward a target state.

**Decisions taken with the user (2026-11-02)**
- She runs the **Windows desktop build** herself. Phases A–C must work in the desktop sidecar: no SciPy/librosa (NumPy is fine), no network calls.
- **Profile switch**: a DJ / «Μουσικοθεραπεία» setting. Therapy mode hides DJ-only features and relabels the shared axes. One codebase, one installer.
- **No session/client data** is stored. Session plans are playlists, not records about people.
- Music is a **mix of local files and online lists** (Spotify, YouTube, unknown others). Ship **local first** (A → B → C); streaming-list import (D) is the next release.

## Approach in one paragraph

Turn the barely used `Tag.category` into first-class **facets**: named vocabularies such as «Θεραπευτικός στόχος», each value an ordinary `Tag` row. FTS, tag backup and the tag cloud then apply to facet values; facet definitions are added to backup and facet columns to CSV explicitly. Use **arousal × valence** (Russell's circumplex, the standard model in music-emotion research) as the numeric axes. Arousal reuses `energy` (relabelled «Διέγερση»); valence is one new 1–10 column. Tempo stays BPM.

Search gets two foundations first:
- **Accent-insensitive:** today «χαλαρωση» finds nothing (probed by all three reviews).
- **Safe at any library size:** today a library over 32,766 tracks breaks the queue (SQLite's bound-variable cap).

---

## Phase A: vocabulary, profile switch, bulk tagging (first Windows release)

**Build order:** A0 → A2/A3 → A4 → A1 → A5 → A6. The A1 editors need facets and valence.

**A0. Search foundations** (prerequisite; the DJ profile benefits too)
- **Accent folding:** add `fold_text(s)`: NFKD, then drop combining marks, then `casefold()`, which also folds final ς.
  - It is a dedicated helper. `soundcloud.normalize_match_text` is not reused because it strips identity noise that FTS must keep.
  - **Index side:** every column in `reindex_track` (`db.py:269`). Facet tags contribute only their value part.
  - **Query side:**
    - free-text terms in `_apply_free_text` (`search.py:226-248`);
    - string fields in `_compile_str` (`search.py:163`). These use `ilike` today, which folds ASCII only, so `artist:μάνος` misses «Μάνος». They switch to a `cratemind_fold` SQL function registered next to `cratemind_key` (`db.py:35`).
  - Free-text terms become prefix matches (`"term"*`) so partial typing finds tracks. Exclusions stay exact.
- **One query grammar:**
  - Replace `shlex.split` and its whitespace fallback (`search.py:254-257`). Greek elision («Σ' αγαπώ») makes shlex fail, and the fallback then splits quoted values.
  - New tokenizer: `-?field:"…"`, `-?"…"`, or a bare run of non-space characters. Only double quotes quote; apostrophes are literal.
  - The same grammar replaces the regex in `lib/queryChips.ts:27`. A shared JSON fixture of query → tokens runs in both `pytest` and `bun test`.
  - One serializer, in backend and frontend, writes tokens back. It is used by B1 chip edits and the saved-search rewrite.
- **Large libraries:** SQLite allows at most 32,766 bound variables. Three paths bind one per track:
  - `_list_payload` (`api/tracks.py:113-118`);
  - the free-text include and exclude lists (`search.py:235`, `:246`).
  - Each is replaced by a single `json_each(:ids)` parameter or a subquery. The test uses `sqlite3.Connection.setlimit(SQLITE_LIMIT_VARIABLE_NUMBER, 100)`.
- **Migrating existing libraries:**
  - Record the folded-index version in `PRAGMA user_version`, which is unused today.
  - When that version is behind, rebuild FTS in **one transaction**. Today `reindex_all` (`db.py:317`) commits once per track.
  - Run the rebuild **after** `backup_on_launch()` in both startup branches. In non-dataset web mode the backup runs after `init_db` (`app_factory.py:74-75`).
  - Bump `STARTUP_MIGRATION_REVISION` (`db.py:158`) so dataset mode takes its pre-upgrade backup.
  - Time the rebuild in `launch_phase`. The desktop gives the backend 300 s to start (`native/src-tauri/src/lib.rs:256`).
- Confirm that nothing displays text read from `track_search`; it should only be used for matching ids.

**A1. Profile switch**
- Add `libraryProfile: "dj" | "therapy"` to `Prefs` (`lib/prefs.ts`); it already persists per device on desktop.
  - A first-launch chooser asks «Πώς θα χρησιμοποιήσεις το CrateMind;» (informal, like the rest of the app), and the choice can be changed in `Settings.tsx`. Existing installs count as DJ and skip it.
  - Switching remounts the app (`key={profile}`), so labels can be plain functions that read `getPref`; no hooks are needed at each call site.
- **Route policy:** `canAccessRoute(capabilities, path)` (`lib/capabilities.tsx:45`) gains the profile. Every caller uses it: `App.tsx:35`, `Sidebar.tsx:314-315`, and `CommandPalette.tsx`, which keeps its own route list today.
  - A blocked route shows a generic message instead of today's identity-specific one (`App.tsx:59`).
  - Therapy hides `/flow`, `/key-harmony`, `/phrase-finder` and `/smart-folders` (a stub). It keeps the rest. Identity routes stay capability-gated.
  - Hidden embedded surfaces: `DjayBeatgridCard` (`Settings.tsx:462`) and the artist genre-research actions.
- **Therapy copy:**
  - the Library placeholder (`Library.tsx:268`, which shows DJ syntax today);
  - the CommandPalette presets (`weapons` and `role:bridge` at `CommandPalette.tsx:49-52`);
  - the statuses: no "weapon", and the rest relabelled «Αταξινόμητο / Υπό δοκιμή / Εγκεκριμένο / Αποσυρμένο / Αποφυγή».
- **Labels and columns:** energy becomes «Διέγερση» and valence is «Συναισθηματικό σθένος» across:
  - `labels.ts`;
  - the table columns (`tablePreferences.ts:14-15`: darkness hidden, valence added);
  - `ShortcutsDialog.tsx:50`, `SetTimeline.tsx:220` and `RecommendationCard.tsx:61`;
  - the tagKeys toasts and the queue help (`TaggingQueue.tsx:110-113`).
  - `_list_payload` (`api/tracks.py:144-150`) and `TrackTable` carry `valence`.
- **Editors:** in therapy, `ProfileEditor.tsx` and TaggingQueue's own inline DJ controls show arousal/valence plus `FacetEditor`. They hide substyle, roles, breakdown, tolerance, cut flags and darkness.
- **Keys:** in therapy, digits set arousal, Shift+digit sets valence, and the role keys are off. **Cue-jump digits are off in therapy.**
  - Today any loaded deck swallows 1–8 twice: TaggingQueue returns early (`TaggingQueue.tsx:358`), and MiniPlayer's capture handler stops propagation (`MiniPlayer.tsx:603-609`). The queue help admits it: «1–8 μόνο χωρίς επιλεγμένο track».
  - So in therapy `isCueJumpKey` returns false, and MiniPlayer gets one profile guard at `:605`. That guard is the only change to `MiniPlayer.tsx`.
  - There are no facet shortcuts in A.

**A2. Facets (backend)**
- New `Facet` table: `id`, `key` (unique ASCII slug), `label` (Greek), `multi: bool`, `sort_order`. All facets show in both profiles.
- **Values** are `Tag` rows with `category = key` and `name = f"{key}:{value}"`.
  - This keeps `UNIQUE(tags.name)` (`models.py:258`) with no table rebuild.
  - Values that fold to the same text are rejected within a facet, e.g. «Χαλάρωση» and «χαλαρωση».
- **Reserved keys:** every `_FIELD_COMPILERS` key, plus `collections` (`search.py:271`), `folder`, `tag` and `valence`. A test fails if a built-in field ever shadows a preset key.
- **`services/facets.py` is the only write path:**
  - create, rename and delete values;
  - assign and unassign, enforcing single-value facets;
  - `seed_preset`, which is idempotent and additive. It adopts an existing uncategorised tag with the same name and errors on one owned by another category.
  - Deleting a facet requires `force`, reports the count, and cascades to its values.
  - Switching a facet from multi to single is refused while any track holds more than one value; the count is reported.
- **Bypass guards:**
  - `POST /tags` and `POST /tracks/{id}/tags` reject facet-owned tags by name prefix, and on the `tag_id` path also by `tag.category` (`api/tags.py:38-41`).
  - `legacy_import` (`legacy_import.py:104-108`) restores facets and facet links **through the facets service**, so the single-value rule holds. It skips and counts only what cannot be created. It is the desktop's only JSON import, so skipping would lose her assignments on a JSON restore.
- **Rename and delete:**
  - A rename rewrites `SavedSearch.query` through the A0 grammar and serializer. It compares folded values, keeps `-` and quotes, and reindexes affected tracks, all in one transaction.
  - Deleting a value that tracks still use requires `force`. It reports the track count and the saved searches it would break.
- **Routes** live in `api/facets.py`, mounted in `app_factory.py:172`. They are GET/POST/DELETE only, because the parity follow-up validator rejects PATCH (`check_parity_inventory.py:144`). Each is classified there:
  - `GET /facets`, `POST /facets`, `POST /facets/{id}`, `DELETE /facets/{id}`;
  - `POST /facets/{id}/values`, `POST /facets/values/{id}`, `DELETE /facets/values/{id}`;
  - `POST /facets/presets/{name}`, `GET /facets/counts?q=`, the latter resolved by subquery.
- **Bulk:** extend `POST /tracks/batch-profile` (`api/tracks.py:556`).
  - **`profile` becomes optional** (`schemas.py:97` requires it today), and profile writes are skipped when no profile field is set. Otherwise a tag-only action creates empty profiles, which silently removes those tracks from `untagged` (`search.py:211`).
  - It adds `add_tag_ids`, `remove_tag_ids` and `query`. The query is resolved by subquery, never as a bound id list.
  - **One transaction.** `_apply_profile` (`api/tracks.py:522`), `reindex_track` and `audit.log` (`services/audit.py:27`) each commit today. Each gets a `commit=False` path, and the request commits once.
  - On a single-value facet, adding replaces the old value. The confirmation shows how many values will be replaced.
  - Per-track audit rows store only the changed fields. Today each row is a full before/after profile, about 1.4 KB, roughly 40 MB per 30k-track action, and nothing prunes it.
  - The UI blocks double submission while the request runs. A 30k tag-add took about 10 s on macOS; re-measure on Windows.
- **Backup, exchange and CSV:**
  - add `facets` to `_export_metadata` (`backup.py:40`) and its import;
  - add a label in `_change_summary` (`library_exchange/operations.py:446`);
  - `exporter_csv.py` gets one column per facet, with values joined by "; ".

**A3. Valence and search**
- Add `TrackDJProfile.valence: Optional[int]` (1–10).
  - Generalise `_ensure_columns` (`db.py:63`, tracks-only today) to take a table name.
  - Update `schemas.py` and `exporter_csv.py`, and regenerate the schema contract.
- `search.py`:
  - Add `valence` to `_PROFILE_NUM`.
  - In the unknown-field branch (`:279-283`), a facet key resolves through a folded comparison against that facet's values. An unknown value matches nothing.
  - `<key>:*` means "has any value", so `-<key>:*` finds untagged tracks.
  - Multi-word values use the A0 grammar.
  - `folder:<text>` is a folded `instr` on `absolute_path`, with `\` normalised to `/` on both sides for Windows paths.
- Update `docs/README.md#search-syntax`.

**A4. Facet UI**
- `components/FacetEditor.tsx`: one row of chips per facet, with single-select facets as radio chips. It is used by TaggingQueue and the Library inspector.
- A Settings section «Λεξιλόγια»: add, rename and delete facets and values, load the therapy preset, and see usage counts.
- `tagDisplayName()` shows only the value part.
- TagCloud groups facet tags under the facet's Greek label. Today the grouped branch prints the raw category key (`TagCloud.tsx:121`). Links go through the shared token builder; today they use an unquoted name (`:139`), which breaks multi-word values.

**A5. Bulk tagging**
- `TrackTable.tsx` gets an optional `selectedIds` / `onSelectionChange` pair, so existing callers are unchanged. It adds a checkbox column and shift-click ranges.
- `Library.tsx` gets a bulk bar with two scopes:
  - «Επιλεγμένα (N)»: the selected loaded rows; Library loads at most 10,000 (`Library.tsx:103`).
  - «Όλα τα αποτελέσματα (N)»: query mode, with the count from `api.trackCount(q)`.
- The confirmation shows the server's count before anything is written. The selection resets when the query changes.

**A6. Triage queue**
- The «Χωρίς …» filters are built from `GET /facets`, not hard-coded. With a missing `purpose` facet, `-purpose:*` would fall through to free text and show the whole library. An empty state offers to load the preset.
- «Από φάκελο…» picks from a folder list instead of free typing. A new `GET /tracks/folders` returns distinct parent folders with counts.
- The queue loads pages of 500 by keyset on `(artist, title, id)`, so tagging that shrinks the queue never skips a track. Shuffle loads every page first. The progress line «Ταξινομημένα 1.240 / 6.800» uses `trackCount`.
- Paging also fixes an existing bug. «Όλα» currently requests `LIMIT 0` and gets nothing (`api/tracks.py:167-171`).

**Draft therapy preset.** A starting point only. **Review it with her before shipping A**; everything stays editable.

| key | Facet | Type | Draft values |
|---|---|---|---|
| purpose | Θεραπευτικός στόχος | multi | χαλάρωση, ενεργοποίηση, γείωση, συναισθηματική έκφραση, αναπόληση, κίνηση, συγκέντρωση, ύπνος, κοινωνική σύνδεση |
| mood | Διάθεση | multi | γαλήνια, χαρούμενη, τρυφερή, νοσταλγική, μελαγχολική, ενθουσιώδης, μεγαλειώδης, ανήσυχη |
| voice | Φωνή | single | οργανικό, φωνή χωρίς λόγια, με στίχους |
| lyrics | Γλώσσα στίχων | multi | ελληνικά, αγγλικά, άλλη |
| instruments | Όργανα | multi | πιάνο, έγχορδα, κιθάρα, πνευστά, κρουστά, ηλεκτρονικοί ήχοι, ήχοι φύσης, φωνή/χορωδία |
| phase | Φάση συνεδρίας | multi | έναρξη, ζέσταμα, κύριο μέρος, κλείσιμο |
| ages | Ηλικιακή ομάδα | multi | παιδιά, έφηβοι, ενήλικες, τρίτη ηλικία |
| tradition | Μουσική παράδοση | multi | ελληνική παραδοσιακή, έντεχνη, κλασική, τζαζ, world, ποπ/ροκ, ηλεκτρονική, ambient |

## Phase B: find it in the moment

- **B1. Facet filter panel** in `Library.tsx`:
  - Collapsible facets with live counts from `GET /facets/counts?q=`, plus BPM, arousal and valence ranges.
  - Clicking a value adds or removes its token through the A0 serializer. The text query stays the single source of truth.
  - `lib/queryChips.ts` labels facet tokens in Greek.
- **B2. Circumplex map:** in therapy, `EnergyMaps.tsx` reuses its existing 5×5 grid, with the same 25 count calls, as **arousal × valence**.
- **B3. Therapy dashboard:** pinned saved searches as «Γρήγορες λίστες», plus the sorting progress line.
- **B4. Conditional: desktop tempo estimate.** Only if many of her files lack BPM; Settings shows that count.
  - A new `services/tempo_lite.py` reimplements `_estimate_bpm_autocorr` (`audio_analysis.py:137`) in NumPy only:
    - SciPy's `medfilt` and `correlate` (`:165`, `:170`) are replaced;
    - the floor drops from `MIN_BPM = 60` (`:53`) to about 40;
    - there is no 120-BPM octave pull (`:186-187`) and no doubling (`:200`).
  - Samples come from a small ffmpeg PCM reader through `media_tools.process`, using the same command shape as `waveform_detail._decode` (`:167-168`). `_decode` itself returns encoded waveform bytes, not samples.
  - The desktop bootstrap's forbidden-module check (`desktop_runtime/bootstrap.py:105`) must still pass.
  - It needs a desktop-included job kind and route. It writes only an empty `bpm_analyzed`.

## Phase C: iso-principle session sequencing

- **C1.** New `services/iso_planner.py`, with `plan_session(session, start: AV, target: AV, steps, hold, query, bpm_start=None, bpm_target=None, exclude_ids=()) -> Plan`.
  - **Waypoints** for N steps and hold H (0 ≤ H ≤ N−2):
    - wᵢ = start for i < H;
    - otherwise wᵢ = start + tᵢ·(target − start), with tᵢ = (i − H + 1)/(N − H), so the last step lands on target.
  - **Distance:** Euclidean on (arousal, valence), plus |ΔBPM|/10 when a BPM path is given (10 BPM ≈ one axis unit). Tracks without BPM are then excluded and counted.
  - **Picking:**
    - ties break by distance, then track id;
    - no two picks come from the same `DuplicateGroup`;
    - the moving segment is re-sorted by projection onto the start→target line, so the path never reverses;
    - jumps larger than 2 axis units are flagged in the reasons.
  - **Bounds:** 2 ≤ N ≤ 40, with axis values 1–10.
  - **Gaps:** a shortage leaves an empty slot flagged «Δεν βρέθηκε κομμάτι». Unrated tracks are skipped and counted. The top 3 alternatives per slot come back in the preview.
  - The planner is deterministic and explainable ("not AI").
- **C2.** A new router, `iso_plans`:
  - `POST /iso-plans/preview` is stateless.
  - `POST /iso-plans` creates a **new** set. It writes the chosen tracks plus versioned waypoints JSON (`{"v":1,…}`) into the unused `DJSet.target_energy_arc` (`models.py:300`) in one transaction.
  - It returns 409 if a chosen track is now missing or retired.
- **C3.** Set Builder in therapy mode («Πλάνο συνεδρίας»):
  - a planner form, with start and target picked on the mini circumplex;
  - target vs actual curves (`SetBuilder.tsx:623-628`);
  - alternatives per slot;
  - M3U8 and Markdown exports (`exporter_markdown.py`), the Markdown with arousal/valence/purpose columns.

## Phase D: streaming and external lists (next release; own spec first)

- **Importers**, all offline, with no API keys:
  - Spotify via **Exportify CSV**;
  - YouTube via **Google Takeout CSV** or pasted links;
  - a **generic CSV / text** list;
  - local **M3U/M3U8/PLS/WPL**. Pull this into A if she keeps local playlists.
- **Import behaviour:**
  - Each list becomes a read-only source list plus an editable copy.
  - «Εφάρμοσε σε όλη τη λίστα» bulk-tags it in one step.
- **Requirement:** remote-only tracks must be taggable, searchable and sequenceable.
- **The representation is decided in D's spec, after a one-list lifecycle proof:**
  - **(a) file-less `tracks` rows.** `absolute_path` appears in 22 backend app files; `_mark_missing` would resolve URIs through `resolve_source_path`; M3U export assumes files.
  - **(b) source rows linked to `Track.id`, plus a small catalog-item layer.** `docs/ROADMAP_AND_IDEAS.md:31` leans this way.
- **Matching:** `identity_matching.text_key`, plus duration within ±3 s, plus ISRC. A match links and never merges silently.
- **Playback:** remote links open as **HTTPS**, because the native opener accepts only http/https (`native_actions.py:29`).
- The identity capability turns on whenever an identity DB exists for the dataset (`app_factory.py:202`), so D must coexist with it.
- If remote tracks become rows, re-check the library against SQLite's 32,766 bound-variable cap.

## Later (not planned now)
- «Παρόμοια» (similar tracks)
- Sound/frequency therapy: A4 tuning estimate, a spectral profile from `waveform_color.py`'s 6 bands, drone/binaural facets
- A single-deck player in therapy mode
- Facet reordering

## Global constraints (every phase)
- **Data safety:**
  - Nothing is ever written to her audio files, and facets live only in CrateMind's DB.
  - Imports are read-only.
  - Bulk writes are confirmed with the server's count, run in one transaction, and are audited per track as diffs.
- **Desktop-safe:** no SciPy/librosa/network in A–C; NumPy only in B4.
- **Large libraries:** no query binds one variable per track.
- **Greek UI copy.** Never show internal keys.
- **Schema and routes:** regenerate the contract after schema changes. Follow-up routes are GET/POST/DELETE only and each is classified in the inventory.
- **Tests:** hermetic, with hand-built fixtures.

## Risks
- **Her local library is about 5,000 tracks** (user, 2026-11-02). That is 6.5× under SQLite's 32,766 bound-variable cap. A0's variable-limit fix and A6's paging stay, because they are cheap and D may add rows. First-launch reindex time is still measured on a 50k-track synthetic DB, against the 300 s desktop start budget.
- Namespaced tag names make facet *key* renames expensive, so the UI renames labels only.
- `MiniPlayer.tsx` is the riskiest file. It gets only the one-line profile guard.

## Verification
- **Backend** (`uv run pytest`):
  - **Grammar:** the shared fixture covers elision, quotes and negation.
  - **Variable limit lowered to 100:** queue listing, free-text search, bulk query mode and facet counts all work on 150 tracks.
  - **Migration:**
    - the `user_version` marker is set, and the migration is idempotent;
    - an old DB is backed up, then reindexed with folded text;
    - the 50k-track timing is logged.
  - **Folding:**
    - «μανος χατζιδακις» finds «Μάνος Χατζιδάκις», final ς folds, and `artist:μάνος` matches;
    - facet tokens match with and without accents;
    - `-purpose:*`, `folder:` with Windows backslashes, and `valence:6-8` all work;
    - the reserved-key test passes.
  - **Facets:**
    - preset seeding is idempotent, adopts uncategorised tags and errors on conflicts;
    - the single-value rule holds on every path, including `tag_id` and legacy import;
    - fold-duplicate values are rejected, and multi→single is refused;
    - a rename rewrites saved searches, and deletes report what they break.
  - **Bulk:**
    - a tag-only bulk action creates no profiles;
    - one commit, with diff audit rows;
    - the replace count is correct.
  - **Backup and CSV:** the backup round-trip includes facets, and CSV has facet columns.
  - **iso planner:**
    - H = N−1 is rejected, and the last waypoint equals the target;
    - the path never reverses, and duplicate groups are excluded;
    - ties are deterministic, shortages leave empty slots, and the 409 fires on stale tracks.
  - **B4:** a 50-BPM click returns about 50, and the bootstrap forbidden-module check passes.
  - **Data safety:** bulk operations never touch files.
- **Frontend** (`bun test && bun run build`):
  - the shared grammar fixture and the serializer;
  - route policy across App, Sidebar and CommandPalette;
  - with a loaded deck, Digit3 sets arousal 3 in therapy and still jumps to cue 3 in DJ mode;
  - TagCloud labels and quoted links;
  - tagKeys per profile.
- **Desktop:** `generate_schema_contract.py --check`, `check_parity_inventory.py`, `build:desktop` and a frozen-import check. Then an installed **Windows, offline** smoke test **for each phase**:
  - **A:** first-launch chooser, preset, bulk via query, accentless search, tagging while a track plays, first-launch migration time.
  - **B:** facet panel, circumplex.
  - **C:** iso plan and M3U8 export.
- **Real use:** before the A release, show her the preset and the triage flow on a copy of a slice of her library.

## Delivery
After this roadmap is approved, each phase gets one TDD implementation plan via `writing-plans` (`docs/superpowers/plans/2026-11-02-therapy-phase-a.md`, then B and C). D gets its own spec first. Each phase plan gets the 2-pass review. A ships as a SemVer minor (`scripts/version.py set`). The Windows installer is built from a tag pushed only with the user's OK.

## Open questions for her (non-blocking except the vocabulary)
1. Does the draft facet table match how she thinks? What's missing or wrong?
2. Are her local files organised in folders, or in a player's playlists (which player)?
3. Roughly how many Spotify/YouTube lists and tracks, and can she run Exportify / Google Takeout?
4. ~~Roughly how many local tracks?~~ **Answered:** about 5,000.
5. ~~Does she tag while a track is playing?~~ **Answered:** yes, so the A1 cue-key fix is required, not optional.

## Plan review (2-pass)
- **Pass 1: `plan-reviewer`, Opus 5.5, effort high.** 2 blockers, 8 should-fix items, 6 cuts and 3 gaps; all applied.
  - Greek accent folding; folded and quoted facet matching.
  - Reuse `batch-profile`; the CommandPalette route list; tag-route bypass; rename vs saved searches.
  - `folder:` semantics; label reactivity; the cuts; and D's representation left open.
- **Pass 2: Codex gpt-6.1-sol, `model_reasoning_effort=xhigh`, read-only, its own plan-reviewer.** 3 blockers, 7 should-fix items and 2 suggestions; all applied.
  - The tempo fallback's SciPy use and tempo doubling; single-value enforcement; reindex commits.
  - Backup/CSV gaps; TaggingQueue's own controls; the djay card; "select all" bounds.
  - PATCH rejected by the parity validator; iso persistence; the HTTPS opener; identity gating.
- **Pass 3, added at the user's request: OMC `critic` on Opus 5.5, effort max, using the `plan-reviewer` skill.** 2 blockers, 10 should-fix items and 8 suggestions. Each was checked against the code, and all were applied.
  - **Blockers:**
    - A loaded deck swallows digits 1–8 (the earlier "guard unchanged" resolution was wrong).
    - SQLite's 32,766-variable cap breaks the queue and bulk actions on 33k+ libraries.
  - **Should-fix:**
    - The migration never actually ran: the revision only drives backups, `reindex_all` commits per track, and web mode backs up after `init_db`.
    - `_compile_str` `ilike` doesn't fold Greek; the two query tokenizers disagree; the A6 filters were hard-coded.
    - Pass 2's one-transaction fix was incomplete: the audit and profile commits, and a required profile that creates empty profiles.
    - Facet-rule bypasses; TagCloud fix cited at the wrong branch; relabel surfaces beyond `labels.ts`.
    - B4's decode assumption and its 60/120 BPM bias; the planner's formula, tie-break, duplicates and reversal.
  - **Suggestions applied:** prefix search, remount-on-switch labels, a first-run chooser, therapy placeholder and presets, a folder picker with `\` normalisation, an explicit build order, a smoke test per phase, and a citation fix (`absolute_path` is in 22 app files).
- **Deviations:**
  - A dedicated `fold_text` instead of `normalize_match_text`, which strips identity noise that FTS must keep.
  - B2 keeps the 5×5 grid instead of a grouped-count endpoint.
  - Passes 1 and 2 reviewed the same draft in parallel; pass 3 reviewed the revised plan.
