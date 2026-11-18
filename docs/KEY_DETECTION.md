# Key detection

CrateMind estimates each track's musical key from the audio. The code is `backend/app/services/key_detect.py` (librosa's constant-Q transform, NumPy for the rest). It runs in «Ανάλυση BPM + Key», writes only `tracks.key_analyzed`, its confidence and `key_analyzed_method`, and never writes to audio files, tags or DJ apps.

## Which key a track shows

1. A key tag in the file.
2. djay's key, when djay's analysis was imported (`tracks.key_djay`, kept in step with the djay rows on import, on removal and at start-up).
3. CrateMind's own key.

The order lives in `services/musical_key.py` (`effective_key`) and `frontend/src/lib/camelot.ts` (`fallbackKey`); keep the two in step. The profile editor's tooltip names the source.

djay stores its key as an index from 0 to 23: an even index 2i is the major key on pitch i (0 = C major, 2 = C♯ major …), and the odd index after it is that key's relative minor (1 = A minor, 3 = A♯ minor …). The mapping was measured against Traktor's and Serato's keys for the same 3,551 tracks.

## The method

1. Decode the whole track (up to 20 minutes) to mono at 22,050 Hz. The first analysis pass decodes once and uses the first 120 s of the same audio for the BPM.
2. Constant-Q magnitude, 36 bins per octave from C1 over seven octaves, tuning-corrected by librosa's estimate.
3. Average over 2-second blocks, then log-compress against the track's loudest block: `log(1 + 1000 · C / max C)`.
4. Fold into 12 pitch classes, scale each block so its strongest pitch class is 1, and average the blocks.
5. Correlate with 24 key templates (each profile rotated to every tonic). Minor keys get 0.02 added to their correlation. The best one is the key; the confidence is `(correlation + 1) / 2`.

The templates (`PROFILE_MAJOR`, `PROFILE_MINOR`) are the average folded profile, rotated to the tonic, of 3,377 tracks whose key two or three DJ apps (djay, Traktor, Serato) agree on (93 of them major). They replace the Krumhansl-Schmuckler profiles, which come from classical music.

Changing anything here needs a new `METHOD` string. The analysis's key phase then re-keys every track whose stored method is older, without running BPM or the online providers again.

## How well it works

Measured on 2026-11-18 with the harness in `.omc/research/key-eval` (not in git). Profiles were learned on four fifths of the tracks and scored on the other fifth, split by artist folder, so no artist is on both sides. "Old" is the previous method: Krumhansl-Schmuckler profiles over librosa's chroma of the first 120 s.

Where two DJ apps agree, how often does the third app, and CrateMind, give the same key:

| Reference | Third app | CrateMind old | CrateMind new |
|---|---|---|---|
| djay and Traktor agree (1,726 tracks) | Serato 81.0% | 50.3% | 78.3% |
| djay and Serato agree (1,669) | Traktor 83.8% | 50.8% | 75.6% |
| Traktor and Serato agree (1,542) | djay 90.7% | 50.4% | 80.9% |

On the 1,398 tracks all three apps agree on: old 55.5%, new 84.8%.

**An independent check:** the GiantSteps+ EDM Key Dataset (Zenodo 1095691, CC BY-SA 4.0): 476 two-minute Beatport excerpts with keys annotated by people, from tech house, deep house, progressive, electro house, trance, drum & bass, techno and more; 63 are major. With the profiles learned from the library alone: old 55.0%, new 67.2%; major keys found 39 and 37 of 63. Profiles learned on GiantSteps itself reach about 70% there, so the library's profiles carry over to other electronic music. The dataset is used only to measure; nothing from it is in CrateMind.

**What each change brought** (library, all reference tracks): the whole track instead of the first 120 s +1 to 2 points; log compression of loudness, mainly fewer unrelated keys; learned instead of textbook profiles +12 points (the textbook profiles call a minor track major about one time in five); the minor bias +5 on the library and +1 on GiantSteps.

**Tried and rejected:** leaving out the sub-bass octave (32–65 Hz; it carries the root, accuracy falls by 13–23 points), voting over 30-second windows, weighting blocks by how tonal they look, separate bass and upper profiles, giving the bass more or less weight, and a larger minor bias (above about 0.03 it costs major-key tracks: at 0.08 GiantSteps keeps 30 of 63 majors).

## Limits

- The reference is the DJ apps' agreement, not keys checked by ear. Tracks the apps agree on are the easier ones, so the absolute numbers are optimistic; the comparison between methods on the same tracks is fair. GiantSteps, labelled by people, is the check that does not depend on the apps.
- The library is psytrance and related styles, 97% minor; the major profile is learned from 93 tracks. Music that is mostly in major keys is less well covered (GiantSteps: 37 of 63 majors).
- The remaining errors are mostly major/minor on the same tonic (about 7–9%), unrelated keys (6–8%) and keys a fifth away (5%).
- One key per track: a track that modulates gets the key it spends most time in.
- It takes about 5 seconds per track (whole-track constant-Q transform); a re-key of a 5,000-track library runs for about an hour with eight workers.
