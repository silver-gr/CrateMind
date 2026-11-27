# Track structure and phrase lines

CrateMind measures where a track changes: its **sections** (kick and bass playing or not, and since version 4 a bass that leads into a drop as a **build-up**) and its **phrase lines** (every 8 bars, counted from each point where the bass comes in). The Phrase Finder page shows them, and the deck waveform draws the phrase lines. The code is `backend/app/services/track_structure.py` (NumPy only). It runs with «Ανάλυση BPM», in the same decode as the beat grid, stores its result in `track_structures`, and never writes to audio files, tags or djay.

It needs CrateMind's own beat grid at a confidence of at least 0.8 (`docs/BEATGRID_DETECTION.md`). A track without one has no structure.

## What did not work

Measured first on 261 tracks (210 random ones with a confident grid, plus the 51 that have hand cues):

- **Largest spectral changes as boundaries.** The gaps between such boundaries are a multiple of 8 bars in 5–25% of cases, depending on the threshold. Chance is 12.5%.
- **One phrase grid for the whole track.** The first and the second half of a track agree on the 8-bar phase in 43% of tracks (on the bar line in 84%). The phrase shifts inside tracks, so it has to be anchored locally.
- **Bass-outs as anchors.** Where the bass leaves is irregular: 40% on the bar line, 30% one beat later (the last kick lands on the next downbeat).

Measured again for version 3 (2026-11-27) on 150 tracks, as the test for "kick and bass are playing" (the table is under "Measured (2026-11-27)"):

- **The band below 60 Hz alone** (versions 1 and 2). A bass that plays a higher note leaves that band, which read as a 4-bar pause every 16 bars. A sub drone in a break fills it, which read as bass.
- **The level of a wider band alone** (0–120 or 0–250 Hz). It cures the note change and keeps the drone. Up to 250 Hz, pads count as bass too.
- **Movement alone** (how far the low end swings inside a beat, with no level). A quiet intro kick swings as far as the drop on a log scale: with an Otsu split on it 29 of 142 tracks lose their structure. On an energy scale a few low hits in an intro become a bass section.
- **Matching every beat to the track's own kick-bass pattern.** Sharp on a steady psytrance pattern. A track whose bass changes from beat to beat has no one pattern: 4 to 6 tracks lose their structure and others lose whole sections.
- **Counting a kick-bass without its sub wherever the mid-bass moves.** Intros and outros with the low end cut become bass: the first bass moved up to 54 bars earlier, the last one up to 48 bars later. It counts only in the narrow case of step 7.

## Method

0. **Real beats.** The beats are the grid's, moved into the track's tempo octave first. When the track's BPM (`services/tempo.py`, a manual ×½ / ×2 first) is about half the grid's tempo (within 3%), every second beat is used, starting on the bar line; when it is about double, a beat is put between every two (steady grids only: a beat list at half the track's tempo is not doubled, as the deck does not fold it). This is the fold the deck makes on a steady grid (`frontend/src/lib/beatGrid.ts`), so 32 beats are 8 real bars and the lines land on beats the deck draws. The grid row itself is not changed. The structure row records the tempo it was measured at (`bpm` in its JSON).
1. **Low end per beat.** The mean log energy of 0–120 Hz (the two lowest bands together) between consecutive beats. Versions 1 and 2 read the band below 60 Hz alone.
2. **Two classes.** An Otsu threshold splits the beats into loud and quiet, each class holding at least 5% of them. The share of the variance that the split explains is the `quality`. Under 0.7 the track gets no structure: one bell curve already gives 0.64.
3. **Movement (since version 3).** Every beat is cut into 8 slices. The swing of a band is its loudest slice minus its quietest, in energy. A kick and a bass line leave a dip before every kick, so the low end swings inside the beat. A drone does not. A loud beat is bass only when its 0–120 Hz swing reaches 30% of the median swing of the track's loud beats. A still beat between two moving beats counts too (a kick on every second beat).
4. **Runs.** Runs shorter than 8 beats are merged into their neighbours, shortest first. A two-beat dropout is no section. A short lead-in without bass at the very start is kept, so the first bass-in stays where it is; and when the merge leaves less than 5% of the beats in one class, the track gets no structure.
5. **Anchors.** The first beat of a bass run is an anchor when the low end rises there by at least half the gap between the two classes within one bar, or its movement rises by half of the usual swing (a kick coming in over a drone). A run that fades in (a filter opening) restarts no count. A track with no anchor gets no structure.
6. **Fills (since version 3; they replace version 2's pauses).** A bass stop of 3 to 11 beats between two bass runs is a fill, not a break: it is no section. The bass coming back after it is an anchor, so a drop restarts the count (version 2 dropped that anchor), when the bass played six bars or more up to the stop, or came in just before it after a break or at the start (a tease before the drop). Inside a groove of short stops (two bars on, one off) the returns restart nothing: measured, they fall on the 8-bar count 1–33% of the time (see "Independent check" below). Two details: a stop under 8 beats needs two bars of bass after it, and a stop of 8 to 11 beats stays a section when the bass run before it moves less than 70% of the run after it (a build-up or a tease before its drop), so that the drop starts a section (since version 4 such a run is a build-up when step 8 says so, and the stop is then part of it). A stop under 3 beats is a flicker. The lead-in and the closing are never fills. The fills are stored as `fills` (start and length); nothing shows them yet. The 5% check of step 4 runs before this step.
7. **Kick-bass without its sub (since version 3).** One narrow case. In a track whose 120–250 Hz band swings at least 10% as far as its 0–120 Hz band: when a bass run ends, both bands stop for at least 3 beats, the mid-bass comes back within 12 beats of that end (moving, and within 0.5 of its level on the bass beats), holds for at least 8 bars, and the full bass returns within 8 bars, that stretch is bass and its start is an anchor. A kick-bass without its sub in an intro, after a long break or in an outro is not bass.
8. **Build-ups and drops (since version 4).** A bass run that leads into a drop is a build-up, a section of its own kind.
   - *Entrances.* The anchors so far, plus the end of a dip of one or two beats inside a bass section (0–120 Hz in the quiet class, bass before it and two bars of bass after it) that falls on the grid's bar line, one beat off it included. A dip elsewhere, or within two beats of an anchor, marks nothing; without a bar line no dip does.
   - *Pieces.* Every bass section is cut at its entrances. A piece's **movement** is the 0–120 Hz swing of step 3 over the track's usual (not capped at 1), taken per bar: the mean of each bar of four beats, then the median of the bars. The median of the beats is not used: a pattern of a strong and a weak beat in turn gives it either value. Its **level** is the median 0–120 Hz log energy of its bass beats. The **track's usual bass** is the same movement and level over all the track's bass beats.
   - *The test.* A piece S, then an entrance, then a piece D, each with at least 4 bars of bass and at most 24 beats apart, is a build-up and its drop when S is weaker or fades in:
     - *weaker:* each half of S moves under **0.75** of D's first phrase (its first 8 bars) and under **0.8** of the track's usual bass, and S is not louder than D;
     - *fades in:* S lies at least **0.3** under D and under the track's usual bass, the line fitted to its per-bar level climbs at least **0.5** from its first bar to its last and explains at least **0.85** of the bars' variance, and D's first two bars are at least as loud as S's last two.
   - *Reaching back.* The build-up takes in the pieces before S in the same bass section that pass the same test (weaker in both halves and not louder; or, for a fade-in, as far under). A build-up of more than 32 bars is dropped whole, and so is one that would make a stretch of more than 32 bars with the build-up that ends where it starts.
   - *What it changes.* The build-up is one section with `kind` "buildup" (it still counts as bass: its low end is in the loud class). A stop between S and the drop belongs to it, so a break of up to 6 bars there is no section (it is listed in `fills`); before a bass that is no build-up the same stop stays a break. The drop is an anchor and starts a section. An anchor inside a build-up is dropped; the one at its start stays, so the count before the build-up is as in version 3 and restarts on the drop. Inside the build-up the lines can move, because an entrance version 3 had there is gone (in the samples: one line by 5 bars in one track, two lines by one bar in another).
9. **Sections.** Each remaining run is a section, with a level: the mean energy of all bands, relative to the track's loudest section.
10. **Bar line (since version 2).** An anchor one beat before the grid's bar line moves one beat later, one beat after it one beat earlier: a kick roll or a late first kick. Two beats off stays, and an anchor on the track's first beat never moves. Only the count moves; the section still starts where the bass was measured.
11. **Phrase lines.** Every 32 beats after an anchor, up to the next anchor. A line within 8 beats before the next anchor gives way to it. Before the first anchor the lines are counted backwards from it.

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

Version 3 replaced the pause step measured here; the figures stay as the record of version 2.

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

## Measured (2026-11-27): version 3

After the re-analysis with version 2 the owner checked two tracks and found the bass in the build-up and in the breaks, not in the drop. They then gave the truth by bar number (bars of 4 beats, counted from 1 on the grid):

- **In My Mind (2025 version)** (190 BPM): build-up from bar 17, two bars of transition, the drop at bar 33. The build-up already has kick and bass, quieter and without the 120–250 Hz body. Version 1 had an entrance at bar 33; version 2's pause step absorbed the two bars and with them that entrance, so the first entrance was the build-up. From 2:22 a sub drone with no kick runs through 14 bars of the break, and versions 1 and 2 called it bass. From 3:12 the bass plays 4 bars of every 16 a note higher: the band below 60 Hz drops while 60–250 Hz stays full, and versions 1 and 2 called that a pause.
- **Not Like You** (180 BPM): a drop at bar 281 after one bar of transition, where the kick-bass has nothing below 60 Hz and its weight at 120–500 Hz. Versions 1 and 2 showed bars 280 to 300 as a break. Bars 33 to 80 hold a quiet kick about 10 dB under the drop, on one beat in four; all versions keep them as intro.

Version 3 gives In My Mind an entrance at bar 33 (the build-up is a bass section of its own, bars 18 to 30, then the two-bar stop, then the drop), the break from bar 113 (2:21) and no pause from 3:12 on: 7 sections where version 2 had 23. It gives Not Like You entrances at bars 97, 249, 281 and 301, with bars 281 to 296 inside the bass section.

There is no trusted hand reference (the owner does not trust their own cues or downbeats), so the sample was measured with checks that need none. 150 tracks with a confident grid from a read-only copy of the catalog, decoded read-only: the two tracks, the ten examples of the version 2 measurements, and 138 drawn at random across tempos (12 under 120 BPM, 14 at 120–140, 34 at 140–160, 24 at 160–180, 30 at 180–200, 16 at 200–220, 8 above). Versions 1 and 2 and the candidates were run by research code on the same band energies (it gives the same sections and anchors as the version 1 and version 2 modules on all 150 tracks); the version 3 row is the production code.

| Test for "kick and bass are playing" | Tracks with a structure (lost / gained against version 2) | Bass runs of 4+ bars whose low end does not move (tracks) | Short off sections where kick and bass keep playing (tracks) | Inner off sections under 8 bars / under 3 bars | Entrances: gaps between them, share on the 8-bar count | First bass / last bass end within a bar of version 2 | Sections per track, median / 95th percentile | Anchors per track, median |
|---|---|---|---|---|---|---|---|---|
| Version 1: level below 60 Hz | 142 | 14 (12) | 94 (25) | 544 / 252 | 635, 54.8% | 100% / 100% | 11 / 29 | 4 |
| Version 2: version 1 and the pause step | 142 | 15 (13) | 66 (17) | 292 / 0 | 404, 58.4% | – | 7 / 21 | 3 |
| Level 0–120 Hz, pause step | 148 (1 / 7) | 23 (18) | 0 | 232 / 0 | 311, 51.4% | 82% / 89% | 7 / 15 | 3 |
| Level 0–250 Hz, pause step | 146 (2 / 6) | 36 (25) | 0 | 207 / 0 | 275, 47.3% | 74% / 84% | 7 / 14 | 3 |
| Level 0–250 Hz and a pulse, pause step | 143 (5 / 6) | 8 (7) | 7 (7) | 209 / 0 | 270, 50.0% | 66% / 81% | 7 / 15 | 2 |
| Pulse alone, pause step | 116 (29 / 3) | 24 (22) | 4 (3) | 125 / 0 | 217, 42.4% | 51% / 60% | 7 / 15 | 3 |
| Match to the track's own pattern (log energy), pause step | 142 (6 / 6) | 4 (4) | 40 (23) | 241 / 0 | 356, 52.0% | 62% / 75% | 8 / 17 | 3 |
| Share of the track's own pattern (energy) | 144 (4 / 6) | 6 (4) | 21 (10) | 391 / 195 | 1,244, 61.6% | 62% / 77% | 9 / 22 | 8 |
| Movement alone, as a share of the usual swing | 140 (9 / 7) | 9 (9) | 0 | 314 / 126 | 1,050, 58.0% | 65% / 73% | 9 / 18 | 8 |
| Movement alone, Otsu on its log | 135 (13 / 6) | 68 (40) | 0 | 243 / 94 | 859, 52.5% | 60% / 63% | 7 / 15 | 7 |
| **Version 3: level 0–120 Hz and movement, fills** | **149 (0 / 7)** | **1 (1)** | **0** | **241 / 10** | **1,238, 69.2%** (as first built: 1,321, 65.8%) | **75% / 86%** | **7 / 16** | **9** |

What the columns can and cannot show:

- **Drones and note changes** (columns 3 and 4) are counted with version 3's own movement measure (a swing under 15% of the usual for 4 bars inside a bass section; a median swing over 50% with the 0–120 Hz level loud inside a short off section). So they show how often versions 1 and 2 hit the two faults seen in In My Mind (a drone as bass in 13 of 142 tracks, a playing kick-bass as a pause in 17 to 25), and that the level-only candidates keep the drones. They cannot show that version 3 is right: it scores well on its own measure by construction.
- **The 8-bar count** needs no reference: chance is 3%. Version 3 has three times the entrances of version 2 and more of them on the count.
- **First and last bass** only says where version 3 moves away from versions 1 and 2 (which agree with each other here). Of 142 tracks the first bass is within a bar in 106, earlier in 14 and later in 22 (by more than 8 bars: 8 earlier, 13 later); the end of the last bass is within a bar in 122, earlier in 12, later in 8. By the same measures (not by ear) the later first basses are sub drones at the start (level loud, nothing moving), and the earlier ones are basses with their weight at 60–120 Hz and weaker early bass runs. Which side is right has to be heard: `.omc/research/structure-v3-2026-11-27/listen.md` lists the twenty largest moves.
- **Lost structures:** none. Seven tracks gain one (their band below 60 Hz did not split; 0–120 Hz does), one of 150 has none. Tracks under quality 0.8: 7 of 149 (14 of 142 before).

Entrances of version 3 by kind, and how often each falls on the 8-bar count from the entrance before it (with the fill rule of the independent check below; as first built: 354 at 57%, 205 at 68%, 378 at 77%, 184 at 54%, 198 at 70%):

| Entrance | Count | On the 8-bar count | On the 4-bar count |
|---|---|---|---|
| Start of a bass section | 354 | 58% | 75% |
| After a stop of 3 beats | 182 | 73% | 79% |
| After a stop of 1 bar | 356 | 80% | 85% |
| After a stop of 5–7 beats | 149 | 66% | 72% |
| After a stop of 2 bars (8–11 beats) | 197 | 69% | 77% |
| Kick-bass without its sub | 2 | 1 of 2 | |

- **The pause step, decided.** Version 2 absorbed every bass stop under 12 beats and dropped the entrance after it. The entrances after a one-bar or a two-bar stop are the best phrase markers the method has (77% and 70% on the count, against 57% for the start of a bass section), so dropping them was wrong, and it is what hid the drop at bar 33. Absorbing the stops as sections was right: with the 2-bar stops kept as sections the sample has 211 off sections under 3 bars and 9 / 26 sections per track, against 10 and 7 / 16. Only about a sixth of version 1's short pauses were note changes (252 off sections under 3 bars with the band below 60 Hz, 211 with the better test): the rest are real stops, mostly at the end of a 16-bar phrase. So version 3 keeps the absorbing, keeps the entrances (all but those inside a groove of short stops, see below), and keeps the stop itself when the run before it is weaker.
- **Sensitivity.** A movement threshold of 20% or 40% instead of 30% moves the entrance figures by under half a point and keeps every structure; 20% lets the swelling start of the drone in In My Mind count as bass for four bars, with an entrance in it. Fills from 4 beats instead of 3 lose 194 entrances (those after "a kick on the one, then three beats of nothing"), which are on the count in 68%. Without the kick-bass-without-sub step nothing else changes: it fires in 2 of 150 tracks.
- **Kick-bass without its sub.** With a section of 2 bars as the least length it fired 18 times in 150 tracks; 2 of those entrances were on the 8-bar count and 6 on the bar line (the rest: mid-bass in a fill or a roll, not a drop). With 8 bars as the least it fires twice. It is built for the one case the owner named and should be read as that.
- **Build-ups.** A bass run that moves under 70% of the run after a short stop: 33 of 953 such stops in the sample, 14 of them the first bass after an intro or a break. Version 3 keeps the stop as a section there (10 stops in 150 tracks), so the drop is marked. It does not label the run before it «Build-up» or take it out of the bass: the 70% line has no gap in the data around it and nobody has heard the cases. `listen.md` lists them; if they are build-ups to the owner's ear, the label is the next step.
- **Phrase lines on the grid's bar line:** 84.3% (version 1), 95.5% (version 2), 96.7% (version 3) on this sample.

**Independent check (2026-11-27).** A second sample, drawn with another seed and sharing no track with the first: 120 tracks at random over every track with a confident grid, plus the two owner tracks (122), decoded read-only. The figures above are reproduced on the first sample by separate code; on the second they hold in direction but are smaller. With the code as first built, entrances after a stop of 3 or 4 beats were on the 8-bar count in 61% and 75%, after a 5–7 beat stop in 43%, after a two-bar stop in 60%, and at the start of a bass section in 51%. Split by how long the bass played before the stop, the same entrances were on the count in 1–33% after under six bars of bass and in 85–90% after six to eight bars, on both samples: those are the returns inside a groove of short stops (`##.##.##`), where every return restarted the count, often every 4 bars. Since this check a fill restarts the count only after six bars of bass, or when the bass came in just before it after a break (`_restarts`); on the second sample that turns 1,071 entrance gaps at 59.2% on the count into 974 at 63.6%, and gaps under 8 bars from 120 into 41 (version 2: 326 at 53.4%, 4). Both versions give a structure for 113 of the 122 tracks (version 3 loses one, a track whose only bass-off parts are a 6-bar intro and a 7-bar outro, under the 5% of step 4, and gains six); there they agree on the first bass within a bar in 72% and on the end of the last in 81%. Version 3 still restarts the count off the 8-bar count of the entrance before about twice as often as version 2 (355 against 152 times), and about 30% of version 2's phrase lines inside sections both call bass move. A reference-free check (how much the band profile changes across a line) scores the lines only one version draws the same, so which lines are right has to be heard.

## Measured (2026-11-27, evening): version 4

Right after the version 3 run the owner listened to five tracks and wrote what they hear, by bar number (`.omc/research/structure-v4-2026-11-27/owner-by-ear.md`). The common complaint: a bass run that leads into a drop was shown as bass, so «Πρώτο μπάσο» sat on the build-up. These are five tracks of evidence about what the owner hears, not a reference set: agreement with them is not accuracy.

The rule of step 8 was built twice. The first build compared a piece only with its drop, by the median of its beats. An independent review of its 20 build-ups outside the owner's tracks judged 6 wrong and 3 doubtful from the audio measurements: the track's usual bass before an unusually hard part (the drop moved 1.2 to 1.7 times the usual), a pattern of strong and weak beats that read 0.65 of itself, and a loop that swells every 8 bars. The second build is the rule above; all nine are gone (`measurements-2.md` there has each case).

What the audio shows in the stretches the owner calls a build-up (movement of the stretch's stronger half; log units for level, +0.7 is about double the energy):

| Stretch (bars) | Movement, share of the drop's first phrase | … of the track's usual bass | Level against the drop | Before the drop | Version 4 |
|---|---|---|---|---|---|
| Toxic Remix 111.4–118 | 0.22 | 0.29 | −0.41 | a stop of 19 beats (a roll, a silent bar) | build-up (weaker) |
| In My Mind 18.3–30 | 0.50 | 0.52 | −1.03 | a 2-bar stop | build-up (weaker) |
| Natura 74.2–80 | 0.62 | 0.66 | −0.19 | a one-beat dip | build-up (weaker) |
| Philosophical Approach 24.3–31 | 0.93 | 1.02 | −0.55, climbing 1.2 as a line (0.97) | a 3-beat stop | build-up (fades in) |
| Toxic Remix 155–186 | 0.76 | 0.81 | −0.08 | a 2-beat dip | bass |
| Beauty and the Beast 177–192 | 0.74 | 0.90 | −0.44, climbing in two steps (0.79), ending 0.13 over the drop's start | a 2-beat dip | bass |
| Beauty and the Beast 31–48 | 0.99 (by beats) | | +0.01 | a 2-beat dip | bass |
| Toxic Remix 2–17 | 1.01 (by beats) | | 0 | none | bass |

The owner's fifteen statements: 7 met, 2 partly, 6 not met.

- **Philosophical Approach** ("first drop at bar 33, earlier bass is a build-up"): build-up 24.3–32, drop at 33. Met, by the fade-in test.
- **Natura** ("drop actually at bar 81, earlier bass at 73 … is a build up"): build-up 74.2–80, drop at 81 (a new entrance, after the one-beat dip at 80.4). The build-up starts at 74.2, where the low end first moves enough, not at 73.
- **In My Mind** ("drop at 33, build up starts at 17, other breaks and drops on-point"): build-up 18.3–32 (the 2-bar stop is part of it), drop at 33, everything else as version 3. It starts at 18.3, not 17 (bar 17 moves 0.29 of the usual, just under the 0.3 of step 3).
- **Toxic Remix** ("bass at 112: build-up, break at 118.2: no break, part of the build-up"): build-up 111.4–122 with the old break inside it, drop at 123. Met.
- **Toxic Remix 155–187** ("155: starts a break-down … that drops at 187"): **not met.** The stretch moves 0.81 of the track's bass and 0.76 of its drop, on both lines (0.8 and 0.75). The same numbers describe the track's own groove before a harder part in other tracks (Droptikoi - Funghi bars 145–168: 0.87 and 0.74), which the review judged wrong. The first build met it with thresholds that sat exactly on it (0.72 on a line of 0.75, 128 beats on a cap of 128). It stays bass, with entrances at 155 and 172 and the lines 163, 172, 180, 188, as in version 3.
- **Beauty and the Beast** (the owner's "maybe not a good example"; "drop at 49 …, break at 177 not marked, drops at 193"): **not met.** Bars 177–192 move 0.90 of the track's bass, and their level rises in two steps and ends above where the drop starts. Bars 31–48 and 49 on are the same low end; only hats and claps come in.
- **Toxic Remix, bar 18** ("drop at 18 after a small build-up break"): not met. Bars 2–17 and 18–33 are the same kick and bass, the one-beat dip before 18 repeats every 4 bars, and only a soft off-beat hat comes in.

On three samples of 150 tracks each (the version 3 sample; a second drawn the same way from the other tracks; a third, held out until the rule was fixed), version 3 against version 4:

| | Sample 1 | Sample 2 | Sample 3 (held out) |
|---|---|---|---|
| Tracks with a structure (none lost or gained) | 149 | 149 | 147 |
| Build-ups / tracks with one | 14 / 12 | 25 / 22 | 29 / 24 |
| Bars relabelled, median, longest | 206, 11.75, 32 | 344, 16, 28.25 | 354, 13, 21.5 |
| Build-ups by the fade-in test | 0 | 1 | 1 |
| First drop later than version 3's first bass | 6 tracks, 10 to 32 bars | 10, 4.75 to 28.25 | 9, 5 to 21.5 |
| Version 3 phrase lines that are no line now | 0 of 5,720 | 10 of 5,667 (3 tracks) | 9 of 5,773 (4 tracks) |
| Version 3 entrances that are none now / new entrances | 1 / 2 | 1 / 3 | 1 / 3 |
| Version 3 off sections now inside a build-up (of 12 beats or more) | 7 (4) | 9 (7) | 15 (13) |
| Entrance gaps on the 8-bar count (version 3) | 69.2% (69.2%) | 63.5% (63.4%) | 61.6% (61.8%) |
| Read from their bars: plausible / doubtful / wrong | 9 / 4 / 0 (without the owner's track) | 21 / 4 / 0 | 23 / 6 / 0 |

- **Nobody has heard the samples' build-ups.** The last row is a reading of per-bar numbers (low end, movement, body, top). Sample 2 was on the table while the rule was reworked. Sample 3 was not: the rule as it stood before sample 3 was looked at gave 30 build-ups there, 23 plausible, 6 doubtful and 1 wrong. That one had a "drop" whose first bars moved like the build-up; reading the drop on its first phrase removed it, a change made after seeing it.
- **The two movement lines are not gaps in the data.** Over the 1,405 pairs of pieces in samples 1 and 2 the counts fall smoothly from the peak at 1.0. What reads right ends at 0.78 of the usual bass and what reads wrong starts at 0.84; Toxic 155–186 (0.81) is the only case between. At 20% lower either line removes about half the build-ups, Natura among them (0.62 and 0.66); at 20% higher the usual-bass line brings back Beauty 177 together with Funghi 145.
- **The fade-in line is in a gap, on little data.** Of the pieces that lie under and climb, three are lines (0.97, 0.95, 0.91) and the rest are at 0.79 or under.
- **What each check does,** switched off alone on all 455 tracks: no usual-bass line, 19 more build-ups; the whole piece instead of both halves, 26 more and 9 fewer; beats instead of bars, 5 more and 7 fewer; entrances at build-up starts dropped, phrase lines differ in 18 tracks. The cap on a stretch of build-ups and "the drop starts as loud" change nothing there (synthetic tests pin them).
- **Not built:** a marker for a drop that only the top of the mix announces (Beauty 49, Toxic 18). A two-sided test (weaker than the bass before it as well as after it) would bring Toxic 155 back (0.66 of the bass before it; Funghi 0.96) together with one case the review called doubtful; it waits for the owner's ear. A separate breakdown rule, and reaching back over a kickless bass line (Toxic from bar 106).

## Bar line and phrase lines

In version 1, 82–84% of anchors sat on the detected bar line, and in 55–63% of tracks every anchor did. Where an anchor is one beat off, the section's own changes side with the bar line about four times as often as with the anchor (above), so version 2 moves it onto the bar line; 94.8% of lines sat on it in version 2's library figures. An anchor two beats off stays: nothing measured says which way it should go.

So the deck draws a phrase line only where it is also a downbeat of the deck's grid. A phrase line that falls inside a bar is left out on the deck, and the Phrase Finder page still lists it. A deck with measured phrase lines shows them 8 bars apart; a deck without them keeps the old count, every 4 bars from bar 1.

## Transitions timed from the structure

With «Χρονισμός από τη δομή» on (one switch in the transition editor, for every transition, off by default), a pair without a saved window is placed from the two structures instead of the last bars of the outgoing track (`frontend/src/lib/transitions/structurePlacement.ts`, called by `planner.ts`; frontend only, nothing is stored):

- **Outgoing:** the bass swap sits on the latest phrase line at or before the bar where the bass stops for good, in the track's second half, with the whole window inside the track. The swap is the bar where the incoming bass is heard: the window start for a swap at the start, the middle for a centre swap or a 3-band fade, the window end for a swap at the end, an incoming high-pass, or no swap at all.
- **Incoming:** the track starts as many bars before its first bass as the swap is into the window, so that bass lands on the swap. Since version 4 the first bass is the first drop: a build-up before it plays through the lead-in like an intro (its bass is audible there; «Δύο μπάσα μαζί» counts a build-up as bass and flags it when the curves let both through). Bass from the first beat, a first bass past the track's half, or an intro shorter than the lead-in keep the old start.
- A saved anchor, an entry or exit cue, «Χωρίς μετάβαση» and every cut win over the structure, each side on its own. Phrase lines come from the grid (`grid.phrases`), each moved to its nearest bar; a track on djay's grid or an estimate has none and keeps the old placement.
- The editor draws the phrase lines and two amber markers («Τέλος μπάσου», «Πρώτο μπάσο»). A set mix uses the structure only once the next deck is ready, and never for a window behind the playhead.

With the switch off every plan is what it was before (`frontend/tests/transitionPlannerGolden.test.ts`). To see what the switch changes on a library, run the two read-only scripts in `.omc/research/structure-transitions-eval/` on a private copy of the catalog: `dump_pairs.py`, then `report.ts` (pairs changed, the rule used per side, bars moved, and the bass gap before and after). A structure of low quality is used like any other; a kick roll before the drop puts the first bass up to a bar early, which one drag of the window or an entry cue corrects.

## Known gaps

- Music without a kick and bass pattern (ambient, some downtempo): the low end does not split, no structure.
- A kick roll right before the drop: one beat early is corrected (step 10), two or more beats early is not.
- A build-up is found only in the low end, against the bass after it and the track's usual bass: one that moves like its drop there (the drop adds only hats, claps or a lead) stays bass, and so does one with no entrance after it (no stop, and no dip on the bar line). «Πρώτο μπάσο» then still sits on it.
- A stretch that moves 0.8 or more of the track's usual bass is never a build-up, whatever follows (Toxic Remix 155–186 at 0.81, which the owner hears as one). A missed build-up reads as bass, as in version 3.
- A kick without its bass before the drop is a build-up only when it also moves under both lines, or fades in as a line. Otherwise it reads as bass.
- A build-up starts where the low end first counts as bass (step 3), which can be a bar or more after the ear hears it start; a kickless bass line before it is a break.
- A weaker bass of 4 to 32 bars before a stronger one reads as a build-up, also where a listener would call both grooves: the movement lines have no gap around them, and a build-up of exactly 32 bars moves «Πρώτο μπάσο» by 32. Half of a build-up's half can still be full-strength bars (the test is a median).
- The drop mark can sit a bar or two before the full bass when the first bars after the entrance are weak.
- A break of up to 6 bars between a build-up and its drop is part of the build-up and is not shown as a break.
- A quiet kick in an intro stays intro while its low end is in the track's quiet class, or while it moves the low end on few beats (Not Like You: half of its beats are loud enough, one in four moves). A steady quiet kick that is loud enough is bass.
- A bass line with no kick moves the low end and counts as bass. A sub that swells or pumps without a kick can count for a bar or two.
- A kick-bass without its sub counts only inside the bass, after a short stop (step 7). In an intro, after a long break or in an outro it is not bass, however clear it sounds.
- Tracks that alternate 3–4 bars of bass with 3–4 bars without keep every section.
- Fills: inside a groove of short stops only the first return after a break restarts the count, which can be a groove's second bar rather than a drop; a real drop after a tease of under six bars that itself began after a short stop restarts nothing.
- A bass that holds a long note on some bars and plays a figure on others (some downtempo) can flicker around the movement threshold: short bass sections and stops in a row, and the first entrance can be lost when the first bar of the bass is a held note.
- Anchors two beats off the bar line stay where the bass came in.
- The tempo octave follows the track's BPM only by one octave (×½ or ×2), and only within 3%; a BPM at 3/2 of the grid keeps the grid's beats. After a ×½ / ×2 the structure is read again on the next «BPM + Key · μόνο νέα» run; until then the old lines are shown.
- Beat lists in the wrong octave: the deck does not fold a beat list (only a steady grid), so a list at half the track's tempo keeps its own beats: the lines sit on the deck's bars but come every 16 real bars, so lengths in bars read double.
- Beat lists (tracks with a timing jump): the beat count runs through the jump. The next anchor corrects it.
- Sections without bass are named by position only: before the first bass «Εισαγωγή», between bass sections «Break», after the last «Κλείσιμο». A bass section is «Build-up» when step 8 says so, «Drop» right after one, and «Κύριο μέρος» otherwise: the bass coming back after a plain break is not called a drop.

## Re-measuring

The scripts read a real library, so they are not in the repository. Take a private copy of the catalog, sample tracks with a confident CrateMind grid, decode each file with ffmpeg and run `detect_with_bands` and `detect_structure`. Then count, over all tracks: the gaps between consecutive anchors in beats modulo 16, 32 and 64; and, for the strongest 15% of beat-to-beat spectral changes inside bass sections, their distance in beats from the last phrase line. The version 4 study, measurements, scripts and listening list are in `.omc/research/structure-v4-2026-11-27/` (`study.md` and `measurements.md` for the first build, `measurements-2.md` for the rule as it is, `listen.md`; in `scripts-2/`, `s2_decode.py` draws and decodes a sample, `cmp.py` runs version 3 and both builds of version 4, `why.py` and `prof.py` print each build-up's numbers and bars, `sens.py` the thresholds at ±20%). The version 3 measurements, their scripts and the listening list are in `.omc/research/structure-v3-2026-11-27/` (`measurements.md`, `listen.md`, `scripts/x_final.py` prints the table). The version 2 measurements and their scripts are in `.omc/research/structure-refine-2026-11-26/` (`measurements.md`, `proposal.md`, `scripts/verify_proposal.py` recomputes the library table from stored rows).
