# Independent final implementation review

Date: 2026-10-27. Scope: current dirty Tauri migration against the approved migration design, implementation plan, and route baseline. This is the independent code/spec/security lane, not an architecture verdict or a release certification. Implementation remained with the integration owners; this reviewer wrote only this report.

## Result

**Recommendation: COMMENT — no unresolved source findings in this focused code/spec/security lane.** The previously outstanding Task 14 preview requirement is now implemented and source-rechecked. This is not an approval or merge-readiness claim: the requested LSP diagnostics are unavailable, the integration owner's final test run is still in progress, and the rebuilt artifact requires its final native checks.

**Files inspected:** 71 implementation/configuration files, plus relevant tests, planning, operations, and prior-review artifacts. Full dirty-tree status and diff statistics were inventoried. The focused source review covered application construction/runtime profiles; desktop authentication/server/bootstrap/config/preferences/protocol/actions/adoption; shared dataset selection, ownership, maintenance, schema, exchange and writer entry points; filesystem/media consumers; worker reservations; Rust lifecycle/security/actions/process ownership; packaging; shared frontend capability gates, preferences, native settings and exchange controls.

## Task 14 follow-up: resolved

### [MEDIUM, resolved] Conflict replacement lacked the required comparison evidence

Current evidence: `backend/app/library_exchange/operations.py:103` (`ImportPreview.to_dict`), `backend/app/library_exchange/operations.py:398` (`_change_summary`), and `frontend/src/components/LibraryExchangeSettings.tsx:81` (preview rendering).

The original preview exposed incoming snapshot metadata and a generic conflict reason without comparing the affected state. The revised preview carries the local lineage alongside both snapshot identities and a per-table durable-state comparison. The comparison uses the immutable local backup already used for the preview and the verified private incoming backup; multiset differences retain duplicate-row counts and use the same durable-value exclusions as the exchange digest. Saved preview reload preserves the comparison fields.

The UI now shows local/incoming lineage and snapshot identities, a Greek-labelled difference table before the replacement confirmation, and an explicit explanation that an edited row counts on both sides. The existing confirmation bound to the local digest and verified conflict archive remain intact. `backend/tests/test_desktop_review_regressions.py:149` adds a divergent-tag regression that checks both counts and persisted preview reload; it was source-inspected here and is included in the integration owner's running backend verification. No heavy tests were started by this reviewer. The code/spec gap is closed; final rendered/native validation remains a separate acceptance requirement.

## Findings corrected during this review

| Severity | Finding and original evidence | Current disposition |
| --- | --- | --- |
| HIGH | Logical root validation accepted relative paths and overlapping descriptors: `backend/app/library_exchange/manifest.py:34`. Such an archive could pass inspection and activate a generation that desktop configuration then rejected. | `normalized_roots` now calls the shared strict `parse_mappings` validator. Independently reran a tiny source fixture: relative logical root rejected. |
| HIGH | An otherwise valid unrelated-lineage replacement could retain old device mapping A(`/Music`) and append incoming mapping B(`/Music`), then fail every restart in `backend/app/desktop_runtime/config.py:38` after the active pointer had changed. | Shared `reconcile_mappings` now preserves bindings only for an exact root key and descriptor; desktop configuration retains inactive bindings separately for rollback. Independently reran the complete temporary A/B exchange replacement: incoming B opens Settings and previous A binding remains available for rollback. |
| MEDIUM | Failed native import helpers immediately restarted and cleared their diagnostic: `native/src-tauri/src/lib.rs:205`. The old library reopened without a persistent import failure outcome. | Source now keeps the Greek diagnostic visible until explicit Retry or exit. This preserves evidence instead of routing around the failed import. Native failure-path verification belongs to the integration owner's final native check. |
| HIGH | Deno adoption reads a sibling JSON contract that was absent from the frozen data list: `backend/app/desktop_runtime/adoption.py:31`, `backend/packaging/desktop.spec:12`. | The JSON is now explicitly included in PyInstaller data and Python package data; the build wrapper checks its presence. Final frozen-artifact adoption validation remains required after rebuilding. |

The A/B reproduction used only new temporary databases and archives (about 3.5 MB total). Before the fix it printed: pointer changed `True`, conflict branch archived `True`, then configuration rejected overlapping logical roots. After the fix it confirmed that the valid replacement opens Settings and retains the previous binding. Temporary fixtures were removed automatically. No real catalog or source audio was opened or changed.

## Supporting source findings

- Launch authentication uses a launch-specific HttpOnly, SameSite=Strict cookie; exact Host and mutation Origin checks wrap the ASGI stream. Explicitly foreign safe-request provenance is rejected while omitted media provenance is accepted. Health uses a separate authenticated header. Proxy-header trust is disabled.
- The HTTP renderer has no Tauri capability grant. Native requests use fixed actions and correlated records; unknown exchange previews fail before helper execution. The complete HTTP response precedes intentional shutdown; the helper re-verifies the private archive and owns pointer switching.
- Exchange snapshots reuse the existing paired backup implementation. Active datasets use an OS lease, and application maintenance tracks complete HTTP/job operations rather than only job submission. Imports verify checksums, schema, durable digest, preview freshness, and lineage before switching generations; explicit conflict replacement archives the local branch.
- Desktop routes and UI guard the agreed web-only analysis/provider workflows while retaining stored results and local identity operations. Desktop PWA registration is disabled, and preferences hydrate from app-owned storage before React render; failed preference writes remain visible and retryable.
- Python dependencies remain shared, with an isolated frozen core and explicit analysis exclusions. Source-path resolution confines media/tool reads to mapped roots and preserves logical paths. Rust owns child process trees; Python remains the sole dataset/pointer owner.

These are inspected implementation properties, not claims that every screen or platform has passed runtime acceptance.

## Validation boundaries

Reviewer-executed: dirty-tree/diff inspection, targeted source and pattern inspection, `git diff --check` (passed), and the tiny before/after root fixtures above. The requested `lsp_diagnostics` and `ast_grep_search` tools are unavailable in this session; neither was silently claimed. No heavy test/build was run because the integration owner serialized those checks after a memory-pressure crash.

The integration owner supplied earlier results of 614 backend tests, 67 frontend tests, 17 native tests, empty-PATH packaged HTTP startup, and six-codec native playback. Those results were not independently rerun here and predate some final changes; they do not certify the current rebuilt artifact. Strict seek, full UI/link behavior, final packaging, and the full retained-screen native matrix remain owned by the integration acceptance run. Windows/Linux/Intel Mac, clean-machine installation, distribution signing/notarization, and performance measurements must remain explicitly unverified until their own evidence exists.

Stop condition for this lane: all concrete findings have been corrected and source-rechecked; the root-mapping fixes also passed the independent bounded before/after fixture. Attach fresh final-source/artifact verification before treating the migration as fully accepted. This lane makes no architectural or cross-platform release verdict.
