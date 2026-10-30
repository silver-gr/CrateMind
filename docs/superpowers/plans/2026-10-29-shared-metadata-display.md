# Shared Metadata Display and Visual Follow-ups Plan

## Objective

Show consistent clean title/artist/BPM throughout the shared web/desktop UI, preferring usable provider evidence under the user's more permissive matching policy while preserving manual decisions and raw source data. Add the exact Iridescence preset, soften Faulty Terminal, center candidate BPM/key columns and align canonical metadata card styling. Answer native title-bar customization possibilities without changing its design unasked.

## Data and cleanup boundaries

- Read-only projection, no source audio/tag mutations, database-wide rewrite or provider network jobs.
- Manual canonical human/kept-local/rejected decisions retain precedence; never erase original values or identity-block/rejection records.
- Clean deterministic title noise independently of uncertain performer identity, preserving meaningful remix/edit/version text.
- Fill invalid/absent artists from plausible track-level metadata; fallback uploader evidence is explicitly inferred and must not replace a meaningful artist.
- Treat explicit misplaced numeric tempo as metadata, preserving manual BPM override and avoiding silent half/double-time conversion.
- Keep shared derivation at API/recording projection boundaries so lists, details, sets, suggestions, collections and player agree.
- No production/desktop build or automatic commit requested this round; use focused tests and current web runtime.

## Execution lanes

1. Audit current metadata rules and specific examples in paired web/desktop databases, read-only; share rules with user before implementation.
2. Implement field-level projection and provenance; route display payloads through it with bulk/bounded queries, preserve canonical review decisions and raw fields; test examples and representative endpoint agreement.
3. Lower identity/link thresholds with explicit named policy, retain conflict/near-tie/manual-rejection guards; test valid imperfect candidates and false-match controls. No live identity ledger mutation.
4. Implement Iridescence via pinned official sources and existing lifecycle; lower Faulty Terminal opacity; shared surface and compact column alignment fixes.
5. Verify focused backend/frontend tests, API examples, live browser theme/background/metadata surfaces, and document unbuilt desktop status.

## Acceptance examples

- Epsilon [202] -> Epsilon, explicit BPM202.
- Itaf Roma [170] / artist1 -> Itaf Roma / inferred Marambá from agreeing providers; BPM170.
- Synchronicity City 3.0 / artist1 -> inferred globular with weak-source provenance.
- Babaji inifinite meaning / artist280 -> no fake artist280, explicit BPM280 rather than analyzed140.4; never use unrelated uploader as performer.
- Strip tempo/catalogue/VA compilation wrappers while retaining semantic remix names and significant title numbers such as3.0.

## Completion evidence

- Shared projection implemented at all listed API/read-model boundaries, with proposal/editor and artist-search consistency.
- Provider linking now uses shared coverage-oriented thresholds; local scanner duplicate suppression remains strict.
- Full backend765passed; frontend154passed; TypeScript and whitespace checks passed.
- Live web checked globular search/Synchronicity and Epsilon cleanup, Iridescence dark/light and reduced-motion, Faulty Terminal opacity, and compact BPM/key alignment.
- Source changes are uncommitted and the desktop bundle was not rebuilt. Matching policy applies to subsequent rescoring; no current acceptance ledger rewrite.
