# Collection Provenance + Recovery Prioritization

Implemented September 16, 2026. Identity v1, canonical metadata, provider resolution, availability rules, collection algebra, recovery states and imported memberships were retained.

## Product changes

- **Recovery (`/recovery`) now defaults to explicit wanted items**, not the remote-only catalog. Remote-only remains a provider/local-availability fact. Favourites, cross-provider favourites, strong-interest and lost-file presets are clearly presented recommendations or selected queries.
- Sort transparently by evidenced collection families, raw distinct collections, explicit wanted, artist, or raw SoundCloud popularity. Popularity ordering uses the minimum observed counter across attached SoundCloud identities, missing counters last; individual raw counters remain visible. Local DJ personal statuses are displayed when a local profile exists.
- Save a preset/filter result as a new native collection snapshot. This neither sets wanted nor acquires audio. Exact source positions are recorded as origins; saving a derived recommendation does not manufacture an additional independent family selection.
- **Collection provenance (`/provenance`)** browses copies, migrations, merges, structural extensions, imperfect transfers, same-name conflicts and unresolved proposals. Detail shows evidence, exposed date clusters, canonical position correspondence and review actions. Accept/reject/reset are local audited decisions and never modify recording identity.
- Collection detail includes lineage links, original source counts and family counts. The recording history view is linked from Recovery and Library's canonical card: it shows factual collection/Like observations, accepted relationships and local availability. Unknown dates remain unknown.
- Exact observation equivalence displays **≡**, not a chronology arrow. Migration/merge directions use supported account/source relationships. Dates alone never assign April to SoundCloud or September to Account 1.

## Additive data and count semantics

`collection_relationships` and `collection_relationship_events` live in `backend/data/identity.sqlite`. Source observations are unchanged. Each relationship retains source/destination IDs, type, status, evidence, confidence, decision mode and timestamp. Confidence is an evidence-strength annotation, not calibrated probability.

Three separate counts are exposed:

1. `raw_collection_occurrences`: every membership position, including repeated positions.
2. `source_collection_count`: distinct collection rows; the pre-existing raw `collection_count` is retained.
3. `collection_family_count`: distinct evidenced roots through accepted lineage and explicit native derivation origins, scoped to recordings actually present in each contributing source.

A merged destination expands to its contributing parents: two independent parents sharing a recording still count twice. A descendant's new recording remains rooted in the descendant if absent from its parents. Human unrelated/rejected decisions override inferred grouping. Pending lineage never reduces counts. These are **evidenced families, not proof of psychologically independent selections or a personal-importance score**. Unknown relationships can still inflate family counts.

## Results

| Relationship measure | Count | Meaning |
| --- | ---: | --- |
| Active relationships | 629 | Additive interpretations |
| Accepted exact-copy relationships | 229 | Exact canonical sequence and supporting name/origin evidence |
| Accepted migrations | 57 | 56 exact Account-1→Account-2 copies; 1 explicitly user-confirmed Likes migration |
| Likely migrations | 44 | Proposed |
| Structural descendants/extensions | 14 | Proposed; none automatically accepted as later chronological descendants |
| Merge destinations | 1 | Two accepted parent edges, the 29+2→31 Prog 2024 merge |
| Imperfect transfer candidates | 30 | Overlapping category; does not assert proven wrong substitutions |
| Unresolved relationships | 341 | Includes same-name conflicts and uncertain correspondence |

Categories overlap. There are 288 accepted edges in total. The user-confirmed Account-1 Likes transfer is preserved as history without asserting current snapshot equality.

**6,183 recordings have fewer evidenced families than source collections.** Example: Kopophobia & Marcuz — Going Home has 26 raw positions / 26 source collections / 13 families.

Current selected-query pools, without assigning acquisition intent:

| Preset | Recordings |
| --- | ---: |
| Explicit wanted, not playable | 0 |
| Likes on either service, not playable | 7,871 |
| Likes on both services, not playable | 504 |
| Remote-only with ≥3 evidenced families | 2,910 |
| Lost local files | 365 |

## Known-case validation and evidence limits

1. **Exact Account-1→Account-2 copies:** actual canonical sequences validated; examples in `validation.json`.
2. **Prog 2024 merge:** Account-1's 29 and 2 positions concatenate exactly into Account-2's 31. Both source rows/order remain intact.
3. **Repeated SoundCloud exact observations:** six exact single-track destination observations across three SoundCloud source collections. They remain proposed because singleton equality/name/route is insufficient to confidently establish individual migration lineage. No multi-track exact SoundCloud→Spotify sequence was found in retrieved evidence with the frozen canonical identities.
4. **freeyourmind 446/447:** all 446 canonical recordings occur in order in the 447-track observation; one destination-only insertion. The larger observation has April membership dates and the smaller September dates. This proves structural overlap, **not** a transfer-then-later-addition chronology. A known later-addition case is verified on a deterministic fixture.
5. **Imperfect SoundCloud candidate, Psytech:** six shared canonical positions, one source position without a destination counterpart and one ambiguous positional discrepancy. Migration is still proposed, so the discrepancy is **not** labelled a proven wrong substitution. The accepted-migration fixture verifies a likely wrong substitution between matching neighbors, a missing destination, reordering and additions; contradictory later-edit dates suppress the historical-substitution label.
6. **Same-name unrelated collections:** actual disjoint-content observations remain proposed conflicts; disjoint canonical IDs do not prove historically unrelated origin. An explicit human-unrelated fixture verifies that independent selections stay separate and survive refresh.
7. **Material frequency reduction:** actual recording examples and root-count reductions are in `validation.json`.

For accepted migrations, correspondence is evidence about playlist positions only. It cannot promote or merge recording identities. `transfer-discrepancies.json` records actual discrepancies with source/destination positions and uncertainty.

## Verification and artifacts

- **55 focused tests passed**, including merge-parent counting, human decision persistence/overrides, cycle rejection, native snapshot feedback prevention, source immutability, correspondence guards, API validation and Recovery semantics.
- Frontend TypeScript/Vite build passed. Browser checks passed for default wanted-only Recovery, recommendation intent, merge evidence and family counts; zero page errors. Review/save mutations were tested against isolated catalogs; browser checks did not write user decisions to production.
- All pre-existing source/identity/canonical/collection table hashes match the pre-pass baseline. Accepted stored lineage is acyclic. Original 1,013 collection rows and 49,890 positions remain unchanged.
- No audio/remote mutations, acquisition, identity promotion or matcher rerun.

Artifacts in this directory: `before.sqlite`, `before.json`, `summary.json`, `relationships.json`, `validation.json`, `transfer-discrepancies.json`, `tests.xml`, `build.log`, `browser.json`, and UI screenshots.

Runners: `reconciliation/build_collection_lineage.py` populates additive evidence while preserving human decisions; `reconciliation/validate_collection_lineage.py` validates the actual catalog without changing it. `reconciliation/browser_collection_lineage.py` checks the live UI without production decision writes.
