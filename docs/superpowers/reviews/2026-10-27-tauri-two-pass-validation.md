# CrateMind Tauri plan — two-pass validation

Date: 2026-10-27
Scope: plan/design/API inventory only. No migration, application edits, database operations, builds or runtime tests.

## Requested order and model evidence

1. GPT-6 Astra, high effort, native Codex subagent using the plan-reviewer skill. The exact review is preserved in [pass 1](2026-10-27-tauri-review-pass1-astra.md).
2. All pass-1 findings were applied before launching the second reviewer.
3. Claude Opus 5.5, xhigh effort, through the installed Claude Code CLI with read/search tools only, no fallback and no session persistence. The successful result reports only claude-opus-5-5 in modelUsage, 76 turns and zero permission denials. Requested effort was explicitly passed as --effort xhigh. The exact review is preserved in [pass 2](2026-10-27-tauri-review-pass2-opus.md).
4. Root applied the second pass's applicable corrections and ran targeted document/source consistency checks. No third model review was run.

Input/revised/final document hashes and invocation metadata are recorded in the adjacent provenance JSON. Both model reports are historical review results against their input revisions; their changes-required verdicts must not be relabeled as approval of the later edits.

## Pass 1 disposition

| Finding | Disposition in the revised plan |
|---|---|
| B1: web import activation | Shared pre-import active-dataset resolver, exact catalog/identity pairing and ordinary web startup tests. |
| B2: complete-operation exclusion | Dataset lease plus shared maintenance admission/drain across HTTP, jobs and final identity synchronization; no nested SQLite reservation. |
| B3: private/provider calibration | Calibration route/UI deferred; generated reports excluded. Inventory is 92 retained + 12 deferred. |
| B4: exported local paths | M3U/reveal use device resolution; CSV keeps documented logical/audit paths. |
| S1: redundant service worker | Desktop build disables registration and prompt; web PWA stays unchanged. |
| S2: repeated export forks | Unchanged re-export reuses immutable snapshot/parent/archive. |
| S3: backward prerequisites | Production tool/resource seams moved to the first package spike; dependency edges are explicit. |
| I1: theme/panel preferences | Complete preference owners and prepaint/CSP behavior included. |
| I2: media cache isolation | Generation-scoped positive/negative caches and rollback tests. |
| I3: hostile export destinations | Containment/source-overlap/traversal/symlink acceptance tests assigned to the shared export boundary. |

## Pass 2 blocker disposition

| Finding | Correction and proving acceptance |
|---|---|
| B1: ambiguous provider guards | Every baseline route has desktop_guard; four explicit identity-pair mutation routes allow local↔local only. Existing-link replay/derived candidate refresh and local canonical/collection decisions remain shared. Test service rows and both directions of handoff. |
| B2: startup schema and false conflicts | Generated schema contract, pre-startup paired backup, materialized lazy schema and additive empty/NULL value-digest compatibility. Unknown/newer structures fail clearly; data rewrites remain revisions and never erase pending edits. |
| B3: no enrollment/script ownership | Web-first enroll/S0 flow, retired-source marker, shared config lookup and a provider/reconciliation entry-point ownership audit. Original DB/WAL files are copied privately before read-write snapshot helpers. |
| B4: duplicate pointer owners | Python alone reads/writes/recovers active/exchange/pending state; Rust supplies app-data/resources/tools and supervises fixed helpers. |
| B5: conflict dead end | Explicit confirmed replace-incoming after a complete local conflict archive, with retained rollback and valid continuation from incoming lineage. Normal import still refuses divergent histories. |
| B6: no mapping controls | Versioned desktop config, Settings mapped/unmapped/disconnected roots, native picker and supervised restart instead of live settings-cache mutation. |

## Simplifications and bounded judgments

- Accepted S1: web data enters desktop through enrollment/exchange. Direct native discovery/adoption is limited to Deno-only/empty cases.
- Did not unilaterally adopt S2's proposed removal of legacy Deno metadata import. That was a retained feature, and the reviewer itself identified removal as requiring a scope decision. Keep the adapter desktop-only, separate from full exchange; do not add the legacy endpoint to web. Its later retirement can be decided separately.
- Partially accepted S3: remove mandatory Origin/Referer presence on safe GET/HEAD so native media can work without those headers. Retain rejection of explicitly foreign headers, exact Host, session authentication and Fetch Metadata checks when supplied. Cookies are not port-isolated, so dropping all read-origin defenses was unnecessary.
- Accepted S4: no browser-preference transfer feature; new desktop preferences persist and old display settings can be set again.
- SQLite validation uses the shared minimum schema/query feature contract, FTS5/JSON probes and a recorded version. It does not require being newer than every independently installed web SQLite when equivalent required behavior is proven.
- Keep scan timestamps/identity observation writes as conservative revisions. Do not build a second field-normalizing identity model to hide maintenance writes. The new conflict-recovery action prevents this policy from becoming a permanent dead end.

## Other pass-2 improvements incorporated

Standard macOS Edit actions, typing/shortcut/focus tests, production browser-action restrictions, early codec decisions, explicit untested-platform gates, Greek string detail plus code, complete UI file owners, separately inventoried new endpoints, cross-device mtime tests, untouched legacy source copies, graceful audio shutdown, disabled desktop remote artwork, SQLite probes, archive retention, new-track web analysis instructions and a side-effect-free app factory are all assigned to tasks.

The milestone order was also corrected after adding enrollment: shared path and exchange/enrollment foundations precede desktop onboarding, rather than leaving a dependency on a later numbered task.

## Completion evidence and limits

The final document checks verify task ordering/dependency acyclicity, source-backed baseline entries and guards, planned-route classification, 104 = 92 + 12, local links and the presence of each correction. Application source remains unchanged.

The requested two reviewer passes are complete and their actionable planning corrections are incorporated. The final edited revision has root consistency validation, not a third model approval. Native cookie/media behavior, frozen packaging, OS support, safe runtime handoffs and performance remain explicit implementation gates.
