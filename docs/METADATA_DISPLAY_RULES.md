# Shared metadata display rules

The API projects clean display values without rewriting source tags, music files, observations, or provider identity acceptances. Raw artist/title and inference provenance remain available alongside the displayed fields. The shared projection is used by library/search, track details/player, sets and analysis, recommendations, duplicates, BPM review, canonical views, identity lists, collections and recovery.

## Precedence and cleanup

1. Preserve explicit canonical human, kept-local and rejected decisions exactly. Manual BPM selection remains first.
2. Clean unambiguous BPM, catalogue/label and compilation wrappers independently of artist confidence. Preserve meaningful title numbers (`3.0`) and remix/edit/version text.
3. Use the existing artist/title parser for duplicated artists or label-as-artist wrappers only when the parsed performer is meaningful and the current artist is weak, label-like or agrees with that performer. Do not split arbitrary dash titles with a different meaningful artist.
4. Remove orphaned leading credit separators such as `& MinDelve`; do not split compound artist names solely on the word `and`.
5. Fill empty, numeric, unknown or label-like artists from accepted track-level performer metadata or guarded provider candidates. Candidate display inference requires score65, title similarity.95, duration difference at most6 seconds and margin5 over a different competing identity. Rejections, revocations, near ties and meaningful conflicts remain barriers.
6. A SoundCloud uploader can be an explicitly inferred display fallback under those conditions. It is not automatically a performer or an accepted identity. A numeric artist corroborated as tempo does not get replaced by the uploading account.
7. Recover explicit title tempo annotations up to400BPM. A numeric artist may provide tempo when octave-corroborated by analysis; it is not displayed as an artist. BPM precedence is manual override, actual BPM tag, recovered metadata hint, consensus, analysis. Do not silently halve an explicit280BPM hint to match140.4 analysis.
8. Canonical proposals/editors use the same projected fields for nonmanual records, retaining the original proposal and observations. Persistence happens only through explicit review actions; the chosen proposal is then saved so later reviews cannot revert to stale fields.
9. Search validates narrowly seeded inferred/parsed artist matches through the same projection; it does not rewrite stored search indexes.

## More permissive provider linking

These are ranking scores, not probabilities.

- Automatic eligibility: score70, title similarity.85, artist similarity.45, duration difference at most12 seconds.
- Weak artist alternative: score65, title similarity.95, duration difference at most6 seconds, with independent performer or parsed performer evidence. Uploader-only evidence cannot create an automatic identity link.
- SoundCloud review: combined score.50, title similarity.50, duration difference at most15 seconds or unknown.
- Preserve manual decisions, rejection/revocation history, near ties, version/remixer differences and ISRC conflicts. New links also check all members of joined identity components.
- Local-file duplicate suppression retains the stricter original requirements (score89/title.9/artist.8/duration6); permissive provider association must not make scanning skip distinct audio files.

Changing policy does not rescore or rewrite old candidate/acceptance rows. Their classification changes on a subsequent matching run. Current display projection can use already-stored candidate evidence without accepting those identities.

## Verified examples

| Stored metadata | Shared display |
| --- | --- |
| `& MinDelve — Epsilon [202]` | `MinDelve — Epsilon`,202BPM |
| `1 — Itaf Roma [170]` | `Marambá — Itaf Roma`,170BPM, provider evidence |
| `1 — Synchronicity City 3.0` | `globular — Synchronicity City 3.0`, inferred uploader provenance |
| `280 — Babaji inifinite meaning`, analysis140.4 | artist unknown, explicit280BPM; uploader is not substituted |
| `The Mother Load [170] (OVNI RECORDS 08)` | `The Mother Load`,170BPM |
| `We Are Gods (Shrinkhead Remix) (195 Bpm) V.A AQUARIUS Vol.1` | `We Are Gods (Shrinkhead Remix)`,195BPM |

2026-10-29 verification:765 backend tests,154 frontend tests, TypeScript, read-only comparisons on current web/desktop catalogs and live web display/search checks. No database-wide rescore, source-file edits or packaged desktop rebuild was performed in this pass.
