# Collection consolidation — implemented and applied

The everyday library is **727 collections**, down from **1013** by **286 (28.2%)**. This is the live default, not a preview. Unresolved survivors are not claimed to be proven distinct.

The authoritative execution brief was implemented first. `/Volumes/6937130292/Projects/CrateMind/docs/CONSOLIDATION_DESIGN.md` arrived during the work and was read and checked before completion. Its named cases and boundaries agree with the implementation.

## Accounting

| Measure | Live result |
|---|---:|
| Starting everyday collections | 1013 |
| Active everyday collections | 727 |
| Original everyday observations absorbed (distinct IDs) | 571 |
| New native representatives | 285 |
| Existing native representatives reused | 1 |
| Automatic exact groups | 284 |
| Verified Prog concatenation presentation decisions | 1 |
| Human-reviewed consolidation groups in production | 0 |
| Kept-separate decisions manufactured in production | 0 |
| Unresolved review groups | 104 |
| Active entries participating in those review groups | 263 |
| Remaining automatically eligible groups | 0 |
| Original collections retained | 1013 |
| Original membership positions retained | 49890 |
| New native representative positions | 9935 |
| Total stored collection rows, including history | 1298 |
| Total stored positions, including history | 59825 |
| Source occurrences explicitly relegated solely to history | 0 |

**727 = 1,013 − 571 + 285.** The shared 31-position merge observation is counted once, despite supporting two representatives. The existing Summer 2023 native collection was reused and remains byte-for-byte unchanged. The representative layer adds no independent selections: all recording raw-frequency, source-count and family-count values equal the baseline.

## What now works

Open [Collections](http://localhost:5173/collections). The default list and selectors expose active representatives and separate/undecided collections. Aliases search the representative once; provider/account filters examine attached source observations. The Unified Library picker, Recovery filters, canonical provider membership cards and Dashboard collection count/link use the same active-library resolver.

Native representatives use existing copy/append/algebra endpoints. Original observations are available through **Πηγές & ιστορικό** and **Όλες οι αρχικές παρατηρήσεις (ιστορικό)**. Original deep links resolve to the representative when unique; the Prog artifact offers both representatives. `original=1` explicitly opens the original ordered snapshot. Playback queues were not rewritten.

The existing Collections surface now has grouped review with preview, source metadata, date evidence, differences, explicit order approval, per-occurrence historical-only acknowledgment, representative selection, keep-all-distinct, defer and the existing algebra for an intentional combination. All unreviewed entries stay active. Canonical metadata or provider identity acceptance is never implied by a collection presentation choice.

## Named real-data cases

- **Exact accepted migrations/copies:** all eligible groups applied, complete canonical order and repetitions retained. Every absorbed position has a disposition and resolves to the same accepted recording as its native position; mismatches: 0.
- **Prog 2024:** two active native representatives of 29 and 2 positions. The original 31-position concatenation is shared provenance, with its first 29/last 2 positions mapped to the two parents. All three original sequences remain intact.
- **freeyourmind:** 446/447 stays in compact review. The extra is at displayed position **90**, Spotify identity `spotify:track:2Wuy4Wgazpag735bEfHQLY`; source title metadata is absent, so the UI exposes the identity rather than inventing a title. The larger observation has April 10 membership dates, the smaller September 9. No newer/later conclusion is drawn.
- **Psytech:** retained as proposed correspondence: 6 shared positions, 1 source position without a destination, 1 ambiguous correspondence in the existing example. No claim of a proven wrong song or accepted migration.

Difference review covers **5,377 unique accepted recording identities** and **8,231 original source occurrences**. These are the union of non-shared ordered comparison positions relative to each card's displayed proposed representative, including reorders/repeats and expanding native positions back to original observations. They are not counts of wrong matches or necessarily different pieces of music. Full evidence and the exact counting definition are in `validation.json` and `manifest.json` in this folder.

## Reversal and persistence

Each applied decision has a stable ID, baseline hashes, selected source/name/order, source bindings, position dispositions, batch ID and audit event. Applications take a SQLite writer lock and reject stale contents. Unchanged rerun: 727 → 727, zero new decisions. Reimport fixtures reuse the existing representative for reliably identified unchanged observations; differing snapshots remain active. The bounded apply command performs that check after an import; this milestone does not add or run a provider importer.

**UI:** Πηγές & ιστορικό → Αναίρεση ενοποίησης / Αναίρεση αυτόματης παρτίδας / Επαναφορά ως ξεχωριστή. Restoring a source records a durable presentation override without changing historical lineage. Undo preserves edited native work and reports that it remains active; it also respects later decisions that reuse a representative.

**Batch undo command** (provided, not run on production):

```sh
cd /Volumes/6937130292/Projects/CrateMind
/Users/silver/venv/bin/python reconciliation/consolidate_collections.py undo --batch collection-consolidation-v1
```

The SQLite backup is evidence and emergency recovery material; normal undo never restores the entire backup over later edits.

## Verification

- Targeted backend regression suite: **47 passed** (`tests.xml` / `tests.log`).
- Frontend type check and production build pass (`build.log`); existing Vite configuration/chunk-size warnings remain.
- Live browser checks: 727 default entries, alias search, one selector choice, source history, freeyourmind review (`browser-live.json`, screenshots).
- Isolated browser checks additionally exercised individual restore and undo (`browser-isolated.json`). No production human review or undo decisions were manufactured.
- The three-observation repeated-migration case is a deterministic fixture; live automatic groups are 283 two-observation exact groups, the three-entry Summer source/local-proof/native group, and Prog. These are not presented as a newly proven three-provider migration.
- Deterministic fixtures cover repeated positions, different order, subset, generic unknown slots, singletons, reliable reimport, stale hashes, atomic rollback, component-level keep-separate, conflicting notes/curators, edited native protection, cross-batch reuse, restart and API deep links. Fixture results are not presented as real-library findings.
- Every baseline table outside new representative rows/positions retains its hash. Every original collection row and original membership position retains its hash. Primary file-catalog tracks retain their hash. Accepted identities, canonical metadata/credits, lineage decisions/events and source positions are unchanged.
- No SoundCloud/Spotify calls, file relinking, rescans, audio/tag changes, downloads or remote mutations.

## Implementation paths

- `/Volumes/6937130292/Projects/CrateMind/backend/app/services/collection_consolidation.py`: presentation decisions, bindings/dispositions, shared resolver, exact application, grouped review, restore/undo.
- `/Volumes/6937130292/Projects/CrateMind/backend/app/services/library_collections.py`: existing native copy reuse and resolved browser.
- `/Volumes/6937130292/Projects/CrateMind/backend/app/services/identity_library.py`: default selectors/counts/memberships.
- `/Volumes/6937130292/Projects/CrateMind/backend/app/services/library_completeness.py`: active membership/filter projection, source evidence retained.
- `/Volumes/6937130292/Projects/CrateMind/backend/app/services/collection_lineage.py`: excludes generated wrappers from raw observation counts; existing family meaning retained.
- `/Volumes/6937130292/Projects/CrateMind/backend/app/services/provider_resolution.py`: active membership display with raw source memberships retained separately.
- `/Volumes/6937130292/Projects/CrateMind/backend/app/api/identity.py`: shared read routes and local review/history/undo endpoints.
- `/Volumes/6937130292/Projects/CrateMind/frontend/src/components/CollectionConsolidation.tsx`: review/source history inside existing Collections.
- `/Volumes/6937130292/Projects/CrateMind/frontend/src/pages/Collections.tsx`, `/Volumes/6937130292/Projects/CrateMind/frontend/src/pages/UnifiedLibrary.tsx`, `/Volumes/6937130292/Projects/CrateMind/frontend/src/components/CollectionPicker.tsx`, `/Volumes/6937130292/Projects/CrateMind/frontend/src/components/CompletenessSummary.tsx`: default browsing, alias-aware selection and active count.
- `/Volumes/6937130292/Projects/CrateMind/backend/tests/test_collection_consolidation.py`: focused regression cases.
- `/Volumes/6937130292/Projects/CrateMind/reconciliation/consolidate_collections.py`, `/Volumes/6937130292/Projects/CrateMind/reconciliation/validate_consolidation.py`, `/Volumes/6937130292/Projects/CrateMind/reconciliation/browser_consolidation.py`: reproducible execution/verification.

All outputs are in `/Volumes/6937130292/Projects/CrateMind/reconciliation/identity/consolidation`: `before.sqlite`, `before.json`, `primary-before.json`, `manifest.json`, `validation.json`, test/build/browser evidence and isolated trial files. Unrelated working-tree edits were left in place.

## Remaining grouped content decisions

1. **freeyourmind:** use the 447-position arrangement, use 446 and acknowledge the extra as historical-only, or keep both.
2. **Imperfect-transfer groups such as Psytech:** choose the intended source arrangement after inspecting every unmatched/ambiguous position, or keep separate. Presentation choice does not prove historical migration or accept identity matches.
3. **Alternate orders, subsets and extensions:** distinguish useful arrangements/purposes from redundant copies in the grouped review. Keep-all and defer preserve visibility; no global union or largest-playlist rule is applied.

The automatic work is complete. No subsequent milestone started.
