# Desktop acceptance inventory

`acceptance.json` maps all 104 captured routes, 9 separately planned additions,
and all 21 `App.tsx` route entries to acceptance owners. The root is a redirect;
Smart Folders and Phrase Finder retain their current Coming Soon status. It
references the approved `f71dc17` baseline without pinning source handler names
or line numbers. Parameter names may change; path converters and methods may not.

Each behavior records an acceptance condition, existing test oracles, their
coverage boundary (`api`, `service`, `partial`, `future`), and outstanding work.
Related service tests are leads for differential acceptance, not evidence that
every associated handler is covered. Task 11 owns web/desktop differential
behavior; Tasks 5/16/17 own actual WebView media and installed UI evidence.
Inventory success never establishes functional or installed-artifact parity.

`catalog_state.json` contains synthetic Greek metadata, stored analysis/provider
provenance and local identity decisions. Tests generate WAV files and private
SQLite catalogs, exercise cue/tag/profile/set/pair-note/play mutations, reopen
state, and check audio bytes and mtimes. No user catalog, credentials, downloaded
audio or provider requests are needed. The identity fixture reuses the existing
canonical/manual-identity test builders and services.

From the repository root:

```sh
python3 scripts/desktop/check_parity_inventory.py
cd backend
uv run python ../scripts/desktop/check_parity_inventory.py --runtime web
uv run pytest tests/test_desktop_contract_inventory.py
```

Once the profile factory exists, `--runtime desktop-core` checks its registered
routes. The comparison function also accepts `web-enrolled` route lists for
the later enrollment task's fixtures. Planned routes are allowed before their implementation; their absence
does not pass their later task acceptance. Deferred desktop routes may be absent
or registered as feature-unavailable stubs; status/body/guard tests remain the
profile owner's responsibility.

`GET /api/desktop/health` is separately classified as an internal authenticated
native-supervisor readiness endpoint, outside the public 104+9 inventory. Other
undeclared endpoints still fail runtime comparison, including hidden routes.

Runtime discovery uses a child process with temporary catalog/identity/output/
backup/library paths, `.env` loading disabled and outbound socket connections
blocked. It imports the app but never enters its lifespan or calls handlers. This
keeps the checker usable before packaging and avoids scans or launch backups.
