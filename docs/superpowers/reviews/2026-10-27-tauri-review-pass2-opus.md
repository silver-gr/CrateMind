Reviewer: Claude Opus 5.5 (returned model: claude-opus-5-5)
Requested effort: xhigh
CLI result: success; 0 permission denials; no fallback configured.

# Tauri desktop migration plan — review pass 2

I checked the revised plan, design and route baseline against the code at the working tree. This is a read-only review: I ran no builds, tests, packaging or database operations, and I skipped the devchain skills step because those tools aren't available. Findings marked **Demonstrated** cite code or spec text; anything I couldn't confirm is marked **Unverified**.

**Pass-1 fixes confirmed:**
- Calibration is deferred. I recounted the routes: 104 = 92 kept + 12 deferred.
- The shared maintenance gate and dataset lock are in, and they use the existing backup lock only once.
- M3U export and "reveal in folder" now translate paths per device.
- The desktop build turns off the service worker.
- Re-exporting unchanged data reuses the previous snapshot.
- Tool lookup and resource staging come early (Task 3).
- The preference and theme files are all listed.
- Artwork/waveform caches are per dataset generation.
- Export folders are confined.

I don't raise any of those again.

**Verdict: not ready to execute.** There are 3 P1 and 3 P2 blockers. All of them can be fixed in the plan without new architecture.

---

## SECTION 1: BLOCKERS & CONFLICTS (Must Fix)

### 1. [P1] Nothing defines which identity edits count as "provider-specific" — Demonstrated
- **Evidence:**
  - Task 2 (`plan:108`) and the design (`design:75`) say to block provider-specific identity edits and allow local ones. The baseline marks every kept identity POST route as plain "keep" with no guard field (e.g. confirm-identity at `baseline.json:367-374`, revoke-identity at `:239-246`).
  - The handlers make no local/provider distinction:
    - `confirm-identity` and `undo-identity` accept any pair of entities, then replay SoundCloud links into the catalog (`backend/app/api/identity.py:311-342`, `backend/app/services/manual_identity.py:89-97`).
    - `IdentityLinker.tsx:10,66` is the only linking screen, and it offers local, Spotify and SoundCloud sources.
    - Scans also replay those links and recompute local↔provider match candidates (`scanner.py:384-388`, `identity_sync.py:110-122`).
- **Consequence:** Implementers will guess. If they block too much, desktop loses canonical/collection decisions, which you require to travel both ways. If they block too little, desktop does provider matching, which you kept in the web app. Tasks 2, 7 and 11 can't be tested consistently.
- **Fix:** Add a per-route guard field to the baseline. My recommended policy:
  - **Block** confirm-identity, reject-identity, undo-identity and canonical/revoke-identity when either side is not a local file.
  - **Allow** canonical metadata decisions and pattern-accept, consolidation, lineage, recovery states, native collections, saved algebra/priority views and retire-asset.
  - **Explicitly allow** replaying links that were already decided, and the automatic candidate refresh during identity sync. Both only derive from existing decisions.
  - IdentityLinker on desktop shows only local candidates.
- **Acceptance:**
  - The Task 1 inventory test fails if any kept mutation route has no guard value.
  - On desktop, linking and undoing local↔local succeeds. Local↔Spotify/SoundCloud link, reject, undo and revoke get the standard "unavailable" response.
  - Canonical and consolidation decisions round-trip in the A→B→A exchange fixture.
  - Web behaviour is unchanged.

### 2. [P1] Schema changes at startup cause false conflicts and run without a backup — Demonstrated
- **Evidence:**
  - Both web and desktop migrate the database before taking their launch backup (`backend/app/main.py:27-29`, `db.py:70-149`).
  - Identity tables are created lazily by individual services (`library_completeness.py:147-148`, `collection_consolidation.py:29`, `canonical_library.py:118`).
  - The state fingerprint covers every table and column in a fixed order (`design:190`). Only import-time migrations are protected from counting as edits (`design:200`).
  - The schema version is a plain integer with no rule for how it's set (`design:181`).
  - The plan expects the provider refactor to land in the web code during this migration (`plan:356`).
- **Consequence:**
  - A `git pull` plus restart of the enrolled web app adds a column, which changes the fingerprint with no user edit. The next desktop→web import is then refused as a conflict. A desktop app upgrade does the same.
  - Those startup migrations run without a backup of both databases taken first.
  - A hand-bumped version number will drift. It will either let an older desktop import a newer schema or block valid pairs.
- **Fix:**
  - Make the fingerprint ignore purely additive schema changes: a missing table counts as empty, and a missing column counts as NULL.
  - Derive schema compatibility automatically from both databases' table definitions. A bundle is compatible if everything in it is known to the importer.
  - For enrolled datasets, back up both databases before any startup migration that changes the schema.
  - Any migration that rewrites data must record an explicit new baseline while holding the dataset lock.
  - An older desktop build shows a clear Greek "needs a newer version" message.
- **Acceptance:**
  - Export S1, add a column/table in web code and restart; desktop→web import of S2 is still accepted.
  - A newer-schema bundle sent to an older build is refused with that message.
  - The pre-migration backup exists.
  - A test fails if the models change but the schema fingerprint does not.

### 3. [P1] The web app can't actually join the exchange, and web-side scripts bypass the dataset lookup — Demonstrated
- **Evidence:**
  - Exchange requires enrollment (`design:145`), and the "first authoritative installation" assigns the lineage (`design:196`).
  - But the Task 15 command-line tool only offers export/inspect/import, and its export takes raw database paths (`plan:279`). There is no enroll command.
  - Task 9 adopts "existing Python data" (`plan:199-204`). That data lives under the repo, as configured in `.env` (`config.py:10-22`), so an installed app can't find it on its own.
  - The web-side Spotify/identity scripts hardcode `backend/data/*.sqlite`: `reconciliation/build_identity.py:260,270`, `calibrate_identity.py:246,256`, `preview.py:342`, `audit_consistency.py:23`, `validate_consolidation.py:57`.
  - Other scripts go through config (`promote_canonical.py:13-16` → `identity_library.py:13-21`).
  - None of these scripts take the dataset lock.
- **Consequence:**
  - Nothing says whether desktop adopts first or the web enrolls first. Web edits made after desktop's snapshot end up stranded in the old, retired database.
  - There is no Spotify API route (`baseline.json:844`), so Spotify data enters through these scripts. After enrollment they write the old database, so provider state never reaches the exchange. That breaks your "provider state both ways" requirement.
- **Fix:**
  - Add one shared **enroll** command to the CLI. It takes the lock, backs up both databases, restores them into a new dataset folder and creates the first lineage snapshot (S0). It then writes the active-dataset pointer file (`active.json`) and prints the `CRATEMIND_DATASET_ROOT` value to set.
  - Enroll leaves the originals untouched and writes a small marker file next to them, so the old unenrolled command refuses to start.
  - Make the web the first authoritative install; desktop then imports S0.
  - Put the dataset lookup in `config` / `identity_library.database_path`, not only in the server startup code, so scripts pick it up too.
  - List every script entry point that writes data. Route each through the lookup and require the lock (web server stopped), or document it as read-only.
- **Acceptance:**
  - On a test copy: enroll → export S0 → desktop import → desktop edit → return → restart the web with its normal command → the edits are visible through the API.
  - Each kept provider/reconciliation script that writes changes the active generation, and is refused while the web holds the lock.
  - The old unenrolled command refuses to start on an enrolled database pair.

### 4. [P2] Rust and Python both claim ownership of `active.json` — Demonstrated
- **Evidence:**
  - The design says Rust owns switching the active pointer (`design:120`). The startup record passes resolved database paths, so Rust must read the pointer itself (`design:91-98`).
  - Meanwhile, the Python lookup (`design:145`), Task 2 (`plan:106`), Task 9 (`:204`), Task 13's import and recovery functions (`:254`) and the Task 15 web CLI all read, switch and recover the pointer in Python.
  - The design also says Rust doesn't open the SQLite databases (`design:28`).
- **Consequence:** There would be two crash-safe pointer-switch and recovery implementations, each with its own Windows behaviour. Paths passed in by Rust can also trip the lookup's "reject conflicting explicit paths" rule.
- **Fix:**
  - Python (the server and the bundled helper mode) is the only code that reads or writes `active.json`, the exchange state file and in-progress records.
  - The startup record carries only the app-data folder, resources and tools.
  - Rust just orchestrates stop → helper → restart and reads the helper's result. `storage.rs` handles only the app-data location and single-instance.
- **Acceptance:** Rust has no code that writes `active.json`. Kill-during-switch tests pass with the single Python implementation, on both the desktop and CLI paths.

### 5. [P2] After a refused conflict there is no way forward — Demonstrated gap
- **Assessment:** The one-way-at-a-time handoff limit is clearly stated and safe: there's no silent merge and no "last writer wins" (`design:170,198`; `plan:258,285`). But both documents only promise an "actionable report", and no action is defined.
- **Consequence:** Under the plan's own rule that scans count as edits (`design:192`), a single scan or play log on each side diverges the two copies permanently. Neither copy can then accept the other's snapshot.
- **Fix:** Add one explicit, non-merging action on each side: "Αντικατάσταση με την εισερχόμενη έκδοση" (replace with the incoming version).
  - It requires confirmation, and the local copy stays available for rollback.
  - It also writes the local state out as a conflict `.cmexchange` file, then continues the lineage from the incoming snapshot.
  - Document it in Task 19, including that play logging and scans count as edits.
- **Acceptance:** Diverge A and B. The import is refused. Resolve on A. The next A→B handoff is accepted, and A's previous state can still be restored.

### 6. [P2] Desktop has no way to set library folders or map them between devices — Demonstrated gap
- **Evidence:**
  - Library folders come from `CRATEMIND_LIBRARY_ROOTS` in `backend/.env` (`Settings.tsx:236-240`, `config.py:20,71-78`), and desktop turns off `.env` loading (`design:100`).
  - Settings are cached at import (`config.py:102-104`), so a newly picked folder has no defined way to take effect.
  - Task 7 adds only a folder picker (`plan:178`). Task 10 says new folders need an explicit mapping (`:216`) but defines no UI or config format (`:210`).
- **Consequence:** On a second device, you can't map an imported library's folders to local ones, so playback, scanning and M3U export fail.
- **Fix:**
  - Define the folder and mapping format in `desktop-config.json`.
  - Add a Settings panel that lists the library folders in the active catalog, with mapped / unmapped / disconnected status in Greek. Each folder is mapped with the native picker.
  - Apply changes through a normal supervised backend restart rather than live cache resets.
- **Acceptance:** Import a fixture whose folders came from a different mount point. The panel shows the unmapped folder. Mapping it makes playback and M3U work. An unmapped folder shows its status and never triggers marking tracks as missing.

---

## SECTION 2: SIMPLIFICATION REQUESTS (Reduce Complexity)

1. **Bring existing web data into desktop through enroll + exchange import** (follows from Section 1, item 3). Keep Task 9's adoption only for Deno data and empty starts. This drops repo/`.env` discovery, the two-candidate Python flow and a second restore path.
2. **Defer porting the Deno JSON metadata import.** `desktop/src/api/importer.ts:1-6` shows its job was bringing web BPM/key and taste metadata into a scanned Deno library. The full exchange replaces that. Porting it adds a new shared route to both apps plus path-matching logic, and the Deno app (kept as fallback) still has it. This needs your sign-off because you asked to preserve features; if kept, register it on desktop only.
3. **Drop the Origin/Referer check on GET/HEAD requests.**
   - The session cookie exists only inside the app's WebView, and the exact-Host check already blocks DNS-rebinding attacks.
   - Keep the exact-Origin check on edits, and reject conflicting Fetch Metadata.
   - Whether the macOS and Linux WebView media stacks send Referer (or even the cookie) on audio range requests is **Unverified**. This removes a fragile dependency for playback.
4. **Remove the legacy browser-preferences import/export** (`plan:190`). It wasn't requested, it needs web-side UI, and the preferences are quick to set again.

---

## SECTION 3: SUGGESTED IMPROVEMENTS

- **[P2] Native menus and keyboard (add to Task 17):**
  - Include the standard macOS Edit menu; without it, copy, paste and select-all stop working in text fields once you add custom menus.
  - Menu shortcuts must not override the app's own (`Settings.tsx:582-603`: ⌘K, Space, J/K, digits, letters) or fire while typing in an input.
  - Turn off reload, devtools, the context menu and WebView2's browser shortcuts in production builds.
  - Check that Tab reaches buttons and links in the macOS WebView (**Unverified**; depends on a macOS keyboard setting).
  - Return focus to the triggering control after native dialogs, and label menus in Greek.
- **[P2] Test audio formats earlier.** Run the per-WebView MP3/FLAC/WAV/M4A/Ogg/Opus check (`streaming.py:18-27`) in the Task 5 spike, not Task 17. Ogg/Opus support on macOS 14 and Linux's GStreamer plugins are **Unverified**. A transcoding fallback would change seeking, tool load and the security policy, so it needs deciding before M3.
- **[P2] Where cross-platform runs happen.** Pushing is not allowed (`plan:26`), and this machine is macOS arm64 (`backend/.venv/pyvenv.cfg:1`). Tasks 5, 13, 17 and 18 still need Windows, Linux and Intel-Mac runs. Either name the VMs/hardware, or treat those runs as release gates and report them as untested.
- **[P3] Error message shape.** "Unavailable" and guard responses must keep `detail` as a Greek string plus a separate `code`. Existing UI code shows `detail` directly (`api.ts:39-43`, `Collections.tsx:26`, `CanonicalMetadata.tsx:17`, `CompletenessControls.tsx:5`), so an object would display as "[object Object]".
- **[P3] Task 7 file list** is missing `UnifiedLibrary.tsx` (calibration link at line 100, SoundCloudCard), `CanonicalMetadata.tsx` (IdentityLinker) and `ProfileEditor.tsx` (SoundCloudCard).
- **[P3] Task 1 inventory** needs a declared category for new routes (preferences, exchange, native actions, legacy import). Otherwise its "no unclassified route" check fails after Tasks 8, 9 and 14.
- **[P3] Scan churn across devices.** The "file unchanged" check compares file timestamps stored in shared rows (`scanner.py:352-356,262-263`). Test a second device with different file times, and decide whether `last_scanned_at` should be left out of the fingerprint.
- **[P3] Snapshot legacy databases from a copy.** The backup routine opens the source read-write (`backup.py:113-115`), and closing it rewrites the source file. Copy the database and its WAL files into private staging first, then snapshot; the acceptance check compares the source bytes.
- **[P3] Shutdown with audio playing.** Set the server's graceful-shutdown timeout below 8 seconds and stop audio before an import, so applying an import doesn't always end in a forced kill.
- **[P3] Remote SoundCloud artwork redirect** (`artwork.py:130-145`) needs a task that turns it off on desktop, as the design intends (`design:76`).
- **[P3] Task 3 self-test** should check that the bundled SQLite has full-text search (`db.py:53-57`), the JSON functions the identity queries use, and a version at least as new as the web's.
- **[P3] Docs:**
  - Tracks added on desktop need a manual "Μόνο νέα" (new tracks only) BPM/key analysis on the web after handoff; the web only auto-analyses tracks its own scans add (`worker.py:216-226`).
  - Set a retention limit for the full-copy baseline archives kept in app data.
- **[P3] App factory location.** Keep the app-building function in a module that doesn't create the web app on import. Otherwise importing `app.main` from desktop pulls in the BPM/key analysis libraries.

Blockers remain, so I'm not calling this ready to execute. Once Section 1 is fixed, a short third pass can confirm it.
