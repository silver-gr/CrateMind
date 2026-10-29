# Retired Deno schema fixtures

`schema.sql` and `migrations.ts` are byte-for-byte copies of the last legacy
`desktop/src/db/` sources, preserved before that application was retired on
2026-10-29. `provenance.json` records their original paths, source commit and
SHA-256 values. The adoption test verifies both files against the unchanged
shipped `app/desktop_runtime/deno_schema_contract.json`.

These files generate temporary SQLite fixtures for migration versions 1, 2 and
3. The TypeScript file is retained only as historical schema evidence; it is not
an application entry point. The version-2 SQL block is extracted by the test,
and version-1/2 fixture construction removes the later BPM-consensus columns.

The bounded legacy-data importer remains supported in the shared Python backend.
Its original source paths in the contract describe provenance and are not
runtime dependencies. Never replace these fixtures with user databases or music.
