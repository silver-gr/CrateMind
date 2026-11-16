# Track structure and phrase lines

CrateMind measures where a track changes: its **sections** (bass playing or not) and its **phrase lines** (every 8 bars, counted from each point where the bass comes in). The Phrase Finder page shows them, and the deck waveform draws the phrase lines. The code is `backend/app/services/track_structure.py` (NumPy only). It runs with «Ανάλυση BPM», in the same decode as the beat grid, stores its result in `track_structures`, and never writes to audio files, tags or djay.

It needs CrateMind's own beat grid at a confidence of at least 0.8 (`docs/BEATGRID_DETECTION.md`). A track without one has no structure.

## What did not work

Measured first on 261 tracks (210 random ones with a confident grid, plus the 51 that have hand cues):

- **Largest spectral changes as boundaries.** The gaps between such boundaries are a multiple of 8 bars in 5–25% of cases, depending on the threshold. Chance is 12.5%.
- **One phrase grid for the whole track.** The first and the second half of a track agree on the 8-bar phase in 43% of tracks (on the bar line in 84%). The phrase shifts inside tracks, so it has to be anchored locally.
- **Bass-outs as anchors.** Where the bass leaves is irregular: 40% on the bar line, 30% one beat later (the last kick lands on the next downbeat).

## Method

1. **Sub-bass per beat.** The mean log energy of the 0–60 Hz band between consecutive beats of the grid. In this music it is high while kick and bass play and low otherwise.
2. **Two classes.** An Otsu threshold splits the beats into bass on and bass off, each class holding at least 5% of them. The share of the variance that the split explains is the `quality`. Under 0.7 the track gets no structure: one bell curve already gives 0.64.
3. **Sections.** Runs shorter than 8 beats are merged into their neighbours, shortest first. A two-beat dropout is a fill, not a section. A short lead-in without bass at the very start is kept, so the first bass-in stays where it is; and when the merge leaves less than 5% of the beats in one class, the track gets no structure. Each remaining run is a section, with a level: the mean energy of all bands, relative to the track's loudest section.
4. **Anchors.** The first beat of a bass section is an anchor when the sub-bass rises there by at least half the gap between the two classes within one bar. A section that fades in (a filter opening) restarts no count. A track with no anchor gets no structure.
5. **Phrase lines.** Every 32 beats after an anchor, up to the next anchor. A line within 8 beats before the next anchor gives way to it. Before the first anchor the lines are counted backwards from it.

Phrase lines are counted in beats from the anchor, so they do not depend on the bar line.

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

- **Hand cues.** On the 261-track sample, 61 of the 101 hand-placed cues sit on a beat. Of those, 30% are exactly on a phrase line (chance 3%) and 70% a whole number of bars from the nearest one (chance 25%).
- **Quality.** Tracks with a quality under 0.8 are weaker (bass-in gaps on 8-bar multiples in about 34%, against 43–55% above it). The page marks them as uncertain.
- **Order of work.** The sample of 200 was looked at once before the fade-in guard of step 4 was added. The guard's threshold was not tuned on it; it moved the 8-bar figure from 48% to 54% and took the structure away from 3 tracks. Two later fixes from review (a lead-in without bass keeps its length; a class that the merge empties gives no structure) left the figures within one point: the table shows the final code.

## Bar line and phrase lines

82–84% of anchors sit on the detected bar line, and in 55–63% of tracks every anchor does. Where they differ, nothing measured says which is right: on the 14 hand-marked downbeats the bar vote is right on 9 and the anchors' majority on 10, and the two agree with each other on 13.

So the deck draws a phrase line only where it is also a downbeat of the deck's grid. A phrase line that falls inside a bar is left out on the deck, and the Phrase Finder page still lists it. A deck with measured phrase lines shows them 8 bars apart; a deck without them keeps the old count, every 4 bars from bar 1.

## Known gaps

- Music without a kick and bass pattern (ambient, some downtempo): the sub-bass does not split, no structure.
- A kick roll right before the drop can pull the anchor a few beats early.
- Half-tempo grids: 32 detected beats are then 16 real bars, so lengths in bars read double.
- Beat lists (tracks with a timing jump): the beat count runs through the jump. The next anchor corrects it.
- Sections are named by position only: before the first bass «Εισαγωγή», between bass sections «Break», after the last «Κλείσιμο». A build-up or a drop is not told apart.

## Re-measuring

The scripts read a real library, so they are not in the repository. Take a private copy of the catalog, sample tracks with a confident CrateMind grid, decode each file with ffmpeg and run `detect_with_bands` and `detect_structure`. Then count, over all tracks: the gaps between consecutive anchors in beats modulo 16, 32 and 64; and, for the strongest 15% of beat-to-beat spectral changes inside bass sections, their distance in beats from the last phrase line.
