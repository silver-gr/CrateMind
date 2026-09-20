# Title tempo audit

Read-only comparison against stored `bpm_analyzed`; title values are reference claims, not verified ground truth. No files or catalog records changed.

{
  "created_at": "2026-09-20T13:51:27.783978+00:00",
  "catalog_total": 4715,
  "numbered_titles": 960,
  "title_types": {
    "explicit": 257,
    "other_number": 274,
    "bracketed": 380,
    "bare": 40,
    "range": 9
  },
  "relations": {
    "within_1_bpm": 649,
    "half_time": 7,
    "other_mismatch": 13,
    "near_1_to_3_bpm": 4,
    "two_thirds": 2,
    "double_time": 2
  },
  "strong_relations": {
    "within_1_bpm": 613,
    "half_time": 6,
    "other_mismatch": 11,
    "near_1_to_3_bpm": 3,
    "two_thirds": 2,
    "double_time": 2
  },
  "outside_current_range": 4
}

## Interpretation

Most catalog results were generated with a 135–250 BPM search range. The current 286 ceiling does not retroactively update them. Half-time and 2:3 relationships are metrical ambiguity, not small numeric rounding errors. ReccoBeats and consensus values are included separately in CSVs and are not used as the analyzer result. Bare title numbers are tentative. Repeated versions are counted as catalog entries, not independent recordings.

## Range / multi-tempo removal review

| ID | Artist | Title | File exists |
|---|---|---|---|
| 392 | Fuck The Rules! | 240-250bpm - Preview | True |
| 703 | Fat Freddy | Monk's Prayer 158-160 BPM | True |
| 886 | Hyperdrive 175 | 200 - 177bpm (FREE DOWNLOAD) | True |
| 2447 | Impertinent & MagnetikSadhu & Toadstool | Silence & Pain 173-200 (MASTERED BY KILLATK) | True |
| 3170 | Antagon & Limbertimbre | impossible 170-180bpm | True |
| 3269 | Mentalecho | Lilith [195-215] Out on V.A. Lindo Sonho Delirante | True |
| 3387 | Koktavy | Holy Mountain 200/230/170/??? [demoʍǝᴉʌǝɹd] | True |
| 3388 | Koktavy | Enter the Void [201-270-???] {demo sample} | True |
| 3875 | [HiTech Darkpsy Psytrance] Kokobloko | Swimming To The Unknown 175-180 Bpm | True |

The descending “200 - 177bpm” may be a title followed by a tempo, rather than a tempo change; inspect before removal. The 200/230/170 and 201-270-??? titles are multiple-tempo claims. None is automatically deleted.

## Mismatches (>1 BPM)

| ID | Artist / title | Title BPM | Analyzed BPM | Relationship |
|---|---|---:|---:|---|
| 1025 | No Time To Die (SpaceChimp & Kopophobia Remix) — 282 | 282 | 141.0 | half_time |
| 1155 | Mariama — 280bpm | 280 | 140.0 | half_time |
| 1255 | Hippie Killaz — Computer Sucks [206] | 206 | 221.94 | other_mismatch |
| 1327 | Popek vs LiinK — On the Road Again (170) | 170 | 172.0 | near_1_to_3_bpm |
| 1329 | Popek vs Eclipsical — Surfing Spot (170) | 170 | 175.0 | other_mismatch |
| 1533 | OxiDaksi — DabDub 175 Bpm: Hi-tech Psy Trance | 175 | 173.16 | near_1_to_3_bpm |
| 1623 | Paranoia Sector — Dogma Architect [182] | 182 | 167.2 | other_mismatch |
| 1717 | KillatΔk — Summer Jam (193Bpm) | 193 | 195.02 | near_1_to_3_bpm |
| 1783 | Vibration & Synthex — Retrotown (Edit) 💀+180💀 | 180 | 181.98 | near_1_to_3_bpm |
| 1899 | Quite Contrary — 320bpm | 320 | 160.0 | half_time |
| 2385 | KNOWER — THE GOVT. KNOWS (MD RMX) { 264BPM } | 264 | 176.0 | two_thirds |
| 2422 | Pettra — Spiritual Journey [185 BPM] (Mímico Bootleg) | 185 | 176.4 | other_mismatch |
| 2475 | K Freq — Intro to my Life (98) | 98 | 196.02 | double_time |
| 2484 | Flashback — 294bpm | 294 | 147.0 | half_time |
| 2689 | Unknown Artist — Break Through(185) | 185 | 170.0 | other_mismatch |
| 2701 | Unknown Artist — SMASH 1 HOLYBLASTER {KAMEAMEHAAA} (180 BPM AnübisX) | 180 | 199.68 | other_mismatch |
| 2757 | Unknown Artist — Hitech side of Life [±210] | 210 | 196.78 | other_mismatch |
| 2769 | Unknown Artist — Well... At Least I ́ve Tried [270] | 270 | 135.0 | half_time |
| 2880 | KopoMindChimp — 268 | 268 | 195.02 | other_mismatch |
| 2987 | Billie Eilish — No Time to Die (KopophobiA & SpaceChimp RMX) [282] | 282 | 141.0 | half_time |
| 3264 | Henrique Camacho vs Raz — Vikings [160BPM] | 160 | 164.98 | other_mismatch |
| 3664 | Psykovsky & Marambá — Lonely Shepherd [270] | 270 | 135.0 | half_time |
| 3858 | TRAUMATICOMA — Meaningless Emotion [200] | 200 | 219.92 | other_mismatch |
| 4169 | kiiRaTeK — Break Through(185) | 185 | 170.0 | other_mismatch |
| 4570 | K Freq — Intro to my Life (98) | 98 | 196.02 | double_time |
| 5038 | Razael — Something Dripping Down The Dimension (272bpm) | 272 | 247.98 | other_mismatch |
| 5047 | Razael — Open your Feelings (155bpm) | 155 | 247.96 | other_mismatch |
| 5051 | Razael — Contemplating The Horizon (252bpm) | 252 | 168.0 | two_thirds |
