# Canonical metadata / Identity v1 results

Implemented in the existing identity catalog. Scorer and original candidate evidence remain unchanged. No audio, original track tags, source snapshot rows or remote services were modified.

- Promoted **2,031** HIGH_CONFIDENCE links; **424** blocked by component guards.
- Acceptance ledger: 247 human, 1012 deterministic/existing, 2031 automatic. Existing confirmed_at dates and original evidence retained.
- **19,824** recording groups, including 2,461 with multiple representations.
- **376 local files** now display different canonical artist/title values. 5,721 recording groups remain in metadata review; 14,103 have derived preferred metadata (including unchanged/provider-only values).
- 8,948 artist entities and 23,559 ordered artist credits. Spotify artist URIs preserve structured boundaries; band names are not split when one URI represents the band.
- All **49,870 positions in 1,012 collections** retained, including repeats/unavailable entries. Memberships resolve through the entity’s canonical recording reference.

| Local files linked to | Before | After |
|---|---:|---:|
| SoundCloud | 545 | 1516 |
| Spotify | 65 | 642 |
| Both | 65 | 441 |

## Pattern report

Occurrences below cover local/SoundCloud observations. Corroboration is exact normalized metadata agreement with an accepted Spotify identity. This is an observational agreement measure, not held-out human precision. Missing provider evidence is excluded from the denominator. Broad rules are not enabled merely because identity matching was validated. Corroborated rows use the preferred source; unmatched rows remain reviewable.

| Pattern | Occurrences | Corroborated / tested | Agreement | Applied recording groups |
|---|---:|---:|---:|---:|
| bpm_annotation | 888 | 132 / 165 | 80.0% | 108 |
| collaboration_credit | 1498 | 240 / 376 | 63.8% | 182 |
| artist_inside_title | 4485 | 668 / 962 | 69.4% | 660 |
| promotional_noise | 873 | 47 / 104 | 45.2% | 47 |
| label_as_artist | 575 | 119 / 169 | 70.4% | 119 |
| remixer_credit | 867 | 43 / 68 | 63.2% | 37 |
| duplicated_artist_in_title | 1092 | 278 / 334 | 83.2% | 278 |
| leading_track_number | 570 | 59 / 77 | 76.6% | 59 |
| catalogue_annotation | 27 | 3 / 7 | 42.9% | 3 |

Examples and complete evidence are in `results.json` and the review UI. One verified end-to-end example is **Captain Hook & Astrix — Bungee Jump**: separate primary/collaborator credits, SoundCloud counters and Spotify Account 2 Likes, discoverable under Astrix’s collaborations.

## Use and acceptance policy

- Open `/library` for canonical display/search and the selected-track provider card. Original metadata remains available in the file-backed profile editor.
- Open `/canonical` for proposals, source differences, structured credit editing, and artist role filtering. Accept/Edit/Reject/Keep local write only local canonical tables.
- Bulk pattern acceptance requires 10 distinct explicit human acceptances (or every row in a smaller group); repeats, edits and bulk decisions do not count as sample acceptances. Any rejection/keep-local decision blocks the group.
- Identity promotion checks original hard flags, near ties, independent metadata score, historical rejections, cross-component version/remixer/duration/artist conflicts, and conflicting ISRCs. Different catalogue IDs may coexist when safe. Neighborhood cannot independently qualify a link.
- Every accepted link records source, score, method, evidence, time and acceptance mode. `POST /api/identity/canonical/revoke-identity` with left_id/right_id revokes an automatic link and replays the remaining ledger; existing human/deterministic decisions are protected. Alternative accepted paths can keep a group connected.
- Metadata decisions are logged with before/after values. Keep local restores local artist/title/version/release without touching files. Original observations and the full pre-promotion backup remain available.
- `build_identity.py` refuses to replace a DB containing the durable acceptance ledger. Future candidate refreshes must build separately and preserve canonical decisions.
- Popularity is exposed as raw source counters; no unsupported obscurity/personal-love metric was introduced. Alternative provider releases remain in source detail.

## Validation and paths

- 71 targeted tests pass: legacy scorer/calibration, parser, search, promotion/revocation, cross-component guards, artist boundaries/roles, isolated API review and bulk gates. Frontend build passes.
- Live browser: structured Bungee Jump credits, artist role filter, Library provider card, ordered 20-slot proof collection; zero browser errors and zero write requests during browser verification. Review writes were tested on temporary databases.
- Source entity observations, original candidate rows, collections and memberships match pre-change hashes. SQLite integrity and foreign-key checks pass.
- Existing Vite native-config warning and Starlette/httpx deprecation remain.
- Canonical DB: `backend/data/identity.sqlite` (additive tables). Main file catalog: `backend/data/cratemind.sqlite` (unchanged by this implementation).
- Pre-change backup: `/Volumes/6937130292/Projects/Music-ReORG/CrateMind/reconciliation/identity/canonical/before-20260915T134210Z.sqlite`
- Metrics/pattern examples: `reconciliation/identity/canonical/results.json`.
- Test evidence: `reconciliation/identity/canonical/tests.xml`; browser captures: `review.png`, `library.png`.
- Runner: `reconciliation/promote_canonical.py`; progress: `reconciliation/CANONICAL_TODO.md`.
