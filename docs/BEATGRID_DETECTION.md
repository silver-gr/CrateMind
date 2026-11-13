# Beat grid detection

CrateMind builds its own beat grid for each track from the audio: the tempo, where the beats fall, and which beat starts the bar. The code is `backend/app/services/beatgrid_detect.py` (NumPy only). It runs as part of «Ανάλυση BPM», stores its result next to any djay import in `track_beatgrids` (`source = "cratemind"`), and never writes to audio files, tags or djay.

## What it produces

One **steady** grid per track: a BPM, the time of the first downbeat, and a confidence between 0 and 1. A steady grid has the same distance between all beats. It cannot follow a track whose tempo changes or whose timing jumps mid-track; those tracks get a low confidence and their grid is not used.

## Which grid a deck uses

1. djay's grid, when djay imported a *flexible* one for the track (beats at uneven distances). On those tracks it measures better than one steady grid.
2. CrateMind's grid, when its confidence is at least 0.8.
3. djay's steady grid, when there is one.
4. Otherwise no grid: the deck draws its dim estimate from the BPM and the entry cue.

A downbeat marked by hand in the deck still overrides the bar line of whichever grid is used.

## Method

1. **Kick-band envelope.** Spectral flux of the 150–3000 Hz band. A kick is the strongest pulse there. The full band is fooled by off-beat hats and the sub-bass band by bass notes: on ten tracks where the first prototypes disagreed with djay by a quarter or half beat, this band put the beat on the kick in all ten.
2. **Tempo.** The autocorrelation gives a first tempo. It is then pinned by following the autocorrelation peak out to 8, 32, 128, … beats: a lag of N beats fixes the beat length N times finer. A grid at 2/3 or 3/2 of the true tempo hits a kick only every other beat, so those two alternatives are tried and taken only when clearly sharper.
3. **Octave.** The track's resolved tempo decides between half and double time. It never moves the tempo itself.
4. **Beat position.** The envelope is folded at the beat length; the peak of the folded profile is the beat. A fixed 4.5 ms is added because the flux peak leads the start of the transient.
5. **Confidence.** The track is cut into windows of 32 beats. A window whose own strongest pulse sits on the beat counts for the grid; one whose pulse sits somewhere else counts against it. Windows where an off-beat part is louder than the kick (pulse exactly on a sixteenth) and windows without a beat (intro, breakdown) are left out.
6. **Bar line.** Arrangement changes (a part entering or leaving) land on bar starts. The strongest changes in the per-beat band energies vote for which beat, modulo 4, starts the bar.

Limits by design: files under 30 seconds or over 20 minutes get no grid; 4/4 is assumed for the bar line.

## Measured accuracy (2026-11-13)

Measured read-only on a QA copy of a 5,149-track library (mostly psytrance and downtempo), using tracks that also have a djay grid. Two references: djay's grid, and the start of the kick measured directly in the raw audio, which depends on neither grid.

**Hold-out of 500 tracks that were never used while tuning** (400 that djay grids as steady, 100 as flexible):

| Check | Result |
|---|---|
| Tempo equals djay's (steady tracks, ignoring half/double) | 399 of 400 (the miss is a waltz) |
| Beat within 5 ms of djay's | 375 of 399 (94%) |
| Beat within 20 ms of djay's | 394 of 399 (98.7%) |
| Beat within 5 ms of the raw-audio kick, ours | 95% of 393 |
| Beat within 5 ms of the raw-audio kick, djay | 92% of 393 |
| Grid drifts more than 5 ms from start to end, ours / djay | 19 / 24 tracks |
| Confidence at least 0.8 on steady tracks | 98.2% |

**Tracks djay grids as flexible** (100 in the hold-out): CrateMind is confident on 55. The grid stays on the kick through every quarter of the track on 32 of those with ours and 40 with djay's. On the 45 it rejects, djay's stays on the kick on 24. This is why djay's flexible grids are kept.

**Bar line.** It matches 4 of 5 downbeats marked by hand. It agrees with djay on 69% of steady tracks. On tracks whose first beat sits on 0:00, it picks that beat on 92%, where djay does on 69%. There is no larger ground truth for bar lines yet, so treat this as the weakest part.

## Known gaps

- Tracks with tempo changes or timing jumps (roughly 3% of the library): no grid of our own; djay's flexible grid is used when present.
- Music without a clear kick (ambient, some downtempo): the beat can sit a constant 25 ms off, or half a beat off.
- 3/4 time: tempo and bar line are unreliable.
- Bar lines are right about as often as djay's, not reliably better.

## Re-measuring

The scripts read a real library, so they are not in the repository. The method: sample tracks that have a djay grid from a *copy* of the catalog opened read-only, decode each file with ffmpeg, run `detect_grid`, and compare tempo and beat position with djay's grid. For the independent check, band-pass the audio to 150–3000 Hz, average the energy envelope around every grid beat, and take the point where it has risen a quarter of the way to its peak as the kick start.

## Sync

Sync is one press: it matches the deck's tempo to the other deck and then moves its playhead, by at most half a beat, so the beats of both decks fall together. The tempo comes from the stored steady grid when it agrees with the deck's BPM (within 3%, after folding by octaves), so two decks stay together instead of drifting on a rounded tag BPM. The beat step needs both decks playing with a trusted grid; with a loop on the syncing deck, a held pitch bend, or the other deck mid-seek, Sync matches tempo only. It does not keep a lock if the tempo is changed afterwards.
