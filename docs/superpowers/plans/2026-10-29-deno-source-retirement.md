# Legacy Deno source retirement

Authorized scope: retire the repository's `desktop/` implementation and its run
instructions. The supported desktop host is Tauri in `native/`.

1. Inspect every file under `desktop/` before removal. The inventory contains 63
   tracked source/config/test files plus 13 ignored macOS and old `.omc` state
   files; no databases, audio, backup archives or symlinks were found.
2. Preserve exact copies of the legacy schema and migrations as dedicated test
   fixtures, with original paths, commit and SHA-256 provenance. Keep the shipped
   Deno schema contract and legacy importer unchanged.
3. Point adoption tests at those fixtures; remove the inspected `desktop/` tree
   and update current documentation. Label the old Deno experiment guide as
   historical; historical plans and evidence may retain their original paths.
4. Run focused adoption tests using generated temporary databases/audio, confirm
   fixture hashes still match the shipped contract, inspect remaining source
   dependencies and check whitespace.

No app-data directories, real databases, music, backups or installed applications
are changed. No app launch, packaging rebuild or commit is part of this lane.

## Verification

- `cd backend && uv run pytest tests/test_desktop_adoption.py -q`: 14 passed.
  All source catalogs and audio for these checks were generated in temporary
  directories; coverage includes versions 1–3, WAL, source immutability, unknown
  schemas, interrupted publication, directory safety and CLI adoption.
- Both fixture hashes match the unchanged shipped Deno contract; the importer
  and contract remain byte-for-byte identical to `HEAD`.
- `desktop/` is absent. Remaining references to its source paths are historical
  docs or schema provenance; no runtime or CI source dependency remains.
- Scoped `git diff --check` passed.
