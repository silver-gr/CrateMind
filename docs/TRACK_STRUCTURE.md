# Track structure and phrase lines

CrateMind measures where a track changes: its **sections** (bass playing or not) and its **phrase lines** (every 8 bars, counted from each point where the bass comes in). The Phrase Finder page shows them, and the deck waveform draws the phrase lines. The code is `backend/app/services/track_structure.py` (NumPy only). It runs with «Ανάλυση BPM», in the same decode as the beat grid, stores its result in `track_structures`, and never writes to audio files, tags or djay.

It needs CrateMind's own beat grid at a confidence of at least 0.8 (`docs/BEATGRID_DETECTION.md`). A track without one has no structure.

## What did not work

Measured first on 261 tracks (210 random ones with a confident grid, plus the 51 that have hand cues):

- **Largest spectral changes as boundaries.** The gaps between such boundaries are a multiple of 8 bars in 5–25% of cases, depending on the threshold. Chance is 12.5%.
- **One phrase grid for the whole track.** The first and the second half of a track agree on the 8-bar phase in 43% of tracks (on the bar line in 84%). The phrase shifts inside tracks, so it has to be anchored locally.
- **Bass-outs as anchors.** Where the bass leaves is irregular: 40% on the bar line, 30% one beat later (the last kick lands on the next downbeat).

## Method

0. **Real beats.** The beats are the grid's, moved into the track's tempo octave first. When the track's BPM (`services/tempo.py`, a manual ×½ / ×2 first) is about half the grid's tempo (within 3%), every second beat is used, starting on the bar line; when it is about double, a beat is put between every two. This is the fold the deck makes on a steady grid (`frontend/src/lib/beatGrid.ts`), so 32 beats are 8 real bars and the lines land on beats the deck draws. The grid row itself is not changed. The structure row records the tempo it was measured at (`bpm` in its JSON).
1. **Sub-bass per beat.** The mean log energy of the 0–60 Hz band between consecutive beats. In this music it is high while kick and bass play and low otherwise.
2. **Two classes.** An Otsu threshold splits the beats into bass on and bass off, each class holding at least 5% of them. The share of the variance that the split explains is the `quality`. Under 0.7 the track gets no structure: one bell curve already gives 0.64.
3. **Runs.** Runs shorter than 8 beats are merged into their neighbours, shortest first. A two-beat dropout is a fill, not a section. A short lead-in without bass at the very start is kept, so the first bass-in stays where it is; and when the merge leaves less than 5% of the beats in one class, the track gets no structure.
4. **Anchors.** The first beat of a bass run is an anchor when the sub-bass rises there by at least half the gap between the two classes within one bar. A run that fades in (a filter opening) restarts no count. A track with no anchor gets no structure.
5. **Pauses (since version 2).** A bass-off run shorter than 12 beats (under 3 bars) that lies between two bass runs is a pause, not a break: it is no section, and the anchor right after it is dropped, so the count runs on through it. The track's first anchor is kept even after a pause (before it there is no count to keep running). The lead-in and the closing are never pauses, whatever their length. The pauses are stored as `fills` (start and length); nothing shows them yet. The 5% check of step 3 runs before this step, so a track whose bass then plays almost throughout keeps its structure.
6. **Sections.** Each remaining run is a section, with a level: the mean energy of all bands, relative to the track's loudest section.
7. **Bar line (since version 2).** An anchor one beat before the grid's bar line moves one beat later, one beat after it one beat earlier: a kick roll or a late first kick. Two beats off stays, and an anchor on the track's first beat never moves. Only the count moves; the section still starts where the bass was measured.
8. **Phrase lines.** Every 32 beats after an anchor, up to the next anchor. A line within 8 beats before the next anchor gives way to it. Before the first anchor the lines are counted backwards from it.

## Measured (2026-11-16)

On 200 fresh tracks that no earlier step had touched, with the production code:

| Check | Result | Chance |
|---|---|---|
| Tracks that get a structure | 190 of 200 | |
| Consecutive anchors a multiple of 4 bars apart | 62% | 6% |
| … of 8 bars | 53% | 3% |
| … of 16 bars | 35% | 1.6% |
| A track's strongest changes inside a bass section: exactly on a phrase line | 20% | 3% |
| … in the last bar before a phrase line or the first half bar after it | 56% | 22% |

- **Hand cues (a rough indicator, not accuracy: the owner does not trust them as a reference).** On the 261-track sample, 61 of the 101 hand-placed cues sit on a beat. Of those, 30% are exactly on a phrase line (chance 3%) and 70% a whole number of bars from the nearest one (chance 25%).
- **Quality.** Tracks with a quality under 0.8 are weaker (bass-in gaps on 8-bar multiples in about 34%, against 43–55% above it). The page marks them as uncertain.
- **Order of work.** The sample of 200 was looked at once before the fade-in guard of step 4 was added. The guard's threshold was not tuned on it; it moved the 8-bar figure from 48% to 54% and took the structure away from 3 tracks. Two later fixes from review (a lead-in without bass keeps its length; a class that the merge empties gives no structure) left the figures within one point: the table shows the final code.

These figures are version 1 (before the pause and bar-line steps).

## Measured (2026-11-26): version 2

The owner's complaint was over-sensitivity to short, repeated bass pauses; intros and outros were already right. Version 2 only filters or shifts what version 1 found, so its library figures are exact for the same audio (4,305 tracks with a structure, from a read-only copy of the catalog):

| | Version 1 | Version 2 |
|---|---|---|
| Sections | 52,229 | 39,135 (−25%, in 2,876 tracks) |
| Sections per track, median / 95th percentile | 11 / 23 | 9 / 17 |
| Anchors (median per track) | 22,167 (5) | 16,137 (3) |
| Phrase lines | 167,094 | 166,510 |
| Phrase intervals shorter than 8 bars | 6,934 | 4,820 |
| Phrase lines on the grid's bar line (the deck draws only these) | 83.8% | 94.8% |
| Tracks with every anchor on the bar line | 55.6% | 85.0% |

- The bar-line step moves 1,960 anchors by one beat; 894 anchors two beats off stay.
- About 17,900 lines in 1,618 tracks land on a different beat, because the count now runs through pauses.
- Intros and outros keep their sections: the lead-in and the closing are never pauses.
- **Why 12 beats.** Nothing under 8 beats survives step 3. Of the bass-off runs between two bass runs, 4,074 are exactly 8 beats and 2,473 are 9–11: the same 2-bar pause measured a beat or more long. A 4-bar limit (under 20 beats) would remove more sections (45%), but left 578 tracks with no break at all, against 159; the lengths show no natural cut between a pause and a break.
- **Why the bar line.** For the anchors one beat off the bar line in a 207-track sample, the section's own strong changes side with the grid's bar line in 60% and with the anchor in 16%.
- **Rough indicator only.** Strong spectral changes exactly on a line move from 22.3% to 23.6% of 4,957 (in the last bar before a line or the first half bar after it: 60.4% to 59.2%). Hand cues on a line stay at 38 of 104. The owner does not trust their hand cues or hand downbeats as a reference, so these are not accuracy: they only say the lines got no worse. The gain is fewer, longer sections and more lines on the deck.

## Bar line and phrase lines

In version 1, 82–84% of anchors sat on the detected bar line, and in 55–63% of tracks every anchor did. Where an anchor is one beat off, the section's own changes side with the bar line about four times as often as with the anchor (above), so version 2 moves it onto the bar line; 94.8% of lines now sit on it. An anchor two beats off stays: nothing measured says which way it should go.

So the deck draws a phrase line only where it is also a downbeat of the deck's grid. A phrase line that falls inside a bar is left out on the deck, and the Phrase Finder page still lists it. A deck with measured phrase lines shows them 8 bars apart; a deck without them keeps the old count, every 4 bars from bar 1.

## Transitions timed from the structure

With «Χρονισμός από τη δομή» on (one switch in the transition editor, for every transition, off by default), a pair without a saved window is placed from the two structures instead of the last bars of the outgoing track (`frontend/src/lib/transitions/structurePlacement.ts`, called by `planner.ts`; frontend only, nothing is stored):

- **Outgoing:** the bass swap sits on the latest phrase line at or before the bar where the bass stops for good, in the track's second half, with the whole window inside the track. The swap is the bar where the incoming bass is heard: the window start for a swap at the start, the middle for a centre swap or a 3-band fade, the window end for a swap at the end, an incoming high-pass, or no swap at all.
- **Incoming:** the track starts as many bars before its first bass as the swap is into the window, so that bass lands on the swap. Bass from the first beat, a first bass past the track's half, or an intro shorter than the lead-in keep the old start.
- A saved anchor, an entry or exit cue, «Χωρίς μετάβαση» and every cut win over the structure, each side on its own. Phrase lines come from the grid (`grid.phrases`), each moved to its nearest bar; a track on djay's grid or an estimate has none and keeps the old placement.
- The editor draws the phrase lines and two amber markers («Τέλος μπάσου», «Πρώτο μπάσο»). A set mix uses the structure only once the next deck is ready, and never for a window behind the playhead.

With the switch off every plan is what it was before (`frontend/tests/transitionPlannerGolden.test.ts`). To see what the switch changes on a library, run the two read-only scripts in `.omc/research/structure-transitions-eval/` on a private copy of the catalog: `dump_pairs.py`, then `report.ts` (pairs changed, the rule used per side, bars moved, and the bass gap before and after). A structure of low quality is used like any other; a kick roll before the drop puts the first bass up to a bar early, which one drag of the window or an entry cue corrects.

## Known gaps

- Music without a kick and bass pattern (ambient, some downtempo): the sub-bass does not split, no structure.
- A kick roll right before the drop: one beat early is corrected (step 7), two or more beats early is not.
- Tracks that alternate 3–4 bars of bass with 3–4 bars without keep every section (one track has 65).
- Anchors two beats off the bar line stay where the bass came in.
- The tempo octave follows the track's BPM only by one octave (×½ or ×2), and only within 3%; a BPM at 3/2 of the grid keeps the grid's beats. After a ×½ / ×2 the structure is read again on the next «BPM + Key · μόνο νέα» run; until then the old lines are shown.
- Beat lists in the wrong octave: the deck does not fold a beat list (only a steady grid), so on a list at half the track's tempo some phrase lines fall between the bars the deck draws and are not shown there; the Phrase Finder page lists them all.
- Beat lists (tracks with a timing jump): the beat count runs through the jump. The next anchor corrects it.
- Sections are named by position only: before the first bass «Εισαγωγή», between bass sections «Break», after the last «Κλείσιμο». A build-up or a drop is not told apart.

## Re-measuring

The scripts read a real library, so they are not in the repository. Take a private copy of the catalog, sample tracks with a confident CrateMind grid, decode each file with ffmpeg and run `detect_with_bands` and `detect_structure`. Then count, over all tracks: the gaps between consecutive anchors in beats modulo 16, 32 and 64; and, for the strongest 15% of beat-to-beat spectral changes inside bass sections, their distance in beats from the last phrase line. The version 2 measurements and their scripts are in `.omc/research/structure-refine-2026-11-26/` (`measurements.md`, `proposal.md`, `scripts/verify_proposal.py` recomputes the library table from stored rows).
