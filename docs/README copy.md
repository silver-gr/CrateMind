# CrateMind music-library handoff

## Start here

Open this folder in the existing Codex/CrateMind workspace and send **`CODEX_START_HERE.md`** as the task prompt. The complete history is **`2026-09-14-cratemind-music-library-recovery.md`**. Feature proposals and scope choices are separate in **`ROADMAP_AND_IDEAS.md`**.

The next task is a **read-only integration preview**, with local audio, SoundCloud and Spotify represented together. It is not permission to migrate the production database, modify audio, delete cloud content or publish playlists.

## Package contents

| File/folder | Purpose |
|---|---|
| `2026-09-14-cratemind-music-library-recovery.md` | Full task/session report, evidence, user corrections, next steps and risk register |
| `CODEX_START_HERE.md` | Executable task brief and acceptance gates for the next agent |
| `ROADMAP_AND_IDEAS.md` | Prioritized development plan and nine scoped feature ideas |
| `SOURCES.md` | Portable evidence register and source limitations |
| `verification/` | Reproducible read-only audit, computed metrics, checksums and Spotify member inventory |
| `source-reports/` | Unchanged copies of Astra's supplied final reports and logs |

The original database, Spotify ZIPs, SoundCloud raw archive, tokens and browser profile are **not** bundled. Codex should locate the user's originals and compare hashes in `verification/input_manifest.json`.

## Where to save the session report

The user's reporting convention requests:

```text
/Users/silver/Projects/-HQ/docs-tasks-completed/2026-09-14-cratemind-music-library-recovery.md
```

This package was generated in the chat environment, which cannot write to that Mac path. Keep this bundle together for working links. When installing the report into HQ, also retain its companion files in a dated folder and adjust the report's relative links, or let Codex do that as a documentation-only step after inspecting existing HQ files. Do not overwrite an existing report without checking it.

## Important corrections carried forward

Spotify-only catalog entries are explicitly in scope. The 1,347 downloader album labels are only part of the local download history. The 545 accepted SoundCloud match rows map to 531 distinct remote IDs, and accepted does not mean every link was manually reviewed. The 353 Account-2 sequence count is not an approved collection count. Seven SoundCloud system playlists lack an independent declared count. These details are reflected in the reports and audit.
