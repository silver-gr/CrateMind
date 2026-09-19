# Actual metadata flow — implementation baseline

Verified on the current live SQLite schema and source. All 4,748 local rows have title/artist; 4,747 have artist_normalized. The displayed values are not untouched embedded tags.

- `metadata_reader.read_tags` cleans tag values, parses artist-title wrappers, infers from filename, and supplies title/artist/label/BPM/album hints. `scanner._read_embedded_record` applies folder fallback and derives the primary artist key. `_apply_columns` persists these fields directly in `tracks`, including during re-cleaning. No audio retagging is needed or performed here.
- `tracks.artist_normalized` is a primary-artist lookup key, often dropping collaborators; it is not a full canonical credit. The existing artist normalizer also limits characters. It must not replace multilingual artist text for matching.
- `artist_profiles` has 1,637 records. `canonical_name` is rebuilt from the most frequent primary-artist spelling; it is persisted separately. Its aliases and review flags are supporting evidence, not universal corrections of every track title or collaborator.
- `api/tracks._track_payload` / `_list_payload` serialize stored metadata and attach artist_prefill, DJ profile and accepted SoundCloud metadata. They do not replace title/artist with another hidden canonical track representation.
- `TrackTable`, `ProfileEditor` and `MiniPlayer` display `title || file_name` and `artist`; no separate frontend-only metadata cleaner exists. Artist profile names appear as prefill context.
- Representative row 1 has artist `Crone & Oroboro`, primary key `crone`, and title `Fat Rhino [196bpm]`. Row 3 has a suspicious persisted title `Mastered by Calabi Yau (FREE DOWLOAD)` while its filename contains a stronger track/version hint. Thus persisted cleaning is useful but not infallible.

Implementation uses persisted full title/artist first, adds canonical primary artist/aliases as alternatives, reuses `metadata_reader.infer_tags_from_filename` for filename/title parsing, and retains source fields plus normalization evidence. Semantic remix/edit/live/remaster terms and original wording survive. No fresh audio scan or metadata write is performed.

## Orchestrator correction applied

The shared implementation now delegates identity text keys and token overlap to `services.soundcloud`, and both matching flows use its duration/weighted-score primitives. The established SC formula (0.55 title + 0.30 artist + 0.15 duration), thresholds, stored decisions and review endpoints remain unchanged. A regression fixture preserves the approximately 0.816 pending example and its exact reasons.

Primary database artist evidence cannot be overridden by a contradictory supplemental filename/profile alias. Matching variants remain explained derived evidence, not replacement canonical fields. The unified page reads the current track API and reuses `SoundCloudCard` for the existing decisions/candidates. The separate identity database is a rebuildable source/collection projection, not the authority for manual SoundCloud decisions.
