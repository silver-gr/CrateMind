# CrateMind: consolidate the collection library

## Decision

**Make one everyday collection represent each established redundant group. Keep the original source collections underneath it as immutable observations, not separate browsing entries.**

This is an operational change to Collections and collection selection throughout CrateMind. A smaller default library is the deliverable. Another analysis screen, a collapsed folder containing the same selectable duplicates, or a dry-run report is not sufficient.

Reuse native collections, ordered memberships, comparison/algebra, provenance relationships and the existing review UI. Add only the durable presentation bindings and decisions required to distinguish an active representative from an absorbed source observation.

**Collection family does not mean interchangeable collection.** A family can contain two useful arrangements, an accidental merge and an incomplete transfer. Never flatten an entire connected provenance component automatically.

## Basis and scope

The latest supplied reports describe 1,013 collections and 49,890 positions; 229 accepted copy relationships, 57 accepted migrations and two accepted parent edges for the Prog 2024 merge; and 341 uncertain relationships. These are reported implementation results, not a fresh audit of the live database. Relationship counts overlap and are not counts of removable collections. [R1, R2]

The older uploaded identity archives precede the latest provenance implementation. Codex must inspect the current local implementation and actual baseline, not rebuild from those older snapshots.

This milestone changes only canonical collection representation, local browsing/selection and consolidation decisions. Identity v1, canonical recording identities and metadata, provider resolution, original memberships, audio, remote services and recording-level review decisions stay unchanged.

## 1. Redundant versus genuinely distinct

Compare complete **ordered canonical recording sequences**, including multiplicity, using accepted identities only. Preserve unresolved source entities and unknown slots explicitly. Two generic nulls are not an identity match; unmatched provider identities are not proof of different recordings.

| Case | Default decision | What permits consolidation |
|---|---|---|
| Repeated export of the same unchanged source observation | Absorb repeat observations | Stable source identity plus matching content; archive filenames alone are not remote playlist IDs. |
| Exact ordered copies | Consolidate automatically when copy/migration evidence supports the relationship | Full sequence equality, no explicit keep-separate decision or meaningful conflicting purpose. Provider, export-time and account differences alone do not block it. |
| Identical contents in different order | Keep separate pending compact review | User chooses one everyday arrangement or explicitly says the order difference is immaterial. Different DJ running orders remain distinct by default. |
| Same sequence but genuinely different names/purposes | Review; respect explicit separate purpose | Names that are merely export suffixes/aliases are not blockers. Different curated purposes or substantial user notes are not silently dismissed. |
| Incomplete migration with omissions only | Review unless the omission explanation was already established | Accepted migration plus explicit transfer-failure evidence or a prior human decision that this is an incomplete copy. Subset membership alone is insufficient. |
| Suspected wrong substitutions | Review | Independently established wrong match, or explicit human judgment. Positional mismatch between unlinked identities is only unresolved correspondence. |
| Subset or edited selection | Keep separate by default | User confirms it was accidental/incomplete or superseded. A shorter warm-up/set edit can be more useful than its parent. |
| Extension/superset | Review | User chooses the extended version as replacement, or confirms a shared purpose and preferred contents. Size alone does not establish authority or chronology. |
| Accidental same-name concatenation | Absorb the merged artifact into its separate parents when verified | Exact ordered concatenation, supported migration-artifact provenance and no protected independent use of the combined playlist. The Prog 2024 case is the named default. |
| Intentionally separate collections | Keep separate | Explicit intent, protected edits or meaningful arrangements override automatic grouping. |
| Empty, singleton or dynamic system snapshots | No content-only automatic grouping | Require reliable observation identity or explicit confirmation; an empty list or shared single song is weak purpose evidence. Dynamic differences are dated observations, not errors. |

For existing accepted exact-copy/exact-migration relationships with unchanged equal sequences, reuse the recorded evidence; no new human confirmation or chronology proof is required unless a concrete protected difference exists.

An accepted relationship is input evidence, not a command to hide its destination. In particular, the accepted Account-1 Likes migration does **not** make the current Account-1 and Account-2 Likes collections equivalent. The different account Likes remain distinct in this milestone. An ordinary playlist named “Liked Songs” remains a playlist.

## 2. Surviving canonical collection

Choose the representative by user intent and content, not provider rank:

1. Honor a previous representative/keep-separate decision and protected native edits.
2. Prefer an existing editable native working collection explicitly derived from this same collection and with the selected contents. Do not create a duplicate native wrapper unnecessarily.
3. Otherwise create one native representative from the selected complete observation, reusing the existing copy service. For automatic exact-copy groups, all eligible sources supply the same canonical order.
4. Within genuinely interchangeable sources, prefer the best preserved original title/description and supported source provenance; use stable IDs as the last tie-breaker. Differences requiring interpretation go to review.

The canonical collection has its own stable ID, chosen name and exact ordered membership. Preserve all source names as searchable aliases, with descriptions, curators, privacy and dates retained per observation. A source containing unique tracks does not lose them because it is Spotify rather than SoundCloud, or Account 2 rather than Account 1.

Do not automatically rename unrelated same-name playlists into one name. Distinguish them in the UI using count/date/curator context; retain original titles until the user names them.

For exact copies, map every canonical position to all corresponding source positions. For reviewed non-identical variants, record which observation supplied each selected position and how every non-selected difference was handled. Preserve repeats; do not apply track deduplication incidentally.

## 3. Handling differences without guessing history

Review should answer **which collection the user wants to keep using**, not require solving every migration date.

Provide one compact comparison per decision group, not one card per pairwise edge. Show source names/owners, lengths, accepted overlap, order/repetition changes, unmatched positions, destination-only additions and timestamp evidence. Separate established recording differences from unresolved identity correspondence.

Actions:

- **Keep A as the everyday collection; retain B underneath.** Display and require acknowledgment of any B-only content or arrangement that becomes historical-only.
- **Keep B instead**, with the same check.
- **Keep both distinct.** Persist this override against automatic reconsolidation.
- **Choose combined contents**, using existing algebra/preview and explicit order approval. This is an intentional new collection, never an automatic near-duplicate union.
- **Defer.** Both entries remain visible with a concise unresolved-group marker.

An optional group-level batch decision may cover explicitly selected, equivalent cases, but must enumerate the affected collections and differences. A few examples must not authorize hiding unreviewed unique content elsewhere.

Every source-only occurrence must be accounted for as represented, retained in another active collection, or deliberately retained only in history after an explicit decision. Archival preservation alone is not permission to silently remove meaningful content from everyday access.

## 4. Concrete known cases

### Repeated migration copies

A 20-position list copied into another account twice should produce **one active collection with three source observations**, when exact sequence and copy provenance pass the gates. Different insertion timestamps are preserved, not used to manufacture separate collections. Several accepted edges in this group still remove only two everyday rows.

### Prog 2024: 29 + 2 → 31

**Default: keep the two original collections; hide the accidental 31-position concatenation from everyday selection.** Keep that concatenation available as shared provenance of both parents. Map its first 29 positions to one parent and its last two to the other. Do not redirect an old link to the 31-position artifact arbitrarily to just one parent.

This requires a source observation to support multiple representatives. A single `source_id -> survivor_id` field is insufficient. All three original orders remain recoverable, including the combined arrangement.

If the user deliberately used the combined playlist or prefers it now, compact review can instead choose it as the everyday collection and retain both parents underneath. The report establishes concatenation; the consolidation decision establishes the desired presentation. [R1]

### freeyourmind: 446 versus 447

The reported evidence establishes an ordered inclusion with one extra recording, **not that the longer list is later**. Show the extra track and placement. Choosing the 447 version absorbs the shorter list without losing its arrangement history; choosing 446 explicitly retains the extra as historical-only; keeping both preserves both as active collections. No automatic largest/newest rule. [R1]

### Imperfect SoundCloud → Spotify transfers

For the reported Psytech candidate, frozen identities establish shared positions and unresolved differences, but not proven migration errors. Keep it reviewable. If the user confirms it is a redundant transfer, select the desired source order and account for each extra/missing/unresolved item before absorption. Do not use consolidation to accept a recording match or prove a wrong substitution. [R1]

## 5. Make the smaller library the actual default

Use one collection-library resolver across:

- Collections list/search, counts and selection dialogs;
- add/copy destinations, algebra operands and comparison selection;
- Library/Recovery collection filters, membership chips and dashboard links.

The default query returns **active representatives and genuinely separate/undecided collections only**. Absorbed sources must not remain separate choices under another name. Searching a source alias finds its representative once; source/account filtering includes representatives backed by that source.

A representative shows “Sources / history: N” with original memberships, ordering and the restore action. Existing source deep links still work: offer the representative, or both parents for the merge case, plus an explicit original-snapshot view. Evidence/provenance routes continue to address original source IDs. Do not silently rewrite an existing playback queue.

Retain an explicit “All source observations” mode for archival inspection, not the default browser. Keep provenance families and existing interest counts separate from this presentation mapping. Consolidation-generated representatives are derivations, not new independent selections. They must not inflate family-based interest.

This is real consolidation because each group gains one editable everyday identity with deliberate content and source bindings, not merely a hidden-row filter. Future edits affect that native representative; imported observations stay immutable.

## 6. Reversal and refresh

Persist each operation with its batch/decision ID, representative ID, absorbed source IDs, chosen order/name, membership-origin mapping, evidence and before/after presentation state. Use additive bindings plus the existing audit/event conventions, not a second generic graph.

Support both **Undo this consolidation** and **Restore this source as a distinct collection**. The latter exposes the exact original order/title as an active collection, optionally through the existing native-copy path, and records a durable keep-separate override. It does not falsify historical lineage or rewrite track identities.

Undo restores presentation and membership selection only. If the representative has since been edited, preserve those edits and show the conflict; never blindly restore the entire database backup over newer work.

Stable IDs and decisions must survive refreshes. An unchanged repeated source import must not reappear as a separate everyday collection. A new snapshot with differences must not silently replace canonical contents or have its unique entries hidden as a known duplicate.

## 7. Measurement and acceptance

First snapshot the actual active count, original collection/position hashes, frozen identity/metadata tables and current decisions. The expected baseline is **1,013 / 49,890**, not a number to restore over newer work. [R1, R2]

Report:

| Measure | Required interpretation |
|---|---|
| Starting everyday collections | Actual pre-pass count. |
| Active canonical collections after | Representatives plus kept/undecided distinct entries; do not claim unresolved entries are proven distinct. |
| Absorbed original observations | Count distinct source IDs, not relationship edges or binding rows. |
| New representatives | Separate from absorbed-source count and total stored collection rows. |
| Decision groups | Automatic exact, verified concatenation, human-reviewed, kept-separate and unresolved. |
| Difference coverage | Source-only recording identities and occurrences needing review, plus intentionally historical-only choices. |
| Preservation | Every original source position/order unchanged; no lost references. |
| User benefit | Default browsing and all selectors demonstrably show fewer entries. |

Accounting: **after = before − original everyday rows absorbed + newly active representatives**. Existing retained representatives do not count as newly created. For multi-parent merges, count the shared hidden observation once.

Do not estimate the final count by subtracting 288 accepted edges. Compute the valid decision groups and report actual reduction. Apply every eligible automatic group in this run; unresolved groups must not prevent that reduction. Explain blocked groups individually by reason category rather than using uncertainty as a reason to stop the milestone.

## Preferences that actually need the user

No preference question is necessary before applying exact-copy consolidation.

For non-identical groups, the real choices are **whether an alternate order/subset has independent purpose** and **which contents/order should be the everyday version**. Ask those in the compact comparison, not as abstract architecture questions.

For Prog 2024, use the stated default of two originals and an absorbed migration artifact; a protected deliberate use of the combined version triggers review instead. Naming/provider settings are deterministic defaults above, not prerequisites for progress.

## Source register

- **[R1]** User-pasted “Collection Provenance + Recovery Prioritization,” completed September 16, 2026: accepted/proposed edge counts, exact Prog concatenation, 446/447 chronology limits, Psytech ambiguity, family semantics and immutable 1,013/49,890 baseline.
- **[R2]** User-pasted “Integration stabilization and Collections” and “Library Completeness + Collection Intelligence”: native create/copy/append, source immutability, membership origins, canonical algebra and availability.
- **[R3]** User-pasted “Focused Recovery correctness pass”: no accepted association is not proof of missing audio; existing candidate/identity guards remain separate from availability.
- **[R4]** Uploaded `SOUNDCLOUD_PROVENANCE_HANDOFF.md`: source preservation, complete ordered slots, saved/system collections and no content-only SoundCloud duplicate groups at extraction.

The policy and implementation design above are recommendations. Reported measurements and known-case findings are attributed to these sources; no live consolidation has been executed here.
