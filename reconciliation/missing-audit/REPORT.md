# Missing-file and duplicate cleanup

Checked /duplicates before the missing catalog. Removed all 378 missing rows after confirming existing copies; 4781 catalog entries remain, all paths resolve. No source audio deleted.

Saved two profiles, one set entry, eleven SoundCloud matches, eleven candidates and 54 fingerprints on surviving IDs. Source/collection entity IDs retained, playable asset references redirected. Foreign-key checks passed.

Five stale review groups resolved; one missing/live group still has two surviving copies. 66 older live-file deletion candidates prepared; 12 groups with inconsistent artist/title/version metadata retained for review. Ordering uses modification time, then creation time.

Backup: /Volumes/6937130292/Projects/CrateMind/reconciliation/missing-audit/backup-20260920-003138

Files: plan.json (complete mappings), deletion-candidates.csv (optional removals), duplicate-review.json (unresolved groups). Run delete_existing_duplicates.py without arguments to preview; --delete explicitly deletes the reviewed 66 audio files after checking that both files still exist with unchanged sizes/timestamps. The script has NOT been executed with --delete.
