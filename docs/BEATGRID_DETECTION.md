# Beat grid detection

CrateMind builds its own beat grid for each track from the audio: the tempo, where the beats fall, and which beat starts the bar. It follows timing jumps and tempo changes inside a track. The code is `backend/app/services/beatgrid_detect.py` (NumPy only). It runs as part of «Ανάλυση BPM», stores its result next to any djay import in `track_beatgrids` (`source = "cratemind"`), and never writes to audio files, tags or djay.

## What it produces

For most tracks, one **steady** grid: a BPM, the time of the first downbeat, and a confidence between 0 and 1. A steady grid has the same distance between all beats.

For a track whose timing jumps or whose tempo changes mid-track, a **beat list**: a few steady sections one after another, stored as the time of every beat. A track whose tempo glides or wanders has no steady sections; it gets a low confidence and its grid is not used.

## Which grid a deck uses

1. CrateMind's grid, when its confidence is at least 0.8.
2. djay's grid, when one was imported.
3. Otherwise no grid: the deck draws its dim estimate from the BPM and the entry cue.

A grid made before beat lists existed (detector version 1) is one steady grid for every track. Until the next «Ανάλυση BPM» replaces it, a flexible djay grid still goes ahead of it.

A downbeat marked by hand in the deck still overrides the bar line of whichever grid is used.

## The grid tempo as the track's BPM

A confident steady grid also sets the track's BPM everywhere (Library, search, sort, Set Builder, exports, the deck's base tempo). Its tempo is stored in `tracks.bpm_grid`, rounded to two decimals, and comes second in the BPM order, after a manual BPM (`services/tempo.py`).

- **Why:** on 333 hold-out tracks the median of the local analysis and the online providers, which was the shown BPM on 68 of them, was more than 0.3 BPM off on most (145.19 for a 146.0 track), and the local analysis made 4/3 or 3/2 errors on 10 (176 for 132). The grid's tempo equals djay's within 0.05 BPM on all 279 tracks that djay also grids as steady.
- **No blanket rounding:** about 97% of grid tempos are whole numbers already. The rest are real (130.23, 178.51) and rounding them would make loops and Sync drift.
- **Agreement:** the grid replaces the value it agrees with (within 3% after moving by whole octaves, so that value still decides between 92.5 and 185). Where they disagree, a file tag or title hint stays, and the consensus or local analysis gives way.
- **Left out:** beat lists (their tempo has no reliable reference yet), grids below the confidence limit, and tracks analysed with the Therapy estimator.
- **Existing libraries:** grids stored before the column existed are filled in once, when the column is added at start-up.
- **Not affected:** what a deck prints while its pitch is off zero. That is BPM × pitch, to one decimal.

## Method

1. **Kick-band envelope.** Spectral flux of the 150–3000 Hz band. A kick is the strongest pulse there. The full band is fooled by off-beat hats and the sub-bass band by bass notes: on ten tracks where the first prototypes disagreed with djay by a quarter or half beat, this band put the beat on the kick in all ten.
2. **Tempo.** The autocorrelation gives a first tempo. It is then pinned by following the autocorrelation peak out to 8, 32, 128, … beats: a lag of N beats fixes the beat length N times finer. A grid at 2/3 or 3/2 of the true tempo hits a kick only every other beat, so those two alternatives are tried and taken only when clearly sharper.
3. **Octave.** The track's resolved tempo decides between half and double time. It never moves the tempo itself.
4. **Beat position.** The envelope is folded at the beat length; the peak of the folded profile is the beat. A fixed 4.5 ms is added because the flux peak leads the start of the transient.
5. **Confidence.** The track is cut into windows of 32 beats. A window whose own strongest pulse sits on the beat counts for the grid. A window counts against it when its pulse sits somewhere else, or when its beat runs at another tempo (its autocorrelation one bar away peaks elsewhere within ±25% of the tempo). Windows where an off-beat part is louder than the kick (pulse exactly on a sixteenth) and windows without a beat (intro, breakdown) are left out.
6. **Sections.** The longest run of windows that count for the grid is its core. When the core leaves 68 beats or more unexplained before or after it, tempo and beat are measured again on the core alone (another section pulls a whole-track fit towards itself), and the unexplained start and end are fitted the same way, each as its own steady section. A section's tempo is searched within ±25% of the track's main tempo; a section needs three windows on its grid; a track has at most eight.
7. **Merging.** Two neighbouring sections are one grid when they have the same tempo and their beats coincide or sit a whole number of sixteenths apart (the off-beat part again). A section between two sections of one and the same grid, at their tempo, is dropped: time did not move across it. With one section left, the result is the steady grid of steps 1–5.
8. **Beat list.** Otherwise the sections' beats are joined. The switch from one section to the next falls where the envelope stops landing on the first one's beats and starts landing on the second's. The confidence is the same window vote taken along the list.
9. **Bar line.** Arrangement changes (a part entering or leaving) land on bar starts. The strongest changes in the per-beat band energies vote for which beat, modulo 4, starts the bar. On a beat list the count simply continues through a switch.

Limits by design: files under 30 seconds or over 20 minutes get no grid; 4/4 is assumed for the bar line.

## Measured accuracy

Measured read-only on a QA copy of a 5,149-track library (mostly psytrance and downtempo), using tracks that also have a djay grid. Two references: djay's grid, and the start of the kick measured directly in the raw audio, which depends on neither grid.

### The steady grid (2026-11-13)

Hold-out of 500 tracks never used while tuning (400 that djay grids as steady, 100 as flexible):

| Check | Result |
|---|---|
| Tempo equals djay's (steady tracks, ignoring half/double) | 399 of 400 (the miss is a waltz) |
| Beat within 5 ms of djay's | 375 of 399 (94%) |
| Beat within 20 ms of djay's | 394 of 399 (98.7%) |
| Beat within 5 ms of the raw-audio kick, ours / djay | 95% / 92% of 393 |
| Grid drifts more than 5 ms from start to end, ours / djay | 19 / 24 tracks |

On the 100 flexible tracks one steady grid was not enough: it stayed on the kick through the whole track on 32, djay's on 64. That gap is what the sections close.

### Sections (2026-11-14)

A second hold-out of 417 tracks that no earlier measurement had touched (300 djay-steady, 117 djay-flexible). The track is cut into 15-second chunks; a chunk counts when the grid's beats sit within 8 ms of the kick start. Chunks where our grid and djay's sit a sixteenth multiple apart are left out, because this check cannot tell which one is on the kick (0.6% of the chunks on steady tracks, 6% on flexible ones).

| Chunks on the kick | one steady grid | with sections | djay |
|---|---|---|---|
| 300 djay-steady tracks | 97.1% | 97.8% | 96.5% |
| 117 djay-flexible tracks, all | 69.0% | 86.2% | 90.0% |
| the 97 flexible tracks we are confident on | 73.4% | 91.9% | 90.3% |

- **Confident on:** 296 of the 300 steady tracks, and 97 of the 117 flexible ones (61 with one steady grid).
- **What the deck gets** (ours when confident, else djay's): 97.7% of chunks on the kick on the steady tracks and 91.5% on the flexible ones. Serving djay's grid everywhere gives 96.5% and 90.0%.
- **Without any djay import** (not confident = no grid): 96.9% and 80.3%.
- **Known answer.** 135 steady tracks with a change spliced in: a timing jump is followed on 132, a 1% tempo step on 129, a 3% step on 130. One steady grid follows none of them.
- **Time:** about 1.9 seconds per track with eight tracks running at once.

### Bar line

It matches 4 of 5 downbeats marked by hand. It agrees with djay on 69% of steady tracks. On tracks whose first beat sits on 0:00, it picks that beat on 92%, where djay does on 69%. On beat lists it agreed with djay on 4 of 7 comparable tracks. There is no larger ground truth for bar lines yet, so treat this as the weakest part.

## Known gaps

- **A jump of almost exactly a sixteenth multiple** is taken for an off-beat part and not followed (about one real jump in five). On the hold-out's left-out chunks djay's beats sat on the stronger attack about twice as often as ours, which fits either reading: a jump we missed, or djay following the louder off-beat part.
- **A tempo that glides or wanders** (live drums, a preview mix that speeds up): no steady sections. Usually the confidence is low and djay's flexible grid is used when present; a slow glide can still come out as a staircase of sections with a confident grid that is right about two thirds of the time.
- **Sections shorter than 64 beats, or more than 25% away from the main tempo,** stay unexplained and lower the confidence.
- **The bar count continues through a switch,** so after a timing jump the bar line can be off for that section. A downbeat marked by hand fixes one section.
- **A beat list does not follow ×½ / ×2** of the deck's BPM; a steady grid does.
- Music without a clear kick (ambient, some downtempo): the beat can sit a constant 25 ms off, or half a beat off.
- 3/4 time: tempo and bar line are unreliable.
- Bar lines are right about as often as djay's, not reliably better.

## Re-measuring

The scripts read a real library, so they are not in the repository. For tracks with a known answer, cut a stretch of a few beats plus a fraction out of a steady track, or resample its second half, and compare the result with the shifted beats of the original. The method on real tracks: sample tracks that have a djay grid from a *copy* of the catalog opened read-only, decode each file with ffmpeg, run `detect_grid`, and compare tempo and beat position with djay's grid. For the independent check, band-pass the audio to 150–3000 Hz, average the energy envelope around every grid beat, and take the point where it has risen a quarter of the way to its peak as the kick start.

## Sync

Sync is one press: it matches the deck's tempo to the other deck and then moves its playhead, by at most half a beat, so the beats of both decks fall together. The tempo comes from the stored grid when it has one tempo (a steady grid, or a beat list whose sections all run at the same tempo) and it agrees with the deck's BPM (within 3%; a steady grid is first folded by octaves), so two decks stay together instead of drifting on a rounded tag BPM. A beat list with sections at different tempos uses the deck's BPM, and an automated transition keeps one playback rate, so neither follows a tempo change inside a track. The beat step needs both decks playing with a trusted grid; with a loop on the syncing deck, a held pitch bend, or the other deck mid-seek, Sync matches tempo only. It does not keep a lock if the tempo is changed afterwards.
